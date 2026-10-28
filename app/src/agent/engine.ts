/**
 * pi 引擎封装：一个长期 pi 会话 + 自定义工具；关闭自动压缩；
 * 达到上下文 token 上限时：让 Agent 写交接文档 → 存档 → 新建会话并带上交接文档继续。
 */
import fs from "node:fs";
import path from "node:path";
import {
  createAgentSession, createCodemodeExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type { Config } from "../config.ts";
import type { Store } from "../core/db.ts";
import type { Logger } from "../core/logger.ts";
import { applyCommunityLoopGuardEnv, builtinLoopGuardExtension, callKey, communityLoopGuardPath } from "../core/loopguard.ts";
import { handoffPrompt } from "./prompt.ts";

export interface ToolLog { name: string; args: unknown; result: string; isError: boolean }
export interface RunResult {
  assistantText: string;
  toolCalls: ToolLog[];
  llmCalls: number;
  /** 计入日额度的那种（缓存读按汇率折算过） */
  tokens: number;
  /** 没折算的原始 token，只用于观测 */
  rawTokens?: number;
  /** 上游报的美元成本（pi 按模型定价算好的） */
  cost?: number;
  aborted: boolean;
  abortReason?: string;
  error?: string;
  handoffId?: number;
  contextTokens?: number | null;
}

export interface RunLimits {
  tokensLeft: number;
  callsLeft: number;
  /** 这个 session 已经聊够了（累计 token 到顶）：这轮说完就交接，换个新会话 */
  forceHandoff?: boolean;
}

/** 与 pi-ai 的 ImageContent 结构一致（不直接依赖内部类型路径）。 */
export interface ImagePart { type: "image"; data: string; mimeType: string }

/** 抽象：便于测试替换 */
export interface AgentEngine {
  /** 本会话里已经给过上下文的池（新会话时清空） */
  readonly seenPools: Set<string>;
  /** 新会话首轮需要带上的交接文档 */
  takePendingHandoff(): string | null;
  run(prompt: string, limits: RunLimits, images?: ImagePart[]): Promise<RunResult>;
  dispose(): Promise<void>;
}

export interface PiEngineDeps {
  cfg: Config;
  store: Store;
  log: Logger;
  tools: ToolDefinition[];
  systemPrompt: string;
  model: Model<any>;
  modelRuntime: ModelRuntime;
  /** 测试时用内存会话 */
  inMemorySessions?: boolean;
}

const preview = (r: any): string => {
  const t = (r?.content ?? []).map((c: any) => (c.type === "text" ? c.text : `[${c.type}]`)).join("");
  return t.length > 300 ? t.slice(0, 300) + "…" : t;
};

export class PiEngine implements AgentEngine {
  readonly seenPools = new Set<string>();
  private session: AgentSession | null = null;
  private pendingHandoff: string | null = null;
  private loopGuardImpl: "pi-death-loop-guard" | "builtin" = "builtin";
  private readonly piDir: string;
  private readonly cwd: string;
  private readonly sessionDir: string;
  // 每次进程启动都新开会话：prompt/工具改动立刻生效，上下文唯一来源是 pool。
  // （continueRecent 会把上一个进程的 system prompt 一起带回来，改提示词等于白改。）
  private freshNext = true;

  constructor(private d: PiEngineDeps) {
    this.piDir = path.join(d.cfg.dataDir, "pi-agent");
    this.cwd = path.join(d.cfg.dataDir, "pi-cwd");
    this.sessionDir = path.join(d.cfg.dataDir, "sessions");
    for (const p of [this.piDir, this.cwd, this.sessionDir, path.join(d.cfg.dataDir, "handoffs")]) fs.mkdirSync(p, { recursive: true });
  }

  get loopGuard() { return this.loopGuardImpl; }

  takePendingHandoff() { const h = this.pendingHandoff; this.pendingHandoff = null; return h; }

  private async buildLoader(settingsManager: SettingsManager, useCommunity: boolean) {
    const lg = this.d.cfg.loopGuard;
    const communityPath = useCommunity ? communityLoopGuardPath() : null;
    if (communityPath) applyCommunityLoopGuardEnv(lg);
    const loader = new DefaultResourceLoader({
      cwd: this.cwd, agentDir: this.piDir, settingsManager,
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: this.d.systemPrompt,
      additionalExtensionPaths: communityPath ? [communityPath] : [],
      // codemode：模型写的 JS 跑在 QuickJS(WASM) 里，唯一能力是调用这些工具。
      // SDK 不会自动加载内置扩展，必须自己注册；不注册的话 tools 里写 codemode 只是个空名字。
      extensionFactories: [
        ...(communityPath ? [] : [{ name: "rabbit-bot-loop-guard", factory: builtinLoopGuardExtension(lg, (e) => this.d.log.warn(e)) as any }]),
        { name: "codemode", factory: createCodemodeExtension() },
      ],
    });
    await loader.reload();
    return { loader, community: !!communityPath };
  }

  private async ensureSession(): Promise<AgentSession> {
    if (this.session) return this.session;
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false }, // 需求 §9：关闭 pi 自带的自动压缩
      retry: { enabled: true, maxRetries: this.d.cfg.llm.maxRetries },
    } as any);
    let { loader, community } = await this.buildLoader(settingsManager, this.d.cfg.loopGuard.impl === "pi-death-loop-guard");
    if (community && loader.getExtensions().errors.length) {
      this.d.log.warn(`pi-death-loop-guard 加载失败，回退到内置实现：${JSON.stringify(loader.getExtensions().errors).slice(0, 300)}`);
      ({ loader, community } = await this.buildLoader(settingsManager, false));
    }
    this.loopGuardImpl = community ? "pi-death-loop-guard" : "builtin";

    const sessionManager = this.d.inMemorySessions
      ? SessionManager.inMemory(this.cwd)
      : this.freshNext ? SessionManager.create(this.cwd, this.sessionDir) : SessionManager.continueRecent(this.cwd, this.sessionDir);
    this.freshNext = false;
    const { session } = await createAgentSession({
      cwd: this.cwd, agentDir: this.piDir, model: this.d.model, thinkingLevel: this.d.cfg.llm.thinkingLevel,
      modelRuntime: this.d.modelRuntime, resourceLoader: loader, settingsManager, sessionManager,
      noTools: "builtin", tools: [...this.d.tools.map((t) => t.name), "codemode"], customTools: this.d.tools,
    });
    this.session = session;
    this.d.log.info(`pi 会话就绪 model=${this.d.model.provider}/${this.d.model.id} loopGuard=${this.loopGuardImpl} tools=${session.getActiveToolNames().join(",")}`);
    return session;
  }

  async run(prompt: string, limits: RunLimits, images?: ImagePart[]): Promise<RunResult> {
    const s = await this.ensureSession();
    const res = await this.runPrompt(s, prompt, limits, images);
    // 两条交接理由：
    // 1) 上下文快满了（单轮就会报错，得马上换）
    // 2) 这个 session 累计烧够了（还没满，但再聊下去每轮都变贵，主动换新）
    const ctxTokens = s.getContextUsage()?.tokens ?? null;
    res.contextTokens = ctxTokens;
    const tooLong = !!limits.forceHandoff;
    if (!res.error && (tooLong || (ctxTokens !== null && ctxTokens >= this.d.cfg.handoff.contextTokenLimit))) {
      if (tooLong) this.d.log.info(`这个 session 累计已聊够，主动换新会话（上下文 ${ctxTokens ?? "?"} tokens）`);
      const h = await this.handoff(s, ctxTokens ?? 0, { tokensLeft: limits.tokensLeft - res.tokens, callsLeft: limits.callsLeft - res.llmCalls });
      res.tokens += h.tokens; res.llmCalls += h.llmCalls; res.handoffId = h.id ?? undefined;
    }
    return res;
  }

  private async runPrompt(s: AgentSession, prompt: string, limits: RunLimits, images?: ImagePart[]): Promise<RunResult> {
    const out: RunResult = { assistantText: "", toolCalls: [], llmCalls: 0, tokens: 0, rawTokens: 0, cost: 0, aborted: false };
    const pendingArgs = new Map<string, unknown>();
    const abort = (why: string) => { if (!out.aborted) { out.aborted = true; out.abortReason = why; void s.abort(); } };
    const unsub = s.subscribe((ev: any) => {
      if (ev.type === "tool_execution_start") pendingArgs.set(ev.toolCallId, ev.args);
      else if (ev.type === "tool_execution_end") {
        const r = preview(ev.result);
        out.toolCalls.push({ name: ev.toolName, args: pendingArgs.get(ev.toolCallId), result: r, isError: ev.isError });
      } else if (ev.type === "message_end" && ev.message?.role === "assistant") {
        out.llmCalls++;
        const u = ev.message.usage;
        if (u) {
          // 缓存读按 1/10 记：DeepSeek 的前缀缓存命中就是这个价，pi 已经在报 cacheRead 了。
          // 之前把 cacheRead 全额算进日额度，等于「几乎免费的重读」也按全价扣，
          // 一天 200 万的表看着满了，实际花的钱可能只有十分之一。
          // 原始 token 仍然记在 rawTokens 里，观测口径不变，变的是记账口径。
          out.rawTokens += u.totalTokens ?? ((u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0));
          out.tokens += (u.input ?? 0) + (u.output ?? 0)
            + Math.round((u.cacheRead ?? 0) * this.d.cfg.limits.cacheReadRate)
            + (u.cacheWrite ?? 0);
          out.cost += u.cost?.total ?? 0;
        }
        if (out.tokens >= limits.tokensLeft) abort("daily-token-cap");
        else if (out.llmCalls >= limits.callsLeft) abort("daily-call-cap");
      }
    });
    const timer = setTimeout(() => abort("turn-timeout"), this.d.cfg.limits.turnTimeoutMs);
    try {
      await s.prompt(prompt, images?.length ? { images } : undefined);
    } catch (e) {
      out.error = (e as Error).message;
    } finally {
      clearTimeout(timer);
      unsub();
    }
    const last: any = s.messages[s.messages.length - 1];
    if (last?.role === "assistant" && last.stopReason === "error") out.error ??= last.errorMessage ?? "LLM 错误";
    const lastTool = out.toolCalls[out.toolCalls.length - 1];
    const n = this.d.cfg.loopGuard.blockThreshold;
    const tail = out.toolCalls.slice(-n);
    const guardHit = !!lastTool?.isError && (lastTool.result.includes("loop-guard") ||
      (tail.length === n && tail.every((c) => callKey(c.name, c.args) === callKey(lastTool.name, lastTool.args))));
    // 中止（防死循环 / 超时 / 上限）不是 LLM 故障
    if (out.aborted || guardHit || last?.stopReason === "aborted" || (out.error && /abort/i.test(out.error))) {
      out.aborted = true;
      out.abortReason ??= guardHit ? "loop-guard" : "aborted";
      if (out.error && /abort/i.test(out.error)) out.error = undefined;
    }
    out.assistantText = s.getLastAssistantText() ?? "";
    return out;
  }

  private async handoff(s: AgentSession, ctxTokens: number, limits: RunLimits): Promise<{ id: number | null; tokens: number; llmCalls: number }> {
    this.d.log.info(`上下文 ${ctxTokens} tokens ≥ ${this.d.cfg.handoff.contextTokenLimit}，开始交接`);
    s.setActiveToolsByName([]);
    const r = await this.runPrompt(s, handoffPrompt(), { tokensLeft: Math.max(limits.tokensLeft, 1), callsLeft: Math.max(limits.callsLeft, 1) });
    const content = r.assistantText.trim();
    let id: number | null = null;
    if (content) {
      const file = path.join(this.d.cfg.dataDir, "handoffs", `handoff-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
      fs.writeFileSync(file, content + "\n");
      id = this.d.store.addHandoff(content, ctxTokens, file);
      this.pendingHandoff = content;
      this.d.log.info(`交接文档 #${id} 已存档：${file}`);
    } else {
      this.d.log.warn(`交接文档为空（${r.error ?? r.abortReason ?? "未知"}），仍然新开会话`);
      this.pendingHandoff = this.d.store.latestHandoff()?.content ?? null;
    }
    s.dispose();
    this.session = null;
    this.freshNext = true;
    this.seenPools.clear();
    return { id, tokens: r.tokens, llmCalls: r.llmCalls };
  }

  async dispose() { this.session?.dispose(); this.session = null; }
}

/** 解析模型：真实 provider 需对应环境变量里的 API key（pi 自己读取）。 */
export async function resolveModel(cfg: Config): Promise<{ model: Model<any>; modelRuntime: ModelRuntime }> {
  const piDir = path.join(cfg.dataDir, "pi-agent");
  fs.mkdirSync(piDir, { recursive: true });
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(piDir, "auth.json"), modelsPath: path.join(piDir, "models.json") });
  const model = modelRuntime.getModel(cfg.llm.provider, cfg.llm.model);
  if (!model) throw new Error(`pi 中找不到模型 ${cfg.llm.provider}/${cfg.llm.model}（可运行 npm run ctl -- models 查看）`);
  const available = await modelRuntime.getAvailable(cfg.llm.provider);
  if (!available.some((m) => m.id === model.id)) throw new Error(`模型 ${cfg.llm.provider}/${cfg.llm.model} 没有可用凭据：请设置该 provider 的 API key 环境变量`);
  return { model, modelRuntime };
}
