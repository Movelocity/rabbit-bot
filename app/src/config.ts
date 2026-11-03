/** 配置加载：config/default.json ← config/local.json ← $RABBIT_BOT_CONFIG（后者覆盖前者）。密钥只从环境变量读取。 */
import fs from "node:fs";
import type { GateConfig } from "./core/gate.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface EmojiTarget {
  /** 飞书表情包 file_key（发 sticker 消息） */
  sticker?: string;
  /** 或者替换成一段文字（如 unicode emoji） */
  text?: string;
}

export interface Config {
  timezone: string;
  dataDir: string;
  logDir: string;
  scheduler: { tickMs: number; activeTickMs: number; activeWindowMs: number; debounceMs: number; debounceMaxWaitMs: number; watchdogMs: number; overdueGraceMs: number; batchToTick?: boolean };
  send: {
    confirmWaitMs: number; confirmViaApi: boolean;
    /** 分条投递的间隔（按上一条长度缩放，见 core/pacing.ts）。关掉=所有句子立刻连发 */
    pacing: { enabled: boolean };
    /** 单条消息字数上限，超了只提醒不拦。默认 160 */
    maxChars?: number;
  };
  context: { recentContextMessages: number; maxUnreadPerPool: number; maxMemoriesPerUser: number };
  handoff: { contextTokenLimit: number; sessionTokenLimit: number };
  loopGuard: { impl: "pi-death-loop-guard" | "builtin"; warnThreshold: number; blockThreshold: number; abortAfterBlocks: number };
  limits: {
    dailyLlmCalls: number; dailyTokens: number; turnTimeoutMs: number;
    /** 缓存命中的 token 按多少折算进日额度（DeepSeek 前缀缓存 = 0.1 价） */
    cacheReadRate: number;
    /** 额度用尽时给用户发一条提示：不走模型、不进上下文，只为不让对方以为被无视 */
    capNotice?: { enabled: boolean; text: string; oncePerDay: boolean };
    /** 程序自己出的错（模型报错、异常崩了）：直接发 IM，不过模型、不进上下文 */
    errorNotice?: { enabled: boolean; text: string; dedupeMinutes: number };
  };
  plans: { missedPolicy: "catchup" | "skip"; missedGraceMs: number };
  tide: {
    enabled: boolean;
    dailyCap: { L1: number; L2: number };
  };
  /**
   * 主动开口：自省（模型自己判断有多想说）+ 六道门。
   * 取代旧的 tide.wave / tide.energy——那两套都是拿代码拍概率，跟「她想不想说」无关。
   */
  proactive: { enabled: boolean } & Partial<GateConfig> & {
    /** 用户最后一条消息之后多久开始自省 */
    reflectionDelayMs?: number;
  };
  llm: { provider: string; model: string; thinkingLevel: "off" | "minimal" | "low" | "medium" | "high"; maxRetries: number };
  adapters: { feishu: { enabled: boolean; domain: "feishu" | "lark"; fetchSenderName: boolean; reactions: boolean; logRawEmoji: boolean } };
  emoji: { table: string | null; map: Record<string, EmojiTarget> };
  media: { maxEdge: number; maxBytes: number; maxImagesInContext: number };
  sandbox: {
    dir: string;
    maxFileBytes: number;
    maxFiles: number;
    maxReadChars: number;
    shell: {
      enabled: boolean;
      /** docker = 隔离容器（默认）；host = 直接跑在宿主机上，无隔离，仅本地开发用 */
      mode: "docker" | "host";
      container: string;
      image: string;
      network: "bridge" | "none";
      timeoutMs: number;
      maxOutputChars: number;
      volumes: Array<{ host: string; container: string; mode?: "ro" | "rw" }>;
      /** 额外注入容器/宿主 shell 的环境变量（自动带 RB_API_URL / RB_API_TOKEN） */
      env?: Record<string, string>;
      /** 仅 mode=host 生效 */
      host?: { cwd?: string; inheritEnv?: boolean };
    };
  };
  /** 本地 REST API：沙盒里的技能脚本通过它访问池/计划/记忆/沙盒文件 */
  api?: { enabled: boolean; port: number; host: string };
  inject?: { port: number };
  agent: { name: string; persona: string };
}

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type Obj = Record<string, unknown>;
function isObj(v: unknown): v is Obj {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
export function deepMerge<T>(base: T, over: unknown): T {
  if (!isObj(base) || !isObj(over)) return (over === undefined ? base : (over as T));
  const out: Obj = { ...(base as Obj) };
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v;
  return out as T;
}

function readJson(p: string): unknown {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

export function loadConfig(overrides?: unknown): Config {
  let cfg = readJson(path.join(APP_ROOT, "config/default.json")) as Config;
  const local = path.join(APP_ROOT, "config/local.json");
  if (fs.existsSync(local)) cfg = deepMerge(cfg, readJson(local));
  const extra = process.env.RABBIT_BOT_CONFIG;
  if (extra) cfg = deepMerge(cfg, readJson(path.resolve(extra)));
  if (overrides) cfg = deepMerge(cfg, overrides);
  cfg.dataDir = path.resolve(APP_ROOT, cfg.dataDir);
  cfg.logDir = path.resolve(APP_ROOT, cfg.logDir);
  cfg.sandbox.dir = path.resolve(APP_ROOT, cfg.sandbox.dir);
  // volumes 里的 host 是相对 APP_ROOT 的路径（和 sandbox.dir 一样）
  cfg.sandbox.shell.volumes = (cfg.sandbox.shell.volumes ?? []).map((v) => ({
    ...v,
    host: path.resolve(APP_ROOT, v.host),
  }));
  // host 模式的 cwd 不填就落到沙盒目录（和 docker 模式的 /work 指向同一个地方）
  if (cfg.sandbox.shell.host?.cwd) cfg.sandbox.shell.host.cwd = path.resolve(APP_ROOT, cfg.sandbox.shell.host.cwd);
  else cfg.sandbox.shell.host = { ...cfg.sandbox.shell.host, cwd: cfg.sandbox.dir };
  if (cfg.emoji.table) cfg.emoji.table = path.resolve(APP_ROOT, cfg.emoji.table);
  validateConfig(cfg);
  return cfg;
}

export function validateConfig(cfg: Config): void {
  const pos = (n: number, name: string) => {
    if (!(typeof n === "number" && n > 0)) throw new Error(`config: ${name} 必须是正数`);
  };
  pos(cfg.scheduler.tickMs, "scheduler.tickMs");
  pos(cfg.scheduler.debounceMs, "scheduler.debounceMs");
  // 缓存折算汇率：0~1 之间（1 = 不打折）
  const rate = cfg.limits.cacheReadRate;
  if (typeof rate !== "number" || !(rate >= 0 && rate <= 1)) {
    throw new Error("config: limits.cacheReadRate 必须是 0~1 之间的数");
  }
  pos(cfg.sandbox.maxFileBytes, "sandbox.maxFileBytes");
  pos(cfg.sandbox.maxFiles, "sandbox.maxFiles");
  const mode = cfg.sandbox.shell.mode;
  if (mode !== "docker" && mode !== "host") throw new Error('config: sandbox.shell.mode 只能是 "docker" 或 "host"');
  if (cfg.sandbox.shell.enabled) pos(cfg.sandbox.shell.timeoutMs, "sandbox.shell.timeoutMs");
  if (cfg.api?.enabled) {
    const p = cfg.api.port;
    if (!Number.isInteger(p) || p < 0 || p > 65535) throw new Error("config: api.port 必须是 0~65535 的整数（0 = 随机端口）");
    if (!cfg.api.host) throw new Error("config: api.host 不能为空（默认 0.0.0.0）");
  }
  pos(cfg.loopGuard.blockThreshold, "loopGuard.blockThreshold");
  if (cfg.tide?.enabled) {
    const { L1, L2 } = cfg.tide.dailyCap;
    if (!(Number.isInteger(L1) && L1 >= 0)) throw new Error("config: tide.dailyCap.L1 必须是 >=0 的整数");
    if (!(Number.isInteger(L2) && L2 >= 0)) throw new Error("config: tide.dailyCap.L2 必须是 >=0 的整数");
  }
  // 主动开口：门控参数定标。定错了不是不开口就是话痨，两头都难看
  const pr = cfg.proactive;
  if (pr?.enabled) {
    const thr = pr.urgencyThreshold;
    if (thr !== undefined && !(thr > 0 && thr < 1)) throw new Error("config: proactive.urgencyThreshold 必须在 (0,1) 开区间");
    for (const k of ["minSilentMs", "minIntervalMs", "reflectionDelayMs"] as const) {
      const v = pr[k];
      if (v !== undefined && !(Number.isFinite(v) && v >= 0)) throw new Error(`config: proactive.${k} 必须是非负数`);
    }
    if (pr.maxPerDay !== undefined && !(Number.isInteger(pr.maxPerDay) && pr.maxPerDay > 0)) {
      throw new Error("config: proactive.maxPerDay 必须是正数（0 次等于关掉，请用 enabled=false）");
    }
    if (pr.maxConsecutive !== undefined && !(Number.isInteger(pr.maxConsecutive) && pr.maxConsecutive > 0)) {
      throw new Error("config: proactive.maxConsecutive 必须是正整数");
    }
  }
  if (cfg.loopGuard.warnThreshold >= cfg.loopGuard.blockThreshold)
    throw new Error("config: loopGuard.warnThreshold 必须小于 blockThreshold");
  if (cfg.timezone !== "Asia/Shanghai") console.warn(`[config] timezone=${cfg.timezone}（需求要求 Asia/Shanghai）`);
}

/** 只读取、不打印密钥。返回缺失的环境变量名。 */
export function missingEnv(names: string[]): string[] {
  return names.filter((n) => !process.env[n]);
}
