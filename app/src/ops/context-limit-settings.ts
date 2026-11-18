/**
 * 上下文交接阈值：Web 管理台改完写 <dataDir>/run/context-limit.json，
 * 重启时在创建 App 之前把保存值覆盖回 cfg.handoff.contextTokenLimit。
 *
 * 只允许固定几档：这个值直接决定什么时候花一次 LLM 调用写交接文档，
 * 也决定上下文滚到多大才换会话，随便填容易把模型窗口或日额度撞穿。
 */
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";

export interface ContextLimitSettings {
  tokenLimit: number;
}

/** 可选档位；默认 100k */
export const CONTEXT_LIMIT_CHOICES = [60000, 100000, 200000, 500000, 800000] as const;
export const DEFAULT_CONTEXT_LIMIT = 100000;

function settingsPath(cfg: Config): string {
  return path.join(cfg.dataDir, "run", "context-limit.json");
}

export function effectiveContextLimitSettings(cfg: Config): ContextLimitSettings {
  return { tokenLimit: cfg.handoff.contextTokenLimit ?? DEFAULT_CONTEXT_LIMIT };
}

export function validateContextLimitSettings(raw: unknown): ContextLimitSettings {
  const o = raw !== null && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const v = o.tokenLimit;
  if (typeof v !== "number" || !Number.isInteger(v)) throw new Error("tokenLimit 必须是整数");
  if (!(CONTEXT_LIMIT_CHOICES as readonly number[]).includes(v)) {
    throw new Error(`tokenLimit 只能是 ${CONTEXT_LIMIT_CHOICES.join(" / ")}`);
  }
  return { tokenLimit: v };
}

export function applyContextLimitSettings(cfg: Config, s: ContextLimitSettings): void {
  cfg.handoff.contextTokenLimit = s.tokenLimit;
}

/** 缺失字段沿用当前值；先校验、再落盘、最后应用，写失败就整体不动。 */
export function saveContextLimitSettings(cfg: Config, s: ContextLimitSettings): void {
  const file = settingsPath(cfg);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    tokenLimit: s.tokenLimit,
    updated_at: new Date().toISOString(),
  }, null, 2) + "\n", "utf8");
}

/** 启动时读保存值并应用；文件不存在跳过，坏文件只 warn。 */
export function loadContextLimitSettings(
  cfg: Config,
  log?: { warn: (msg: string) => void },
): ContextLimitSettings | null {
  const file = settingsPath(cfg);
  if (!fs.existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    log?.warn(`上下文阈值设置读取失败（${file}）：${(e as Error).message}`);
    return null;
  }
  try {
    const settings = validateContextLimitSettings(raw);
    applyContextLimitSettings(cfg, settings);
    return settings;
  } catch (e) {
    log?.warn(`上下文阈值设置无效（${file}）：${(e as Error).message}`);
    return null;
  }
}
