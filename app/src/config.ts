/** 配置加载：config/default.json ← config/local.json ← $POOLCHAT_CONFIG（后者覆盖前者）。密钥只从环境变量读取。 */
import fs from "node:fs";
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
  scheduler: { tickMs: number; activeTickMs: number; activeWindowMs: number; debounceMs: number; debounceMaxWaitMs: number };
  send: { confirmWaitMs: number; confirmViaApi: boolean };
  context: { recentContextMessages: number; maxUnreadPerPool: number; maxMemoriesPerUser: number };
  handoff: { contextTokenLimit: number };
  loopGuard: { impl: "pi-death-loop-guard" | "builtin"; warnThreshold: number; blockThreshold: number; abortAfterBlocks: number };
  limits: { dailyLlmCalls: number; dailyTokens: number; turnTimeoutMs: number };
  plans: { missedPolicy: "catchup" | "skip"; missedGraceMs: number };
  llm: { provider: string; model: string; thinkingLevel: "off" | "minimal" | "low" | "medium" | "high"; maxRetries: number };
  adapters: { feishu: { enabled: boolean; domain: "feishu" | "lark"; fetchSenderName: boolean }; qq: { enabled: boolean } };
  emoji: { map: Record<string, EmojiTarget> };
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
  const extra = process.env.POOLCHAT_CONFIG;
  if (extra) cfg = deepMerge(cfg, readJson(path.resolve(extra)));
  if (overrides) cfg = deepMerge(cfg, overrides);
  cfg.dataDir = path.resolve(APP_ROOT, cfg.dataDir);
  cfg.logDir = path.resolve(APP_ROOT, cfg.logDir);
  validateConfig(cfg);
  return cfg;
}

export function validateConfig(cfg: Config): void {
  const pos = (n: number, name: string) => {
    if (!(typeof n === "number" && n > 0)) throw new Error(`config: ${name} 必须是正数`);
  };
  pos(cfg.scheduler.tickMs, "scheduler.tickMs");
  pos(cfg.scheduler.debounceMs, "scheduler.debounceMs");
  pos(cfg.loopGuard.blockThreshold, "loopGuard.blockThreshold");
  if (cfg.loopGuard.warnThreshold >= cfg.loopGuard.blockThreshold)
    throw new Error("config: loopGuard.warnThreshold 必须小于 blockThreshold");
  if (cfg.timezone !== "Asia/Shanghai") console.warn(`[config] timezone=${cfg.timezone}（需求要求 Asia/Shanghai）`);
}

/** 只读取、不打印密钥。返回缺失的环境变量名。 */
export function missingEnv(names: string[]): string[] {
  return names.filter((n) => !process.env[n]);
}
