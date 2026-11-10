/**
 * 任务回传：本地一次性 coding CLI（opencode / mimo）按 `<executor>-<task_id>` 调
 * touch / progress / complete / fail 上报进度与结果。
 *
 * 不再有常驻 worker 注册与领任务：派发由 dispatch.ts 直接把任务标成 running。
 */
import type { Store } from "./db.ts";
import { getTask, markPendingTick, updateTask, type Task } from "./tasks.ts";
import { appendTaskEvent } from "./task-events.ts";

export interface ClaimOptions {
  now?: number;
  leaseMs?: number;
}

export interface ProgressTaskInput {
  workerId: string;
  stage: string;
  note?: string;
  now?: number;
}

export interface CompleteTaskInput {
  workerId: string;
  result?: string;
  artifact?: string;
  note?: string;
  now?: number;
}

export interface FailTaskInput {
  workerId: string;
  error?: string;
  retryable?: boolean;
  now?: number;
}

/** 默认租约：worker 每 30s touch 一次，120s 留足重试与抖动。 */
export const DEFAULT_LEASE_MS = 120_000;

/** worker_id 与任务当前持有者不一致：API 映射成 409。 */
export class WorkerMismatchError extends Error {
  constructor(id: number, heldBy: string | null, workerId: string) {
    super(`任务 #${id} 由 ${heldBy || "未知 worker"} 持有，不是 ${workerId}`);
    this.name = "WorkerMismatchError";
  }
}

function requireWorkerId(workerId: unknown): string {
  const id = String(workerId ?? "").trim();
  if (!id) throw new Error("缺少 worker_id");
  return id;
}

function clip(text: string, max = 80): string {
  const s = String(text ?? "").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function eventText(...lines: (string | undefined)[]): string {
  return lines.filter((x): x is string => !!x && !!x.trim()).join("\n");
}

/** 续租；任务不在 running 返回 null，worker 不匹配抛 WorkerMismatchError。 */
export function touchTask(store: Store, id: number, workerId: string, opts: ClaimOptions = {}): Task | null {
  const worker = requireWorkerId(workerId);
  const task = getTask(store, id);
  if (!task || task.status !== "running") return null;
  if (task.worker_id !== worker) throw new WorkerMismatchError(id, task.worker_id, worker);
  const now = opts.now ?? Date.now();
  const leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
  const r = store.db.prepare(
    "UPDATE tasks SET lease_until=?, updated_at=? WHERE id=? AND status='running' AND worker_id=?",
  ).run(now + leaseMs, now, id, worker);
  if (Number(r.changes) !== 1) return null;
  return getTask(store, id);
}

/** 进度：只允许持有者在 running 时更新 stage/note，并把这一段写进任务池。 */
export function progressTask(store: Store, id: number, input: ProgressTaskInput): Task {
  const workerId = requireWorkerId(input.workerId);
  const stage = String(input.stage ?? "").trim();
  if (!stage) throw new Error("缺少 stage");
  const task = getTask(store, id);
  if (!task) throw new Error(`没有任务 #${id}`);
  if (task.worker_id !== workerId) throw new WorkerMismatchError(id, task.worker_id, workerId);
  if (task.status !== "running") throw new Error(`任务 #${id} 不在运行`);

  const note = input.note === undefined ? undefined : String(input.note);
  const updated = updateTask(store, id, { stage, ...(note === undefined ? {} : { note }) });
  const now = input.now ?? Date.now();
  appendTaskEvent(store, id, {
    text: eventText(`阶段 ${stage}`, note?.trim()),
    sender: workerId,
    senderName: workerId,
    ts: now,
  });
  return updated;
}

function appendLine(base: string, line: string): string {
  const text = String(line ?? "").trim();
  if (!text) return base;
  return base ? `${base}\n${text}` : text;
}

function requireRunning(task: Task, id: number, workerId: string): void {
  if (task.status !== "running") throw new Error(`任务 #${id} 不在运行，不能回传`);
  if (task.worker_id !== workerId) throw new WorkerMismatchError(id, task.worker_id, workerId);
}

/** 完成：done + end_at + 清 lease；置 pending tick，事件由下一次任务 tick 批量带走（不立即 enqueue）。 */
export function completeTask(store: Store, id: number, input: CompleteTaskInput, _enqueue?: () => void): Task {
  const workerId = requireWorkerId(input.workerId);
  const task = getTask(store, id);
  if (!task) throw new Error(`没有任务 #${id}`);
  requireRunning(task, id, workerId);
  const now = input.now ?? Date.now();
  const note = appendLine(task.note, input.note ?? "");
  const result = input.result ?? task.result;
  const artifact = input.artifact ?? task.artifact;
  const r = store.db.prepare(`UPDATE tasks SET
    status='done', result=?, artifact=?, note=?, end_at=?, lease_until=NULL, updated_at=?
    WHERE id=? AND status='running' AND worker_id=?`)
    .run(result, artifact, note, now, now, id, workerId);
  if (Number(r.changes) !== 1) throw new Error(`任务 #${id} 不在运行，不能完成`);
  appendTaskEvent(store, id, {
    text: eventText(`任务完成：${clip(result)}`, artifact.trim() ? `产出：${artifact.trim()}` : undefined),
    sender: workerId,
    senderName: workerId,
    ts: now,
  });
  markPendingTick(store, now);
  return getTask(store, id)!;
}

/**
 * 失败：retryable 回 pending 并清 worker/lease；否则 failed + 写 note/result。
 * 只有落到 failed 才置 pending tick——回 pending 不是终态；事件由下一次任务 tick 批量带走。
 */
export function failTask(store: Store, id: number, input: FailTaskInput, _enqueue?: () => void): Task {
  const workerId = requireWorkerId(input.workerId);
  const task = getTask(store, id);
  if (!task) throw new Error(`没有任务 #${id}`);
  requireRunning(task, id, workerId);
  const now = input.now ?? Date.now();
  const error = String(input.error ?? "").trim();

  if (input.retryable) {
    const note = appendLine(task.note, error ? `重试：${error}` : "");
    const r = store.db.prepare(`UPDATE tasks SET
      status='pending', worker_id=NULL, claimed_at=NULL, lease_until=NULL, note=?, updated_at=?
      WHERE id=? AND status='running' AND worker_id=?`)
      .run(note, now, id, workerId);
    if (Number(r.changes) !== 1) throw new Error(`任务 #${id} 不在运行，不能回传失败`);
    appendTaskEvent(store, id, {
      text: `任务失败，可重试${error ? `：${clip(error)}` : ""}`,
      sender: workerId,
      senderName: workerId,
      ts: now,
    });
    return getTask(store, id)!;
  }

  const note = appendLine(task.note, error ? `失败：${error}` : "");
  const r = store.db.prepare(`UPDATE tasks SET
    status='failed', result=?, note=?, end_at=?, lease_until=NULL, updated_at=?
    WHERE id=? AND status='running' AND worker_id=?`)
    .run(error || task.result, note, now, now, id, workerId);
  if (Number(r.changes) !== 1) throw new Error(`任务 #${id} 不在运行，不能回传失败`);
  appendTaskEvent(store, id, {
    text: `任务失败${error ? `：${clip(error)}` : ""}`,
    sender: workerId,
    senderName: workerId,
    ts: now,
  });
  markPendingTick(store, now);
  return getTask(store, id)!;
}
