/**
 * 计划与时间表（纯代码）：
 * - 一次性：ISO 时间（无时区按 Asia/Shanghai 解释）；重复：5/6 段 cron 表达式（按 Asia/Shanghai）。
 * - 状态 pending/done/cancelled/expired；过期时间到了自动 expired。
 * - 同一计划同一时间点只触发一次（plan_fires 主键去重）。
 * - 程序停机期间错过的触发：missedPolicy=catchup 补发一次（最近一次、且在 missedGraceMs 内），skip 则跳过。
 */
import { CronExpressionParser } from "cron-parser";
import { parseIsoInTz } from "./time.ts";
import type { Store } from "./db.ts";
import type { Plan, Wake } from "../types.ts";
import { canFire, localDay, anchorOf, type TideConfig } from "./tide.ts";
import { waveGate } from "./wave.ts";

export interface ScheduleInput { kind: "once" | "cron" | "none"; value?: string | null }
export type ValidateResult = { ok: true; kind: Plan["schedule_kind"]; schedule: string | null; firstFire: number | null } | { ok: false; error: string };

export function validateSchedule(s: ScheduleInput, now: number, tz = "Asia/Shanghai"): ValidateResult {
  if (s.kind === "none") return { ok: true, kind: "none", schedule: null, firstFire: null };
  const v = (s.value ?? "").trim();
  if (!v) return { ok: false, error: "缺少时间表" };
  if (s.kind === "once") {
    const t = parseIsoInTz(v, tz);
    if (t === null) return { ok: false, error: `一次性时间必须是 ISO 格式，如 2026-10-23T09:00 或 2026-10-23T09:00+08:00，收到：${v}` };
    if (t < now - 60_000) return { ok: false, error: "一次性时间已经过去" };
    return { ok: true, kind: "once", schedule: new Date(t).toISOString(), firstFire: t };
  }
  if (s.kind === "cron") {
    const fields = v.split(/\s+/).length;
    if (fields < 5 || fields > 6) return { ok: false, error: "cron 必须是 5 段（分 时 日 月 周）或 6 段（含秒）" };
    try {
      const it = CronExpressionParser.parse(v, { tz, currentDate: new Date(now) });
      const next = it.next().getTime();
      return { ok: true, kind: "cron", schedule: v, firstFire: next };
    } catch (e) {
      return { ok: false, error: `cron 表达式无效：${(e as Error).message}` };
    }
  }
  return { ok: false, error: "kind 只能是 once / cron / none" };
}

/** 计算 (from, to] 内的所有 cron 触发点（最多 limit 个，取最近的） */
export function cronOccurrences(expr: string, from: number, to: number, tz = "Asia/Shanghai", limit = 1000): number[] {
  if (to <= from) return [];
  const it = CronExpressionParser.parse(expr, { tz, currentDate: new Date(to + 1), startDate: new Date(from + 1) });
  const out: number[] = [];
  // 从 to 往回找，避免长停机时遍历过多
  while (out.length < limit) {
    let t: number;
    try { t = it.prev().getTime(); } catch { break; }
    if (t <= from) break;
    out.push(t);
  }
  return out.reverse();
}

export interface PlanEngineConfig { missedPolicy: "catchup" | "skip"; missedGraceMs: number; tz: string; tide?: TideConfig }

export class PlanEngine {
  /** 本进程启动时间：早于它的触发点视为“停机期间错过” */
  private readonly startedAt: number;
  constructor(private store: Store, private cfg: PlanEngineConfig, now = Date.now()) {
    this.startedAt = now;
    if (!store.getKv("plans.lastCheck")) store.setKv("plans.lastCheck", String(now));
  }

  /** 返回本次 tick 应触发的计划；会写入触发记录并推进 lastCheck。 */
  due(now: number): Wake["planFires"] {
    const lastCheck = Number(this.store.getKv("plans.lastCheck") ?? now);
    const fires: Wake["planFires"] = [];
    for (const p of this.store.listPlans("pending")) {
      if (p.expires_at !== null && p.expires_at <= now) { this.store.setPlanStatus(p.id, "expired"); continue; }
      let candidates: number[] = [];
      if (p.schedule_kind === "once" && p.schedule) {
        const t = Date.parse(p.schedule);
        if (t <= now) candidates = [t];
      } else if (p.schedule_kind === "cron" && p.schedule) {
        const from = Math.max(lastCheck, p.created_at);
        try { candidates = cronOccurrences(p.schedule, from, now, this.cfg.tz); } catch { candidates = []; }
      }
      if (!candidates.length) continue;
      const missed = candidates.filter((t) => t < this.startedAt);
      const live = candidates.filter((t) => t >= this.startedAt);
      let fireTs: number | null = null;
      if (live.length) fireTs = live[live.length - 1];
      else if (missed.length && this.cfg.missedPolicy === "catchup") {
        const latest = missed[missed.length - 1];
        if (now - latest <= this.cfg.missedGraceMs) fireTs = latest;
      }
      // 所有候选点都记一次，保证同一时间点不会再次触发
      let fresh = false;
      for (const t of candidates) {
        const inserted = this.store.recordPlanFire(p.id, t);
        if (t === fireTs) fresh = inserted;
      }
      // 到点了不代表该说：先过潮汐额度（L0 放行；L1/L2 按池 × 天 × 档数），再过水位。
      // 水位只作用于 L2（普通关心）——日期档和跟进到期是硬锚点，被「水位不够」拦住是最蠢的失败。
      let fired = false;
      if (fireTs !== null && fresh) {
        const v = canFire(this.store, p, this.cfg.tide, now, this.cfg.tz);
        const wv = v.ok && anchorOf(p) === "L2"
          ? waveGate(this.store, p.pool_id, now, this.cfg.tide?.wave)
          : null;
        const ok = v.ok && (!wv || wv.ok);
        this.store.recordTideEvent({
          plan_id: p.id,
          pool_id: p.pool_id,
          day: localDay(now, this.cfg.tz),
          ts: now,
          kind: ok ? "fired" : "skip",
          anchor_kind: anchorOf(p),
          why: p.why ?? null,
          wave_a: wv ? wv.a : null,
          reason: ok ? null : (v.ok ? (wv?.detail ?? null) : v.detail),
        });
        if (ok) { fires.push({ planId: p.id, fireTs }); fired = true; }
      }
      // 一次性计划被闸门拦下：这个时间点已经过去，标 expired 而不是 done（没执行）
      if (p.schedule_kind === "once") this.store.setPlanStatus(p.id, fired ? "done" : "expired");
    }
    this.store.setKv("plans.lastCheck", String(now));
    return fires;
  }
}
