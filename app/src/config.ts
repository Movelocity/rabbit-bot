/** 配置加载：config/default.json ← config/local.json ← $RABBIT_BOT_CONFIG（后者覆盖前者）。密钥只从环境变量读取。 */
import fs from "node:fs";
import type { GateConfig } from "./core/gate.ts";
import os from "node:os";
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
  /**
   * 运行时内容根目录：人设、提示词、话题库都放这儿（默认 ~/.config/rabbit-bot/runtime）。
   * 仓库里只有代码和示例——这类内容会变、而且常常是私人内容，不该跟着代码推到 GitHub。
   */
  runtimeDir: string;
  dataDir: string;
  logDir: string;
  scheduler: { tickMs: number; taskTickMs: number; privateWakeMs: number; activeTickMs: number; activeWindowMs: number; debounceMs: number; debounceMaxWaitMs: number; watchdogMs: number; overdueGraceMs: number; batchToTick?: boolean };
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
    /** 一天最多调用几次；负数 = 不设这条闸，只按钱（dailyCny）限额 */
    dailyLlmCalls: number;
    /** 折算 token 日额度；负数 = 不设这条闸，只按钱（dailyCny）限额 */
    dailyTokens: number;
    turnTimeoutMs: number;
    /** 缓存命中的 token 按多少折算进日额度（DeepSeek 前缀缓存 = 0.1 价） */
    cacheReadRate: number;
    /** 一天最多花多少钱（人民币）。0 = 不算钱，只看 token / 调用次数 */
    dailyCny?: number;
    /** 美元 → 人民币汇率，只用于记账 */
    usdCny?: number;
    /** 额外按谷时计价的日子（YYYY-MM-DD，中国法定节假日）；周末已自动按谷时 */
    offPeakHolidays?: string[];
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
    /** 群聊池的额外收紧：群里主动开口要更克制，覆盖上面的同名字段 */
    group?: Partial<GateConfig>;
  };
  llm: { provider: string; model: string; thinkingLevel: "off" | "minimal" | "low" | "medium" | "high"; maxRetries: number };
  adapters: {
    feishu: { enabled: boolean; domain: "feishu" | "lark"; fetchSenderName: boolean; reactions: boolean; logRawEmoji: boolean };
    /** 自建 Matrix（Continuwuity）。token 走环境变量 MATRIX_TOKEN，不进配置文件 */
    matrix: {
      enabled: boolean;
      homeserver: string;
      userId: string;
      /** 主人自己的 mxid：群聊里他说的话不 @ 也要回（见 core/owners.ts） */
      ownerIds?: string[];
    };
  };
  emoji: { table: string | null; map: Record<string, EmojiTarget> };
  media: { maxEdge: number; maxBytes: number; maxImagesInContext: number };
  exec: {
    dir: string;
    /** 外部只读技能库（宿主机路径或 ~）：作为 shared-skills/ 暴露给 read_file */
    sharedSkillsDir?: string;
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
      /** UFA 的 terminal 硬上限；超过就失败，逼长活写任务交给 WA */
      ufaMaxTimeoutMs: number;
      maxOutputChars: number;
      /** 免审命令名单：只放「一个命令只做一件事、碰不到本地文件」的工具 */
      safeProgs?: string[];
      volumes: Array<{ host: string; container: string; mode?: "ro" | "rw" }>;
      /** 额外注入容器/宿主 shell 的环境变量（自动带 RB_API_URL / RB_API_TOKEN） */
      env?: Record<string, string>;
      /** 仅 mode=host 生效 */
      host?: { cwd?: string; inheritEnv?: boolean };
    };
  };
  /**
   * 宿主机命令的审批闸门（只在 exec.shell.mode === "host" 时生效）。
   * 发到配置的审批聊天等主人一句话（独立审批房或私聊都行）；超时按拒绝，
   * 只有审批提示和裁决不进她的会话上下文，同一聊天里的正常消息照常入池。
   */
  approval: {
    enabled: boolean;
    /** matrix / feishu */
    platform: string;
    /** 审批聊天的 external chat id（不是池 id） */
    roomId: string;
    /** 谁能批；空 = 谁都批不了（等于关） */
    ownerIds: string[];
    /** 超时毫秒，超时即拒绝 */
    timeoutMs: number;
    /** 裁决后和执行完各回一句状态到审批聊天 */
    notify?: boolean;
  };
  /**
   * 任务发布审批：UFA 建的任务先发审批提示，主人贴 OK / No 表情裁决。
   * target=origin 发到任务发起的聊天，target=room 发到固定审批房；关掉时回退 Web 任务页。
   */
  taskApproval: {
    enabled: boolean;
    /**
     * 审批提示发到哪：
     *   origin = 任务发起时的聊天（默认推荐，不另开审批房）
     *   room   = 固定审批房（roomId）
     */
    target?: "origin" | "room";
    /** matrix / feishu */
    platform: string;
    /** 固定审批房的 external chat id（target=room 时必填；origin 时作为兜底） */
    roomId: string;
    /** 谁能批；空 = 谁都批不了（等于关） */
    ownerIds: string[];
    /** 超时毫秒，超时即拒绝（默认 24h，避免睡觉时任务被判死） */
    timeoutMs: number;
    /** 裁决后回一句状态到原聊天/审批房 */
    notify?: boolean;
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

function expandHome(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

/** `~` 展开成家目录，绝对路径原样，相对路径按仓库根解析。 */
function resolvePath(p: string): string {
  if (p.startsWith("~") || path.isAbsolute(p)) return path.resolve(expandHome(p));
  return path.resolve(APP_ROOT, p);
}

/**
 * 老配置里这一段叫 `sandbox`，现在叫 `exec`（同一段，管「命令怎么跑」：容器 / 宿主机）。
 *
 * 必须在拿到每一层原始 JSON 时就搬，不能等 deepMerge 之后：
 * 默认配置里已经有 `exec`，合并完再看 `sandbox` 就分不清「用户写的是旧键」还是
 * 「默认值来自新键」——旧键会被静默忽略，`mode` 掉回默认的 `docker`，
 * 于是她的 terminal 突然碰不到真实文件了，而且一句报错都没有。
 *
 * 所以这里每层单独搬 + 留一行 warn，两键并存时以 exec 为准。
 */
export function migrateLegacyKeys(raw: unknown, where: string): void {
  if (!isObj(raw) || !("sandbox" in raw)) return;
  if ("exec" in raw) {
    console.warn(`config: ${where} 里 sandbox 和 exec 同时存在，用 exec，忽略 sandbox`);
  } else {
    raw.exec = raw.sandbox;
    console.warn(`config: ${where} 里的 sandbox 段已改名为 exec，已自动搬运（建议手工改掉）`);
  }
  delete raw.sandbox;
}

export function loadConfig(overrides?: unknown): Config {
  const base = readJson(path.join(APP_ROOT, "config/default.json"));
  migrateLegacyKeys(base, "config/default.json");
  let cfg = base as Config;
  const local = path.join(APP_ROOT, "config/local.json");
  if (fs.existsSync(local)) {
    const l = readJson(local);
    migrateLegacyKeys(l, "config/local.json");
    cfg = deepMerge(cfg, l);
  }
  const extra = process.env.RABBIT_BOT_CONFIG;
  if (extra) {
    const e = readJson(path.resolve(extra));
    migrateLegacyKeys(e, `$RABBIT_BOT_CONFIG(${extra})`);
    cfg = deepMerge(cfg, e);
  }
  if (overrides) {
    migrateLegacyKeys(overrides, "overrides");
    cfg = deepMerge(cfg, overrides);
  }
  cfg.runtimeDir = path.resolve(expandHome(process.env.RABBIT_BOT_RUNTIME || cfg.runtimeDir));
  cfg.dataDir = path.resolve(APP_ROOT, cfg.dataDir);
  cfg.logDir = path.resolve(APP_ROOT, cfg.logDir);
  // 沙盒根默认就是运行时目录：和 ~/.config/rabbit-bot/runtime 是同一个地方，
  // 宿主侧看到她写的东西，容器里就是 /work。exec.dir 留空 = 跟随 runtimeDir。
  cfg.exec.dir = String(cfg.exec.dir ?? "").trim() ? resolvePath(String(cfg.exec.dir)) : cfg.runtimeDir;
  // volumes 里的 host 留空 = 用 exec.dir；相对路径按 APP_ROOT 解析（和 exec.dir 一样）
  cfg.exec.shell.volumes = (cfg.exec.shell.volumes ?? []).map((v) => ({
    ...v,
    host: String(v.host ?? "").trim() ? resolvePath(v.host) : cfg.exec.dir,
  }));
  // host 模式的 cwd 不填就落到沙盒目录（和 docker 模式的 /work 指向同一个地方）
  if (cfg.exec.shell.host?.cwd) cfg.exec.shell.host.cwd = resolvePath(cfg.exec.shell.host.cwd);
  else cfg.exec.shell.host = { ...cfg.exec.shell.host, cwd: cfg.exec.dir };
  if (cfg.emoji.table) cfg.emoji.table = path.resolve(APP_ROOT, cfg.emoji.table);
  validateConfig(cfg);
  return cfg;
}

export function validateConfig(cfg: Config): void {
  const pos = (n: number, name: string) => {
    if (!(typeof n === "number" && n > 0)) throw new Error(`config: ${name} 必须是正数`);
  };
  pos(cfg.scheduler.tickMs, "scheduler.tickMs");
  pos(cfg.scheduler.taskTickMs, "scheduler.taskTickMs");
  pos(cfg.scheduler.privateWakeMs, "scheduler.privateWakeMs");
  pos(cfg.scheduler.debounceMs, "scheduler.debounceMs");
  // 缓存折算汇率：0~1 之间（1 = 不打折）
  const rate = cfg.limits.cacheReadRate;
  if (typeof rate !== "number" || !(rate >= 0 && rate <= 1)) {
    throw new Error("config: limits.cacheReadRate 必须是 0~1 之间的数");
  }
  const cny = cfg.limits.dailyCny;
  if (cny !== undefined && !(Number.isFinite(cny) && cny >= 0)) throw new Error("config: limits.dailyCny 必须是 >=0 的数（0 = 不按钱限额）");
  const fx = cfg.limits.usdCny;
  if (fx !== undefined && !(Number.isFinite(fx) && fx > 0)) throw new Error("config: limits.usdCny 必须是正数");
  pos(cfg.exec.maxFileBytes, "exec.maxFileBytes");
  pos(cfg.exec.maxFiles, "exec.maxFiles");
  const mode = cfg.exec.shell.mode;
  if (mode !== "docker" && mode !== "host") throw new Error('config: exec.shell.mode 只能是 "docker" 或 "host"');
  if (cfg.exec.shell.enabled) {
    pos(cfg.exec.shell.timeoutMs, "exec.shell.timeoutMs");
    pos(cfg.exec.shell.ufaMaxTimeoutMs, "exec.shell.ufaMaxTimeoutMs");
    if (cfg.exec.shell.ufaMaxTimeoutMs > 600_000) {
      throw new Error("config: exec.shell.ufaMaxTimeoutMs 不能超过 600000");
    }
  }
  if (cfg.api?.enabled) {
    const p = cfg.api.port;
    if (!Number.isInteger(p) || p < 0 || p > 65535) throw new Error("config: api.port 必须是 0~65535 的整数（0 = 随机端口）");
    if (!cfg.api.host) throw new Error("config: api.host 不能为空（默认 0.0.0.0）");
  }
  if (cfg.taskApproval?.enabled) {
    pos(cfg.taskApproval.timeoutMs, "taskApproval.timeoutMs");
    const target = cfg.taskApproval.target ?? "origin";
    if (target !== "origin" && target !== "room") {
      throw new Error('config: taskApproval.target 只能是 "origin" 或 "room"');
    }
    if (target === "room" && !String(cfg.taskApproval.roomId ?? "").trim()) {
      throw new Error("config: taskApproval.roomId 不能为空（target=room 时）");
    }
    if (!(cfg.taskApproval.ownerIds ?? []).length) {
      throw new Error("config: taskApproval.ownerIds 不能为空（taskApproval.enabled=true 时）");
    }
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
