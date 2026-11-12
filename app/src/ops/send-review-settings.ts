/**
 * 出站审核设置的持久化：Web 管理台改完写 <dataDir>/run/send-review.json，
 * 重启时在创建 App 之前把保存值覆盖回 cfg.sendReview。
 *
 * 总开关、默认策略和按池覆盖都放这里；审批房（platform / roomId / ownerIds）
 * 仍来自 config/local.json，Web 只负责选哪些池要审。
 */
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";

export interface SendReviewSettings {
  /** 总开关；关掉时所有池都直接发 */
  enabled: boolean;
  /** 没单独设置的池默认是否审核 */
  defaultReview: boolean;
  /** 主对话池：永远不审核，审批消息也发到这个会话 */
  primaryPoolId: string | null;
  /** pool_id → 是否审核；true = 需审批，false = 直接发 */
  overrides: Record<string, boolean>;
}

export const DEFAULT_SEND_REVIEW_SETTINGS: SendReviewSettings = {
  enabled: false,
  // 默认直接发：只有主动标记「需审批」的会话才走审核，主对话不被打扰
  defaultReview: false,
  primaryPoolId: null,
  overrides: {},
};

const MAX_OVERRIDES = 5000;

function settingsPath(cfg: Config): string {
  return path.join(cfg.dataDir, "run", "send-review.json");
}

/** 当前生效值（配置里缺省时用默认值） */
export function effectiveSendReviewSettings(cfg: Config): SendReviewSettings {
  const s = cfg.sendReview;
  const primary = String(s?.primaryPoolId ?? "").trim();
  return {
    enabled: s?.enabled === true,
    defaultReview: s?.defaultReview === true,
    primaryPoolId: primary || null,
    overrides: { ...(s?.overrides ?? {}) },
  };
}

/** 纯函数：这个池要不要审核。主对话永远免审；总开关关掉时一律直接发。 */
export function reviewRequiredFor(settings: SendReviewSettings, poolId: string): boolean {
  if (!settings.enabled) return false;
  if (settings.primaryPoolId && settings.primaryPoolId === poolId) return false;
  return settings.overrides[poolId] ?? settings.defaultReview;
}

/** 校验并规范成设置对象；错误里带字段名，供 API 直接回 400 */
export function validateSendReviewSettings(raw: unknown): SendReviewSettings {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("设置要是一个对象");
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.enabled !== "boolean") throw new Error("enabled 必须是布尔值");
  if (typeof o.defaultReview !== "boolean") throw new Error("defaultReview 必须是布尔值");

  let primaryPoolId: string | null = null;
  if (o.primaryPoolId !== undefined && o.primaryPoolId !== null) {
    if (typeof o.primaryPoolId !== "string") throw new Error("primaryPoolId 必须是字符串或 null");
    primaryPoolId = o.primaryPoolId.trim() || null;
  }

  const overrides: Record<string, boolean> = {};
  if (o.overrides !== undefined) {
    if (o.overrides === null || typeof o.overrides !== "object" || Array.isArray(o.overrides)) {
      throw new Error("overrides 必须是 pool_id → 布尔值的对象");
    }
    const entries = Object.entries(o.overrides as Record<string, unknown>);
    if (entries.length > MAX_OVERRIDES) throw new Error(`overrides 最多 ${MAX_OVERRIDES} 条`);
    for (const [poolId, value] of entries) {
      if (!poolId.trim()) throw new Error("overrides 的 key 不能为空");
      if (typeof value !== "boolean") throw new Error(`overrides.${poolId} 必须是布尔值`);
      overrides[poolId] = value;
    }
  }

  return { enabled: o.enabled, defaultReview: o.defaultReview, primaryPoolId, overrides };
}

/** 写回配置：总开关、默认策略、按池覆盖 */
export function applySendReviewSettings(cfg: Config, s: SendReviewSettings): void {
  cfg.sendReview = {
    ...(cfg.sendReview ?? {}),
    enabled: s.enabled,
    defaultReview: s.defaultReview,
    primaryPoolId: s.primaryPoolId,
    overrides: { ...s.overrides },
  };
}

/** 启动时读保存值并应用；文件不存在跳过，坏文件只 warn */
export function loadSendReviewSettings(
  cfg: Config,
  log?: { warn: (msg: string) => void },
): SendReviewSettings | null {
  const file = settingsPath(cfg);
  if (!fs.existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    log?.warn(`发送审核设置读取失败（${file}）：${(e as Error).message}`);
    return null;
  }
  try {
    const current = effectiveSendReviewSettings(cfg);
    const source = raw !== null && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const settings = validateSendReviewSettings({
      enabled: source.enabled ?? current.enabled,
      defaultReview: source.defaultReview ?? current.defaultReview,
      primaryPoolId: source.primaryPoolId ?? current.primaryPoolId,
      overrides: source.overrides ?? current.overrides,
    });
    applySendReviewSettings(cfg, settings);
    return settings;
  } catch (e) {
    log?.warn(`发送审核设置无效（${file}）：${(e as Error).message}`);
    return null;
  }
}

export function saveSendReviewSettings(cfg: Config, s: SendReviewSettings): void {
  const file = settingsPath(cfg);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    enabled: s.enabled,
    defaultReview: s.defaultReview,
    primaryPoolId: s.primaryPoolId,
    overrides: s.overrides,
    updated_at: new Date().toISOString(),
  }, null, 2) + "\n", "utf8");
}
