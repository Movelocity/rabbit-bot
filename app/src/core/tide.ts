/**
 * 潮汐闸门：计划到点了，不一定就该说。
 *
 * 规则（2026-10-24 设计稿 rabbit-bot-tide-design.md）：
 * - L0（日期类）：硬锚点。不占每日额度、不受窗口限制——生日那天被闸门拦住是最蠢的失败。
 * - L1（跟进到期）/ L2（普通关心）：按「池 × 天 × 档」数已发条数，到顶就拦。
 * - anchor_kind 为空一律按 L2：否则模型只要不填档位就能绕过全部约束。
 *
 * 拦下来不是错误：`due()` 会把这个触发点记成已消费，计划不会反复重试。
 */
import type { Store } from "./db.ts";
import type { Plan } from "../types.ts";
import type { WaveConfig } from "./wave.ts";

export type AnchorKind = "L0" | "L1" | "L2";

export interface TideConfig {
  enabled: boolean;
  dailyCap: { L1: number; L2: number };
  /** 水位场：只作用于 L2（普通关心）的时机。缺省 = 用 WAVE_DEFAULTS；enabled:false = 完全不参与 */
  wave?: Partial<WaveConfig>;
}

export type FireVerdict =
  | { ok: true; anchor: AnchorKind }
  | { ok: false; reason: "cap" | "disabled"; detail: string };

/** 本地日历日（Asia/Shanghai 的 YYYY-MM-DD），额度按自然日算 */
export function localDay(ts: number, tz: string): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ts));
}

export function anchorOf(p: Pick<Plan, "anchor_kind">): AnchorKind {
  const k = (p.anchor_kind ?? "").toUpperCase();
  return k === "L0" || k === "L1" || k === "L2" ? (k as AnchorKind) : "L2";
}

export function canFire(
  store: Store, p: Plan, cfg: TideConfig | undefined, now: number, tz = "Asia/Shanghai",
): FireVerdict {
  // 没配 tide 就全开：老测试和老调用点不该因为少传参数就炸，闸门缺失也不能拦人
  if (!cfg || !cfg.enabled) return { ok: true, anchor: anchorOf(p) };
  const kind = anchorOf(p);
  if (kind === "L0") return { ok: true, anchor: kind };

  const cap = cfg.dailyCap[kind] ?? 0;
  const day = localDay(now, tz);
  const used = store.countTideFired(day, p.pool_id, kind);
  if (used >= cap) {
    return { ok: false, reason: "cap", detail: `今天这个池已经发过 ${used} 条 ${kind}，上限 ${cap}` };
  }
  return { ok: true, anchor: kind };
}
