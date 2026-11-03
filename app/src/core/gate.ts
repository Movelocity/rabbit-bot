/**
 * 主动开口的门控：六道门，纯函数，不碰 IO。
 *
 * 为什么要门控而不是一个概率：概率回答不了「她现在想不想说话」，
 * 只能回答「这次骰子开不开」。所以「想不想」交给模型自省（reflection.ts），
 * 这里只负责用一排硬条件把不该打扰的时候挡住。
 *
 * 六道门按顺序短路，第一个不过的直接返回，reason 写进 proactive_log。
 * 顺序是有意的：便宜的判断在前（数值比较），贵的在最后。
 */

export type GateReason =
  | "ok"
  | "no_reflection"
  | "low_urgency"
  | "no_history"
  | "not_silent"
  | "quiet_hours"
  | "cooldown"
  | "daily_limit"
  | "no_response"
  | "chat_streaming";

export interface GateConfig {
  /** 低于这个 urgency 就不开口。定太低她会变得像个话痨，定太高她就消失了 */
  urgencyThreshold: number;
  /** 用户最后一条消息之后至少安静这么久才允许主动 */
  minSilentMs: number;
  /** 冷却基准值：实际上按 urgency 缩放，见 cooldownRequired */
  minIntervalMs: number;
  /** 24 小时主动上限 */
  maxPerDay: number;
  /** 连续说了几次没人回就闭嘴 */
  maxConsecutive: number;
  /** 夜间静默段，HH:MM，支持跨零点 */
  quietStart: string;
  quietEnd: string;
}

export const GATE_DEFAULTS: GateConfig = {
  urgencyThreshold: 0.35,
  minSilentMs: 300_000,
  minIntervalMs: 600_000,
  // 一天被主动搭话 15 次会烦。先按 6 次跑，看「说了之后他回了几次」再调
  maxPerDay: 6,
  maxConsecutive: 3,
  quietStart: "23:30",
  quietEnd: "08:00",
};

export function gateCfg(c?: Partial<GateConfig> | null): GateConfig {
  return { ...GATE_DEFAULTS, ...(c ?? {}) };
}

export interface GateInput {
  now: number;
  /** null = 这一轮没有自省结果（还没跑过，或解析失败） */
  urgency: number | null;
  /** 全局最后一条用户消息（跨池取最大），0 = 从没说过话 */
  lastUserTs: number;
  /** 本池最后一条用户消息，0 = 没有 */
  poolLastUserTs: number;
  /** 上次主动开口的时间戳，0 = 从没主动说过 */
  lastSpeakTs: number;
  /** 24 小时内已经主动开口几次 */
  speaksToday: number;
  /** 连着说了几次没人回 */
  consecutiveSpeaks: number;
  /** 当前正在生成普通回复 */
  chatStreaming: boolean;
  tz?: string;
  cfg?: Partial<GateConfig>;
}

export interface GateVerdict {
  speak: boolean;
  reason: GateReason;
  /** 距用户最后一次说话多久（毫秒）；没说过话是 Infinity */
  silentMs: number;
  /** 这一档 urgency 要求的冷却时长 */
  cooldownRequiredMs: number;
  /** 距上次主动开口多久 */
  cooldownElapsedMs: number;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * 冷却不是固定值，跟 urgency 反向缩放：
 *   urgency = 1.0  → 想说得要命，几乎不用等
 *   urgency = 阈值 → 等 minInterval × 0.7
 * 「多快能开口」和「多想开口」本来就是同一个数，不用另设一套水位。
 */
export function cooldownRequired(urgency: number, minIntervalMs: number): number {
  return Math.round(minIntervalMs * (1 - clamp01(urgency) * 0.85));
}

function hhmm(s: string): number {
  const [h, m] = String(s ?? "").split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** 这个时刻是否在夜间静默段里（支持跨零点，如 23:30→08:00） */
export function inQuietHours(now: number, cfg: GateConfig, tz = "Asia/Shanghai"): boolean {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date(now));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const cur = get("hour") * 60 + get("minute");
  const a = hhmm(cfg.quietStart);
  const b = hhmm(cfg.quietEnd);
  if (a === b) return false;
  return a < b ? cur >= a && cur < b : cur >= a || cur < b;
}

/** 六道门。按顺序短路，返回第一个拦下的理由。 */
export function evaluateGate(i: GateInput): GateVerdict {
  const cfg = gateCfg(i.cfg);
  const mostRecentUser = Math.max(i.lastUserTs || 0, i.poolLastUserTs || 0);
  const silentMs = i.lastUserTs > 0 ? Math.max(0, i.now - mostRecentUser) : Infinity;
  const urgency = i.urgency ?? 0;
  const cooldownRequiredMs = cooldownRequired(urgency, cfg.minIntervalMs);
  const cooldownElapsedMs = i.lastSpeakTs > 0 ? Math.max(0, i.now - i.lastSpeakTs) : Infinity;

  const out = (speak: boolean, reason: GateReason): GateVerdict => ({
    speak, reason, silentMs, cooldownRequiredMs, cooldownElapsedMs,
  });

  // 门 0：得先有过对话。从没聊过天就主动搭话，那是骚扰不是陪伴
  if (i.lastUserTs <= 0) return out(false, "no_history");
  // 门 1：没有自省结果，或者她没那么想说
  if (i.urgency === null) return out(false, "no_reflection");
  if (urgency < cfg.urgencyThreshold) return out(false, "low_urgency");
  // 门 2：用户刚说完话别抢
  if (silentMs < cfg.minSilentMs) return out(false, "not_silent");
  // 门 3：夜间不叫。叫醒只是为了说句话，凌晨说给谁听
  if (inQuietHours(i.now, cfg, i.tz)) return out(false, "quiet_hours");
  // 门 4：冷却，按 urgency 缩放
  if (cooldownElapsedMs < cooldownRequiredMs) return out(false, "cooldown");
  // 门 5：24 小时硬顶
  if (i.speaksToday >= cfg.maxPerDay) return out(false, "daily_limit");
  // 门 6：连着说了几次没人回，就闭嘴。这条 rabbit-bot 以前没有，所以它会在人忙的时候一直说
  if (i.consecutiveSpeaks >= cfg.maxConsecutive) return out(false, "no_response");
  // 门 7：别跟正常回复挤在一起，两条会被 IM 合并成一条
  if (i.chatStreaming) return out(false, "chat_streaming");

  return out(true, "ok");
}
