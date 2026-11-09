/**
 * 权限申请：worker 要动宿主机/越权时落库上呈，UFA 或审批房裁决，worker 轮询取结果。
 *
 * 硬规矩（继承 core/approval.ts）：
 *   1. 超时 = 拒绝（fail-closed），不是默认放行
 *   2. 申请和裁决都落库——重启后 pending 还在，可以继续裁决
 *   3. 只有 pending 能被裁决；重复裁决 / 已过期一律 409
 */
import type { Store } from "./db.ts";
import { getTask, markPendingTick } from "./tasks.ts";
import { appendTaskEvent } from "./task-events.ts";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "timeout";

export const APPROVAL_STATUSES: ApprovalStatus[] = ["pending", "approved", "rejected", "timeout"];

export function isApprovalStatus(v: unknown): v is ApprovalStatus {
  return typeof v === "string" && (APPROVAL_STATUSES as string[]).includes(v);
}

export type ApprovalDecision = "approved" | "rejected";

export interface Approval {
  id: number;
  task_id: number;
  worker_id: string;
  action: string;
  detail: string;
  why: string;
  status: ApprovalStatus;
  decided_by: string | null;
  decided_at: number | null;
  created_at: number;
  expires_at: number;
}

export interface CreateApprovalInput {
  taskId?: number;
  workerId?: string;
  action: string;
  detail?: string;
  why?: string;
  /** 秒；默认 600 */
  timeoutS?: number;
  /** 测试注入「现在」 */
  now?: number;
}

export interface ApprovalFilter {
  status?: ApprovalStatus;
  taskId?: number;
  limit?: number;
}

export interface DecideApprovalInput {
  decision: ApprovalDecision;
  by: string;
  /** 测试注入「现在」 */
  now?: number;
}

export const DEFAULT_APPROVAL_TIMEOUT_S = 600;

/** 已经裁决过 / 已过期：API 映射成 409。 */
export class ApprovalConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalConflictError";
  }
}

function row(store: Store, id: number): Approval {
  const a = store.db.prepare("SELECT * FROM approvals WHERE id=?").get(id) as Approval | undefined;
  if (!a) throw new Error(`没有审批 #${id}`);
  return a;
}

export function createApproval(store: Store, input: CreateApprovalInput, enqueue?: () => void): Approval {
  const action = String(input.action ?? "").trim();
  if (!action) throw new Error("缺少 action");

  const taskId = Number(input.taskId ?? 0);
  if (!Number.isInteger(taskId) || taskId < 0) throw new Error("task_id 要是非负整数");

  const timeoutS = input.timeoutS === undefined ? DEFAULT_APPROVAL_TIMEOUT_S : Number(input.timeoutS);
  if (!Number.isFinite(timeoutS) || timeoutS <= 0) throw new Error("timeout_s 要是正数");

  const now = input.now ?? Date.now();
  const expiresAt = now + Math.max(1, Math.round(timeoutS * 1000));
  const r = store.db.prepare(`INSERT INTO approvals(
    task_id,worker_id,action,detail,why,status,created_at,expires_at
  ) VALUES(?,?,?,?,?,'pending',?,?)`).run(
    taskId,
    String(input.workerId ?? "").trim(),
    action,
    String(input.detail ?? ""),
    String(input.why ?? ""),
    now,
    expiresAt,
  );
  const id = Number(r.lastInsertRowid);
  if (taskId > 0 && getTask(store, taskId)) {
    const workerId = String(input.workerId ?? "").trim();
    appendTaskEvent(store, taskId, {
      text: [`申请权限：${action}`, String(input.why ?? "").trim()].filter(Boolean).join("\n"),
      sender: workerId || "approval",
      senderName: workerId || "approval",
      ts: now,
    });
  }
  if (markPendingTick(store, now)) enqueue?.();
  return row(store, id);
}

export function getApproval(store: Store, id: number): Approval | null {
  return (store.db.prepare("SELECT * FROM approvals WHERE id=?").get(id) as Approval | undefined) ?? null;
}

export function listApprovals(store: Store, filter: ApprovalFilter = {}): Approval[] {
  const where: string[] = [];
  const args: any[] = [];
  if (filter.status !== undefined) {
    if (!isApprovalStatus(filter.status)) throw new Error(`status 只能是 ${APPROVAL_STATUSES.join(" / ")}`);
    where.push("status=?");
    args.push(filter.status);
  }
  if (filter.taskId !== undefined) {
    const n = Number(filter.taskId);
    if (!Number.isInteger(n) || n < 0) throw new Error("task_id 要是非负整数");
    where.push("task_id=?");
    args.push(n);
  }
  let sql = `SELECT * FROM approvals${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at ASC, id ASC`;
  if (filter.limit !== undefined) {
    const n = Math.floor(filter.limit);
    if (Number.isFinite(n) && n > 0) { sql += " LIMIT ?"; args.push(n); }
  }
  return store.db.prepare(sql).all(...args) as Approval[];
}

/**
 * 裁决：只允许 pending → approved/rejected。
 * 重复裁决抛 ApprovalConflictError（409）；已经过了 expires_at 的 pending 先落成 timeout，再抛 409。
 */
export function decideApproval(
  store: Store,
  id: number,
  input: DecideApprovalInput,
  enqueue?: () => void,
): Approval {
  if (input.decision !== "approved" && input.decision !== "rejected") {
    throw new Error('decision 只能是 "approved" 或 "rejected"');
  }
  const by = String(input.by ?? "").trim();
  if (!by) throw new Error("缺少 by");

  const now = input.now ?? Date.now();
  const current = getApproval(store, id);
  if (!current) throw new Error(`没有审批 #${id}`);
  if (current.status !== "pending") {
    throw new ApprovalConflictError(`审批 #${id} 已经 ${current.status}，不能重复裁决`);
  }

  // 过期了就不能再批：按 timeout 收口，和 sweepExpirations 同一语义
  if (current.expires_at <= now) {
    const expired = store.db.prepare(
      "UPDATE approvals SET status='timeout', decided_at=? WHERE id=? AND status='pending'",
    ).run(now, id);
    if (Number(expired.changes) === 1 && markPendingTick(store, now)) enqueue?.();
    throw new ApprovalConflictError(`审批 #${id} 已过期，按 timeout 处理`);
  }

  const r = store.db.prepare(
    "UPDATE approvals SET status=?, decided_by=?, decided_at=? WHERE id=? AND status='pending'",
  ).run(input.decision, by, now, id);
  if (Number(r.changes) !== 1) throw new ApprovalConflictError(`审批 #${id} 已经裁决过`);

  if (current.task_id > 0 && getTask(store, current.task_id)) {
    appendTaskEvent(store, current.task_id, {
      text: `权限已${input.decision === "approved" ? "批准" : "拒绝"}（by ${by}）`,
      sender: current.worker_id || "approval",
      senderName: current.worker_id || "approval",
      ts: now,
    });
  }

  // 拒绝是终态，需要 UFA 知道；批准不置位（worker 自己会继续）
  if (input.decision === "rejected" && markPendingTick(store, now)) enqueue?.();
  return row(store, id);
}

/** 把已过期的 pending 置成 timeout，返回改动条数。timeout 是终态拒绝，需要置 pending tick。 */
export function sweepExpirations(store: Store, now = Date.now(), enqueue?: () => void): number {
  const r = store.db.prepare(
    "UPDATE approvals SET status='timeout', decided_at=? WHERE status='pending' AND expires_at<=?",
  ).run(now, now);
  const n = Number(r.changes);
  if (n > 0 && markPendingTick(store, now)) enqueue?.();
  return n;
}
