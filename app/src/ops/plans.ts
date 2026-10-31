/** 计划：查、写、改状态。CLI（scripts/plan-*.ts）和 API 都走这里。 */
import type { Store } from "../core/db.ts";
import type { AnchorKind, PlanStatus } from "../types.ts";
import { validateSchedule } from "../core/plans.ts";
import { fmtLocal, parseIsoInTz } from "../core/time.ts";
import { resolvePool } from "./common.ts";

const STATUSES: PlanStatus[] = ["pending", "done", "cancelled"];

export function listPlans(store: Store, status: string = "pending") {
  return store.listPlans(status as PlanStatus).map((p) => ({
    id: p.id,
    title: p.title,
    status: p.status,
    kind: p.schedule_kind,
    schedule: p.schedule ?? null,
    anchor: p.anchor_kind ?? null,
    pool: p.pool_id ? store.poolAlias(p.pool_id) : null,
    // once 的直接算出本地时间；cron 的就给表达式（下一次要跑 plans.ts 里的调度器才算得准）
    next_fire_local: p.schedule_kind === "once" && p.schedule ? fmtLocal(Date.parse(p.schedule)) : null,
    why: p.why ?? null,
  }));
}

export interface AddPlanInput {
  title?: string;
  content?: string;
  kind?: "once" | "cron" | "none";
  when?: string;
  pool?: string;
  anchor?: AnchorKind | null;
  why?: string | null;
  expires?: string;
}

export function addPlan(store: Store, tz: string, input: AddPlanInput, nowMs: number = Date.now()) {
  const title = input.title;
  if (!title) throw new Error("缺少 title");
  const kind = input.kind ?? "none";
  const v = validateSchedule({ kind, value: input.when }, nowMs, tz);
  if (!v.ok) throw new Error(`计划格式错误：${v.error}`);
  let expires: number | null = null;
  if (input.expires) {
    expires = parseIsoInTz(String(input.expires), tz);
    if (expires === null) throw new Error("expires 不是合法 ISO 时间");
  }
  const pool = input.pool ? resolvePool(store, input.pool) : undefined;
  const plan = store.insertPlan({
    title,
    content: input.content ?? "",
    pool_id: pool?.pool_id ?? null,
    schedule_kind: v.kind,
    schedule: v.schedule,
    expires_at: expires,
    anchor_kind: (input.anchor as AnchorKind | null | undefined) ?? null,
    why: input.why ?? null,
  });
  return { id: plan.id, first_fire_local: v.firstFire ? fmtLocal(v.firstFire) : null, anchor: input.anchor ?? "L2" };
}

export function updatePlan(store: Store, id: number, status: string) {
  if (!Number.isInteger(id) || id <= 0) throw new Error("计划 id 必须是正整数");
  if (!STATUSES.includes(status as PlanStatus)) throw new Error(`status 只能是 ${STATUSES.join(" / ")}`);
  if (!store.setPlanStatus(id, status as PlanStatus)) throw new Error(`没有计划 #${id}`);
  return { id, status };
}
