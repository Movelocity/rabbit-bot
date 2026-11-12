/** 看门狗设置：Web 管理台改完写 <dataDir>/run/watchdog.json，重启时覆盖回 cfg.watchdog。 */
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";

export interface WatchdogSettings {
  enabled: boolean;
  /** 最后一条消息发出后静默多久开始复核 */
  delayMs: number;
  /** 同一个池两次自动放行之间的冷却 */
  cooldownMs: number;
}

export const DEFAULT_WATCHDOG_SETTINGS: WatchdogSettings = {
  enabled: false,
  delayMs: 10000,
  cooldownMs: 600000,
};

const MIN_DELAY_MS = 1000;
const MAX_DELAY_MS = 3600000;
const MAX_COOLDOWN_MS = 86400000;

function settingsPath(cfg: Config): string {
  return path.join(cfg.dataDir, "run", "watchdog.json");
}

export function effectiveWatchdogSettings(cfg: Config): WatchdogSettings {
  const w = cfg.watchdog;
  return {
    enabled: !!w?.enabled,
    delayMs: w?.delayMs ?? DEFAULT_WATCHDOG_SETTINGS.delayMs,
    cooldownMs: w?.cooldownMs ?? DEFAULT_WATCHDOG_SETTINGS.cooldownMs,
  };
}

export function validateWatchdogSettings(raw: unknown): WatchdogSettings {
  const o = raw !== null && typeof raw === "object" ? raw as Record<string, unknown> : {};
  if (typeof o.enabled !== "boolean") throw new Error("enabled 必须是布尔值");
  if (typeof o.delayMs !== "number" || !Number.isInteger(o.delayMs) || o.delayMs < MIN_DELAY_MS || o.delayMs > MAX_DELAY_MS) {
    throw new Error(`delayMs 必须是 ${MIN_DELAY_MS}~${MAX_DELAY_MS} 的整数（毫秒）`);
  }
  if (typeof o.cooldownMs !== "number" || !Number.isInteger(o.cooldownMs) || o.cooldownMs < 0 || o.cooldownMs > MAX_COOLDOWN_MS) {
    throw new Error(`cooldownMs 必须是 0~${MAX_COOLDOWN_MS} 的整数（毫秒）`);
  }
  return { enabled: o.enabled, delayMs: o.delayMs, cooldownMs: o.cooldownMs };
}

export function applyWatchdogSettings(cfg: Config, s: WatchdogSettings): void {
  cfg.watchdog = { ...s };
}

export function loadWatchdogSettings(
  cfg: Config,
  log?: { warn: (msg: string) => void },
): WatchdogSettings | null {
  const file = settingsPath(cfg);
  if (!fs.existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    log?.warn(`看门狗设置读取失败（${file}）：${(e as Error).message}`);
    return null;
  }
  try {
    const current = effectiveWatchdogSettings(cfg);
    const source = raw !== null && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const settings = validateWatchdogSettings({
      enabled: source.enabled ?? current.enabled,
      delayMs: source.delayMs ?? current.delayMs,
      cooldownMs: source.cooldownMs ?? current.cooldownMs,
    });
    applyWatchdogSettings(cfg, settings);
    return settings;
  } catch (e) {
    log?.warn(`看门狗设置无效（${file}）：${(e as Error).message}`);
    return null;
  }
}

export function saveWatchdogSettings(cfg: Config, s: WatchdogSettings): void {
  const file = settingsPath(cfg);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    enabled: s.enabled,
    delayMs: s.delayMs,
    cooldownMs: s.cooldownMs,
    updated_at: new Date().toISOString(),
  }, null, 2) + "\n", "utf8");
}
