/** 任务面板：UFA 登记、WA 执行、双方都从这里读写（SPEC §3.3）。 */
import type { Store } from "./db.ts";

export type TaskStatus = "pending_approval" | "pending" | "running" | "blocked" | "done" | "failed" | "cancelled";

export const TASK_STATUSES: TaskStatus[] = ["pending_approval", "pending", "running", "blocked", "done", "failed", "cancelled"];

export function isTaskStatus(v: unknown): v is TaskStatus {
  return typeof v === "string" && (TASK_STATUSES as string[]).includes(v);
}

export interface Task {
  id: number;
  user_id: string;
  /** 任务发起时所在的聊天池 */
  pool_id: string;
  /** 任务自己的消息池（platform=task），WA 的领取/进度/完成都写在这里 */
  task_pool_id: string;
  /** 短任务名，格式 #xxx；老任务可能为空，展示时回退成 #任务<id> */
  name: string;
  goal: string;
  deliverable: string;
  constraints: string;
  acceptance: string;
  /** JSON 数组字符串，关联文件 */
  files: string;
  status: TaskStatus;
  stage: string;
  /** 领到这条任务的 worker；没被领过是 null */
  worker_id: string | null;
  claimed_at: number | null;
  /** 租约到期时间（ms）；worker 每 30s touch 续租 */
  lease_until: number | null;
  attempt: number;
  note: string;
  result: string;
  artifact: string;
  start_at: number;
  end_at: number | null;
  /** 任务工作目录（绝对路径）。每条任务一个一次性进程，在它里面跑。 */
  work_dir: string;
  /** opencode | mimo */
  executor: string;
  /** 传给执行器的模型，空 = 用执行器默认 */
  model: string;
  /** 执行器会话 id；恢复任务时用同一个 id 再启动 */
  session_id: string;
  /** 正在跑的 runner 进程 pid；没在跑是 null */
  runner_pid: number | null;
  runner_started_at: number | null;
  /** 任务文档路径（<work_dir>/.ufa/tasks/task-<id>.md） */
  doc_path: string;
  created_at: number;
  updated_at: number;
}

export interface CreateTaskInput extends Partial<Pick<Task,
  "deliverable" | "constraints" | "acceptance" | "status" | "stage" | "note" | "result" | "artifact" | "start_at" | "end_at"
  | "work_dir" | "executor" | "model" | "session_id" | "runner_pid" | "runner_started_at" | "doc_path"
>> {
  userId: string;
  poolId: string;
  name: string;
  goal: string;
  files?: string | string[] | null;
}

export interface TaskFilter {
  userId?: string;
  status?: TaskStatus;
  /** start_at <= dueBefore 的任务 */
  dueBefore?: number;
  limit?: number;
}

function normalizeFiles(files: CreateTaskInput["files"]): string {
  if (Array.isArray(files)) return JSON.stringify(files);
  if (typeof files === "string") return files;
  return "[]";
}

function row(id: number, store: Store): Task {
  const t = store.db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as Task | undefined;
  if (!t) throw new Error(`没有任务 #${id}`);
  return t;
}

/** 短任务名最长 24 个字符（含开头的 #）。 */
export const TASK_NAME_MAX = 24;

/** 规整短任务名：trim、补 #、超长截断；空名直接报错。 */
export function normalizeTaskName(name: unknown): string {
  const raw = String(name ?? "").trim();
  if (!raw) throw new Error("需要短任务名，格式 #xxx");
  const full = raw.startsWith("#") ? raw : `#${raw}`;
  return [...full].slice(0, TASK_NAME_MAX).join("");
}

/** 展示用任务名：老任务没有 name 时回退成 #任务<id>，不报错。 */
export function taskDisplayName(t: Pick<Task, "id" | "name">): string {
  return String(t.name ?? "").trim() || `#任务${t.id}`;
}

/** 池标题直接用短任务名；老任务没有 name 时回退成 #任务<id>。 */
export function taskPoolTitle(id: number, name: string): string {
  return String(name ?? "").trim() || `#任务${id}`;
}

/** 建池或复用：同一任务反复调用只会命中同一个 `task:<id>` 池。 */
export function ensureTaskPool(store: Store, id: number): Task {
  const task = row(id, store);
  if (task.task_pool_id && store.getPool(task.task_pool_id)) return task;
  const pool = store.upsertPool("task", `task:${id}`, "task", taskPoolTitle(id, task.name));
  store.db.prepare("UPDATE tasks SET task_pool_id=?, updated_at=? WHERE id=?").run(pool.pool_id, Date.now(), id);
  return row(id, store);
}

