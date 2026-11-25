/**
 * 任务控制动作：查看执行器日志、运行前改需求、续跑、中断、停止。
 *
 * 动作由工具/API 直接调用；每个动作结束后往任务池写 internal 审计指令，
 * 指令本身不会被解析执行，避免出现第二条执行路径。
 */
import type { Store } from "./db.ts";
import {
  DEFAULT_DATA_DIR, resumeTask, runnerAlive, stopTask, writeTaskDoc,
  type DispatchDeps, type LaunchResult,
} from "./dispatch.ts";
import { appendNote, getTask, updateTask, type Task, type TaskPatch } from "./tasks.ts";
import { appendTaskEvent } from "./task-events.ts";
import { appendTaskAudit, buildAuditLine, quoteArg, type TaskAuditSource } from "./task-audit.ts";
import { formatRunnerDigest, readRunnerDigest, type RunnerDigest } from "./runner-tail.ts";

export const TASK_UPDATE_FIELDS = [
  "name", "goal", "deliverable", "constraints", "acceptance", "files",
  "work_dir", "executor", "model", "eta_ms",
] as const;

export type TaskUpdateInput = Partial<Pick<Task, (typeof TASK_UPDATE_FIELDS)[number]>>;

export interface TaskControlOptions {
  /** 审计里的发起者，默认 bot */
  actor?: string;
  actorName?: string;
  /** 审计来源：工具 / HTTP API / 调度器 */
  source?: TaskAuditSource;
  now?: number;
}

export interface TaskLogResult {
  digest: RunnerDigest;
  text: string;
}

/** 每个任务一把进程内互斥锁：resume / interrupt / stop 不能并发改同一条任务。 */
const locks = new Set<number>();

async function withTaskLock<T>(taskId: number, fn: () => Promise<T>): Promise<T> {
  if (locks.has(taskId)) throw new Error(`任务 #${taskId} 正在被另一个控制动作处理，请稍后再试`);
  locks.add(taskId);
  try {
    return await fn();
  } finally {
    locks.delete(taskId);
  }
}

function requireTask(store: Store, id: number): Task {
  const task = getTask(store, id);
  if (!task) throw new Error(`没有任务 #${id}`);
  return task;
}

export function taskIsRunning(task: Pick<Task, "id" | "runner_pid">, dataDir?: string): boolean {
  return runnerAlive(task, dataDir);
}

function audit(store: Store, opts: TaskControlOptions, input: Parameters<typeof appendTaskAudit>[1]): void {
  appendTaskAudit(store, {
    ...input,
    senderName: opts.actorName || input.senderName,
  });
}

function isTerminal(status: Task["status"]): boolean {
  return status === "done" || status === "failed" || status === "cancelled";
}

/** 读执行器日志摘要；只读尾部，不启停进程。 */
export function logTask(
  store: Store,
  task: Task,
  deps: { dataDir?: string },
  opts: TaskControlOptions & { lines?: number } = {},
): TaskLogResult {
  const dataDir = deps.dataDir ?? DEFAULT_DATA_DIR;
  const digest: RunnerDigest = readRunnerDigest(task, dataDir, {
    now: opts.now,
    alive: taskIsRunning(task, dataDir),
  });
  const text = formatRunnerDigest(digest);
  audit(store, opts, {
    taskId: task.id,
    action: "log",
    text: buildAuditLine("log", task.id, `lines=${opts.lines ?? digest.recent.length}`),
    source: opts.source ?? "tool",
    args: { lines: opts.lines ?? digest.recent.length, lastEventAt: digest.lastEventAt, silentMs: digest.silentMs },
    ok: true,
    result: text,
  });
  return { digest, text };
}

/**
 * 运行前改任务需求：只改 DB + 重写任务文档，不碰进程。
 * 运行中、已结束的任务拒绝。
 */
export function updateTaskFields(
  store: Store,
  id: number,
  patch: TaskUpdateInput,
  deps: DispatchDeps,
  opts: TaskControlOptions = {},
): Task {
  const task = requireTask(store, id);
  if (taskIsRunning(task, deps.dataDir)) {
    throw new Error(`任务 #${id} 正在运行，不能直接改需求；运行中改方向用 interrupt。`);
  }
  if (isTerminal(task.status)) {
    throw new Error(`任务 #${id} 已是 ${task.status}，不能再改需求；需要继续请新建或重派任务。`);
  }
  const clean: TaskPatch = {};
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of TASK_UPDATE_FIELDS) {
    const value = patch[key];
    if (value === undefined) continue;
    (clean as any)[key] = value;
    changes[key] = { from: (task as any)[key], to: value };
  }
  if (!Object.keys(clean).length) throw new Error("没有要改的字段");
  const updated = updateTask(store, id, clean);
  writeTaskDoc(store, updated, {
    apiBase: deps.apiBase,
    runtimeDir: deps.runtimeDir,
    sharedDir: deps.sharedDir,
    businessDir: deps.businessDir,
  });
  const fields = Object.keys(clean).join(",");
  audit(store, opts, {
    taskId: id,
    action: "update",
    text: buildAuditLine("update", id, `fields=${fields}`),
    source: opts.source ?? "tool",
    args: { fields, changes },
    ok: true,
  });
  return getTask(store, id) ?? updated;
}

