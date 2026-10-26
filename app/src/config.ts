/** 配置加载：config/default.json ← config/local.json ← $RABBIT_BOT_CONFIG（后者覆盖前者）。密钥只从环境变量读取。 */
import fs from "node:fs";
import type { WaveConfig } from "./core/wave.ts";
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
  scheduler: { tickMs: number; activeTickMs: number; activeWindowMs: number; debounceMs: number; debounceMaxWaitMs: number; watchdogMs: number; overdueGraceMs: number };
  send: { confirmWaitMs: number; confirmViaApi: boolean };
  context: { recentContextMessages: number; maxUnreadPerPool: number; maxMemoriesPerUser: number };
  handoff: { contextTokenLimit: number };
  loopGuard: { impl: "pi-death-loop-guard" | "builtin"; warnThreshold: number; blockThreshold: number; abortAfterBlocks: number };
  limits: { dailyLlmCalls: number; dailyTokens: number; turnTimeoutMs: number };
  plans: { missedPolicy: "catchup" | "skip"; missedGraceMs: number };
  tide: { enabled: boolean; dailyCap: { L1: number; L2: number }; wave?: Partial<WaveConfig> };
  llm: { provider: string; model: string; thinkingLevel: "off" | "minimal" | "low" | "medium" | "high"; maxRetries: number };
  adapters: { feishu: { enabled: boolean; domain: "feishu" | "lark"; fetchSenderName: boolean; reactions: boolean; logRawEmoji: boolean } };
  emoji: { table: string | null; map: Record<string, EmojiTarget> };
  media: { maxEdge: number; maxBytes: number; maxImagesInContext: number };
  sandbox: {
    dir: string;
    maxFileBytes: number;
    maxFiles: number;
    maxReadChars: number;
    shell: { enabled: boolean; container: string; image: string; network: "bridge" | "none"; timeoutMs: number; maxOutputChars: number };
  };
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
  pos(cfg.sandbox.maxFileBytes, "sandbox.maxFileBytes");
  pos(cfg.sandbox.maxFiles, "sandbox.maxFiles");
  pos(cfg.loopGuard.blockThreshold, "loopGuard.blockThreshold");
  if (cfg.tide?.enabled) {
    const { L1, L2 } = cfg.tide.dailyCap;
    if (!(Number.isInteger(L1) && L1 >= 0)) throw new Error("config: tide.dailyCap.L1 必须是 >=0 的整数");
    if (!(Number.isInteger(L2) && L2 >= 0)) throw new Error("config: tide.dailyCap.L2 必须是 >=0 的整数");
  }
  // 水位场定标：wUser 必须 < thr，否则单条孤立消息就能过阈值，整套机制退化成定时开口
  const wv = cfg.tide?.wave;
  if (cfg.tide?.enabled && wv?.enabled) {
    const d = wv.delayMin ?? 30, p = wv.peakMin ?? 45;
    const thr = wv.thr ?? 0.5, wu = wv.wUser ?? 0.4;
    if (!(p > d)) throw new Error("config: tide.wave.peakMin 必须大于 delayMin（峰要落在不打扰期之后）");
    if (!(thr > 0 && thr <= 1)) throw new Error("config: tide.wave.thr 必须在 (0,1]");
    if (!(wu < thr)) throw new Error("config: tide.wave.wUser 必须小于 thr，否则阈值形同虚设");
    const ratio = wv.ratio ?? 0.5, stages = wv.maxStages ?? 3;
    if (!(ratio > 0 && ratio < 1)) throw new Error("config: tide.wave.ratio 必须在 (0,1)，每退一半给一档就是 0.5");
    if (!(Number.isInteger(stages) && stages >= 1)) throw new Error("config: tide.wave.maxStages 必须是 >=1 的整数");
  }
  if (cfg.loopGuard.warnThreshold >= cfg.loopGuard.blockThreshold)
    throw new Error("config: loopGuard.warnThreshold 必须小于 blockThreshold");
  if (cfg.timezone !== "Asia/Shanghai") console.warn(`[config] timezone=${cfg.timezone}（需求要求 Asia/Shanghai）`);
}

/** 只读取、不打印密钥。返回缺失的环境变量名。 */
export function missingEnv(names: string[]): string[] {
  return names.filter((n) => !process.env[n]);
}