export function createTask(store: Store, t: CreateTaskInput): Task {
  const name = normalizeTaskName(t.name);
  const goal = String(t.goal ?? "");
  if (!goal.trim()) throw new Error("缺少 goal");
  if (t.status !== undefined && !isTaskStatus(t.status)) {
    throw new Error(`status 只能是 ${TASK_STATUSES.join(" / ")}`);
  }
  const now = Date.now();
  const startAt = Number.isFinite(t.start_at) ? Number(t.start_at) : now;
  const status: TaskStatus = t.status ?? "pending";
  const r = store.db.prepare(`INSERT INTO tasks(
    user_id,pool_id,name,goal,deliverable,constraints,acceptance,files,status,stage,note,result,artifact,
    start_at,end_at,work_dir,executor,model,session_id,runner_pid,runner_started_at,doc_path,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    t.userId, t.poolId, name, goal,
    t.deliverable ?? "", t.constraints ?? "", t.acceptance ?? "",
    normalizeFiles(t.files), status, t.stage ?? "", t.note ?? "", t.result ?? "", t.artifact ?? "",
    startAt, t.end_at ?? null,
    String(t.work_dir ?? ""), String(t.executor ?? "opencode") || "opencode", String(t.model ?? ""),
    String(t.session_id ?? ""), t.runner_pid ?? null, t.runner_started_at ?? null, String(t.doc_path ?? ""),
    now, now,
  );
  const id = Number(r.lastInsertRowid);
  ensureTaskPool(store, id);
  return row(id, store);
}

export function getTask(store: Store, id: number): Task | null {
  return (store.db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as Task | undefined) ?? null;
}

export function listTasks(store: Store, filter: TaskFilter = {}): Task[] {
  const where: string[] = [];
  const args: any[] = [];
  if (filter.userId !== undefined) { where.push("user_id=?"); args.push(filter.userId); }
  if (filter.status !== undefined) {
    if (!isTaskStatus(filter.status)) throw new Error(`status 只能是 ${TASK_STATUSES.join(" / ")}`);
    where.push("status=?");
    args.push(filter.status);
  }
  if (filter.dueBefore !== undefined) { where.push("start_at<=?"); args.push(filter.dueBefore); }
  let sql = `SELECT * FROM tasks${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY start_at ASC, id ASC`;
  if (filter.limit !== undefined) {
    const n = Math.floor(filter.limit);
    if (Number.isFinite(n) && n > 0) { sql += " LIMIT ?"; args.push(n); }
  }
  return store.db.prepare(sql).all(...args) as Task[];
}

export type TaskPatch = Partial<Pick<Task,
  "name" | "goal" | "deliverable" | "constraints" | "acceptance" | "files"
  | "status" | "stage" | "worker_id" | "claimed_at" | "lease_until" | "attempt" | "note" | "result" | "artifact" | "end_at"
  | "work_dir" | "executor" | "model" | "session_id" | "runner_pid" | "runner_started_at" | "doc_path"
>>;

const PATCH_KEYS = [
  "name", "goal", "deliverable", "constraints", "acceptance", "files",
  "status", "stage", "worker_id", "claimed_at", "lease_until", "attempt", "note", "result", "artifact", "end_at",
  "work_dir", "executor", "model", "session_id", "runner_pid", "runner_started_at", "doc_path",
] as const;

export function updateTask(store: Store, id: number, patch: TaskPatch): Task {
  if (patch.status !== undefined && !isTaskStatus(patch.status)) {
    throw new Error(`status 只能是 ${TASK_STATUSES.join(" / ")}`);
  }
  const sets: string[] = [];
  const args: any[] = [];
  for (const key of PATCH_KEYS) {
    if (patch[key] !== undefined) { sets.push(`${key}=?`); args.push(patch[key]); }
  }
  sets.push("updated_at=?");
  args.push(Date.now(), id);
  const r = store.db.prepare(`UPDATE tasks SET ${sets.join(",")} WHERE id=?`).run(...args);
  if (r.changes === 0) throw new Error(`没有任务 #${id}`);
  return row(id, store);
}

export function appendNote(store: Store, id: number, line: string): Task {
  const text = String(line ?? "");
  if (!text.trim()) throw new Error("note 不能为空");
  const r = store.db.prepare(`UPDATE tasks SET
    note=CASE WHEN note='' THEN ? ELSE note || char(10) || ? END,
    updated_at=? WHERE id=?`).run(text, text, Date.now(), id);
  if (r.changes === 0) throw new Error(`没有任务 #${id}`);
  return row(id, store);
}

/** 只置 status，不杀进程。 */
export function cancelTask(store: Store, id: number): Task {
  const r = store.db.prepare("UPDATE tasks SET status='cancelled', updated_at=? WHERE id=?").run(Date.now(), id);
  if (r.changes === 0) throw new Error(`没有任务 #${id}`);
  return row(id, store);
}

/** 某时刻之后有更新的任务，供 task-updated 唤醒一次取多条。 */
export function listTasksUpdatedSince(store: Store, since: number, statuses?: readonly TaskStatus[]): Task[] {
  let sql = "SELECT * FROM tasks WHERE updated_at >= ?";
  const args: any[] = [since];
  if (statuses?.length) {
    sql += ` AND status IN (${statuses.map(() => "?").join(",")})`;
    args.push(...statuses);
  }
  sql += " ORDER BY updated_at ASC, id ASC";
  return store.db.prepare(sql).all(...args) as Task[];
}

/** pending tick 的 kv 键：只在「无标记 → 有标记」时唤醒 UFA（docs/research §2.4）。 */
export const PENDING_TASK_TICK_KEY = "ufa.pending_task_tick";

/** 置位；返回 true 表示这次是 0→1，调用方才需要 enqueue。 */
export function markPendingTick(store: Store, now = Date.now()): boolean {
  const r = store.db.prepare("INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO NOTHING")
    .run(PENDING_TASK_TICK_KEY, String(now));
  return Number(r.changes) === 1;
}

/** 消费：事务内读 set_at → 删除 → 返回 set_at；没有标记返回 null。 */
export function takePendingTick(store: Store): number | null {
  const tx = store.db.transaction((): number | null => {
    const r = store.db.prepare("SELECT v FROM kv WHERE k=?").get(PENDING_TASK_TICK_KEY) as { v: string } | undefined;
    if (!r) return null;
    store.db.prepare("DELETE FROM kv WHERE k=?").run(PENDING_TASK_TICK_KEY);
    const n = Number(r.v);
    return Number.isFinite(n) ? n : null;
  });
  return tx.immediate();
}