/** 带补充要求续跑；任务必须在跑过、已停下、有 session。 */
export async function resumeWithInstruction(
  store: Store,
  id: number,
  deps: DispatchDeps,
  instruction?: string,
  opts: TaskControlOptions = {},
): Promise<LaunchResult> {
  const task = requireTask(store, id);
  const text = String(instruction ?? "").trim();
  if (!String(task.session_id ?? "").trim()) {
    throw new Error(`任务 #${id} 没有 session_id，不能恢复；请先 start 或重新创建。`);
  }
  if (taskIsRunning(task, deps.dataDir)) {
    throw new Error(`任务 #${id} 正在运行；运行中改要求用 interrupt。`);
  }
  return withTaskLock(id, async () => {
    const detail = text ? quoteArg(text) : "";
    try {
      const resumed = await resumeTask(store, task, deps, text ? { instruction: text } : undefined);
      if (text) appendNote(store, id, `续跑要求：${text}`);
      appendTaskEvent(store, id, {
        text: text ? `续跑要求：${text}` : "恢复执行（未附补充要求）",
        sender: "dispatcher",
        senderName: "调度器",
        notify: false,
      });
      audit(store, opts, {
        taskId: id,
        action: "resume",
        text: buildAuditLine("resume", id, detail),
        source: opts.source ?? "tool",
        args: { instruction: text || null, attempt: resumed.task.attempt },
        ok: true,
        result: `session=${resumed.session_id} attempt=${resumed.task.attempt}`,
      });
      return resumed;
    } catch (e) {
      audit(store, opts, {
        taskId: id,
        action: "resume",
        text: buildAuditLine("resume", id, detail),
        source: opts.source ?? "tool",
        args: { instruction: text || null },
        ok: false,
        result: (e as Error).message,
      });
      throw e;
    }
  });
}

/**
 * 运行中追加要求：只接受 running；先停进程，再用同一 session 带要求续跑。
 * 没在跑直接拒绝，按“运行前改需求 / 已停下用 resume”处理。
 */
export async function interruptTask(
  store: Store,
  id: number,
  deps: DispatchDeps,
  instruction: string,
  opts: TaskControlOptions = {},
): Promise<LaunchResult> {
  const text = String(instruction ?? "").trim();
  if (!text) throw new Error("interrupt 要一段具体要求");
  const task = requireTask(store, id);
  if (!String(task.session_id ?? "").trim()) {
    throw new Error(`任务 #${id} 没有 session_id，不能在原上下文里追加要求。`);
  }
  if (!taskIsRunning(task, deps.dataDir)) {
    throw new Error(`任务 #${id} 没在运行；未启动的任务直接改需求，已停止的任务用 resume。`);
  }
  return withTaskLock(id, async () => {
    // 抢到锁后复查：等锁期间任务可能已经被别的动作停掉或跑完。
    const current = requireTask(store, id);
    if (!taskIsRunning(current, deps.dataDir)) {
      throw new Error(`任务 #${id} 没在运行；未启动的任务直接改需求，已停止的任务用 resume。`);
    }
    const pid = current.runner_pid;
    audit(store, opts, {
      taskId: id,
      action: "interrupt",
      text: buildAuditLine("interrupt", id, `${quoteArg(text)} pid=${pid ?? "（无）"}`),
      source: opts.source ?? "tool",
      args: { instruction: text, pid },
      ok: true,
    });
    // 必须等旧进程真的退出并清完 runner 状态，再续跑；否则新进程会被旧的清理逻辑覆盖。
    await stopTask(store, current, { dataDir: deps.dataDir, graceMs: deps.graceMs });
    appendNote(store, id, `中断续跑要求：${text}`);
    const fresh = requireTask(store, id);
    const resumed = await resumeTask(store, fresh, deps, { instruction: text });
    appendTaskEvent(store, id, {
      text: `已中断原执行（pid=${pid ?? "（无）"}），按新要求恢复（attempt=${resumed.task.attempt}）`,
      sender: "dispatcher",
      senderName: "调度器",
      notify: false,
    });
    audit(store, opts, {
      taskId: id,
      action: "interrupt",
      text: buildAuditLine("interrupt", id, `resumed attempt=${resumed.task.attempt}`),
      source: opts.source ?? "tool",
      args: { instruction: text, pid, attempt: resumed.task.attempt },
      ok: true,
      result: `session=${resumed.session_id}`,
    });
    return resumed;
  });
}

/** 只停执行器，不取消任务；停完任务回 pending。 */
export async function stopTaskWithAudit(
  store: Store,
  id: number,
  deps: DispatchDeps,
  opts: TaskControlOptions = {},
): Promise<Task> {
  const task = requireTask(store, id);
  return withTaskLock(id, async () => {
    const pid = task.runner_pid;
    try {
      const stopped = await stopTask(store, task, { dataDir: deps.dataDir, graceMs: deps.graceMs });
      audit(store, opts, {
        taskId: id,
        action: "stop",
        text: buildAuditLine("stop", id, `pid=${pid ?? "（无）"} status=${stopped.status}`),
        source: opts.source ?? "tool",
        args: { pid, status: stopped.status },
        ok: true,
      });
      return stopped;
    } catch (e) {
      audit(store, opts, {
        taskId: id,
        action: "stop",
        text: buildAuditLine("stop", id, `pid=${pid ?? "（无）"}`),
        source: opts.source ?? "tool",
        args: { pid },
        ok: false,
        result: (e as Error).message,
      });
      throw e;
    }
  });
}
