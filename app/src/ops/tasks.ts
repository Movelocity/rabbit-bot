/** 任务面板只读格式化：API / Web 共用，不写库。 */
import type { Store } from "../core/db.ts";
import type { Task, TaskFilter } from "../core/tasks.ts";
import { getTask, listTasks, taskDisplayName } from "../core/tasks.ts";
import { listTaskEvents } from "../core/task-events.ts";
import { fmtLocal } from "../core/time.ts";

export function formatTask(t: Task) {
  return {
    id: t.id,
    name: taskDisplayName(t),
    goal: t.goal,
    pool_id: t.pool_id,
    task_pool_id: t.task_pool_id,
    status: t.status,
    stage: t.stage,
    worker_id: t.worker_id,
    note: t.note,
    deliverable: t.deliverable,
    constraints: t.constraints,
    acceptance: t.acceptance,
    result: t.result,
    artifact: t.artifact,
    work_dir: t.work_dir,
    executor: t.executor,
    model: t.model,
    session_id: t.session_id,
    runner_pid: t.runner_pid,
    runner_started_at: t.runner_started_at,
    doc_path: t.doc_path,
    start_at: t.start_at,
    start_at_local: fmtLocal(t.start_at),
    end_at: t.end_at,
    end_at_local: t.end_at === null ? null : fmtLocal(t.end_at),
    updated_at: t.updated_at,
    updated_at_local: fmtLocal(t.updated_at),
  };
}

export function listTaskViews(store: Store, filter: TaskFilter = {}) {
  return listTasks(store, filter).map(formatTask);
}

export function getTaskView(store: Store, id: number, opts: { recentEvents?: number } = {}) {
  let t = getTask(store, id);
  if (!t) return null;
  const view: ReturnType<typeof formatTask> & { recent_events?: ReturnType<typeof listTaskEvents> } = formatTask(t);
  if (opts.recentEvents !== undefined) {
    view.recent_events = listTaskEvents(store, id, { limit: opts.recentEvents });
    t = getTask(store, id) ?? t;
    view.task_pool_id = t.task_pool_id;
  }
  return view;
}
