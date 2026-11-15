/**
 * 日额度设置：Web 管理台改完写 <dataDir>/run/limits.json，
 * 重启时在创建 App 之前把保存值覆盖回 cfg.limits。
 *
 * 三条闸的语义沿用 config：
 * - dailyLlmCalls / dailyTokens：-1 = 不设这条闸
 * - dailyCny：0 = 不按钱限额
 */
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";
import type { Store } from "../core/db.ts";
import { dayKey } from "../core/time.ts";

export interface LimitSettings {
  dailyLlmCalls: number;
  dailyTokens: number;
  dailyCny: number;
}

export interface LimitToday {
  day: string;
  llm_calls: number;
  tokens: number;
  cost_usd: number;
  cost_cny: number;
  /** null = 这条闸没开 */
  calls_left: number | null;
  tokens_left: number | null;
  cny_left: number | null;
}

export interface LimitStatus extends LimitSettings {
  usdCny: number;
  today: LimitToday;
}

const MAX_CALLS = 1_000_000;
const MAX_TOKENS = 1_000_000_000_000;
const MAX_CNY = 1_000_000;

function settingsPath(cfg: Config): string {
  return path.join(cfg.dataDir, "run", "limits.json");
}

export function effectiveLimitSettings(cfg: Config): LimitSettings {
  return {
    dailyLlmCalls: Number(cfg.limits.dailyLlmCalls ?? -1),
    dailyTokens: Number(cfg.limits.dailyTokens ?? -1),
    dailyCny: Number(cfg.limits.dailyCny ?? 0),
  };
}

function pickInt(raw: Record<string, unknown>, key: keyof LimitSettings, min: number, max: number): number {
  const v = raw[key];
  if (typeof v !== "number" || !Number.isInteger(v)) throw new Error(`${key} 必须是整数`);
  if (v < min || v > max) throw new Error(`${key} 必须是 ${min}~${max} 的整数`);
  return v;
}

export function validateLimitSettings(raw: unknown): LimitSettings {
  const o = raw !== null && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const dailyCny = o.dailyCny;
  if (typeof dailyCny !== "number" || !Number.isFinite(dailyCny)) throw new Error("dailyCny 必须是数字");
  if (dailyCny < 0 || dailyCny > MAX_CNY) throw new Error(`dailyCny 必须是 0~${MAX_CNY} 的数字（0 = 不按钱限额）`);
  return {
    dailyLlmCalls: pickInt(o, "dailyLlmCalls", -1, MAX_CALLS),
    dailyTokens: pickInt(o, "dailyTokens", -1, MAX_TOKENS),
    dailyCny,
  };
}

export function applyLimitSettings(cfg: Config, s: LimitSettings): void {
  cfg.limits.dailyLlmCalls = s.dailyLlmCalls;
  cfg.limits.dailyTokens = s.dailyTokens;
  cfg.limits.dailyCny = s.dailyCny;
}

/** 缺失字段沿用当前值；先校验、再落盘、最后应用，写失败就整体不动。 */
export function saveLimitSettings(cfg: Config, input: Partial<LimitSettings>): LimitSettings {
  const current = effectiveLimitSettings(cfg);
  const next = validateLimitSettings({
    dailyLlmCalls: input.dailyLlmCalls ?? current.dailyLlmCalls,
    dailyTokens: input.dailyTokens ?? current.dailyTokens,
    dailyCny: input.dailyCny ?? current.dailyCny,
  });
  const file = settingsPath(cfg);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    dailyLlmCalls: next.dailyLlmCalls,
    dailyTokens: next.dailyTokens,
    dailyCny: next.dailyCny,
    updated_at: new Date().toISOString(),
  }, null, 2) + "\n", "utf8");
  applyLimitSettings(cfg, next);
  return next;
}

/** 启动时读保存值并应用；文件不存在跳过，坏文件只 warn。 */
export function loadLimitSettings(
  cfg: Config,
  log?: { warn: (msg: string) => void },
): LimitSettings | null {
  const file = settingsPath(cfg);
  if (!fs.existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    log?.warn(`日额度设置读取失败（${file}）：${(e as Error).message}`);
    return null;
  }
  try {
    const current = effectiveLimitSettings(cfg);
    const source = raw !== null && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const settings = validateLimitSettings({
      dailyLlmCalls: source.dailyLlmCalls ?? current.dailyLlmCalls,
      dailyTokens: source.dailyTokens ?? current.dailyTokens,
      dailyCny: source.dailyCny ?? current.dailyCny,
    });
    applyLimitSettings(cfg, settings);
    return settings;
  } catch (e) {
    log?.warn(`日额度设置无效（${file}）：${(e as Error).message}`);
    return null;
  }
}

/** 当前额度 + 今天已经用掉的量，供管理台展示。 */
export function limitStatus(cfg: Config, store: Store, now = Date.now()): LimitStatus {
  const settings = effectiveLimitSettings(cfg);
  const day = dayKey(now, cfg.timezone);
  const usage = store.getUsage(day);
  const usdCny = Number(cfg.limits.usdCny ?? 7.1) || 7.1;
  const costCny = (usage.cost_usd ?? 0) * usdCny;
  return {
    ...settings,
    usdCny,
    today: {
      day,
      llm_calls: usage.llm_calls,
      tokens: usage.tokens,
      cost_usd: usage.cost_usd,
      cost_cny: costCny,
      calls_left: settings.dailyLlmCalls < 0 ? null : Math.max(0, settings.dailyLlmCalls - usage.llm_calls),
      tokens_left: settings.dailyTokens < 0 ? null : Math.max(0, settings.dailyTokens - usage.tokens),
      cny_left: settings.dailyCny > 0 ? Math.max(0, settings.dailyCny - costCny) : null,
    },
  };
}
