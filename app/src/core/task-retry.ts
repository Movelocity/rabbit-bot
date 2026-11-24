/**
 * 重派（需求 R2）：复用同一条任务开新一轮尝试，不新建任务。
 *
 * 重派只把任务退回 pending_approval，清掉上一轮的运行态；真正的 tries+1 在
 * dispatch.launch() 拉起执行器时发生。每一轮的起止时间和结论都在 task_events 里
 * 按「第 N 次尝试」留痕，任务总数不变，项目页只显示一条。
 */
import type { Store } from "./db.ts";
import { appendTaskEvent } from "./task-events.ts";
import { getTask, type Task } from "./tasks.ts";

export function retryTask(store: Store, id: number, opts: { now?: number } = {}): Task {
  const task = getTask(store, id);
  if (!task) throw new Error(`没有任务 #${id}`);
  if (task.status === "running") throw new Error(`任务 #${id} 正在运行，先停止再重派`);
  if (task.status === "pending_approval") throw new Error(`任务 #${id} 已在等待审批，无需重派`);
  const now = opts.now ?? Date.now();
  store.db.prepare(`UPDATE tasks SET
    status='pending_approval', stage='', worker_id=NULL, claimed_at=NULL, lease_until=NULL,
    runner_pid=NULL, runner_started_at=NULL, long_run_notified_at=NULL, end_at=NULL,
    result='', artifact='', updated_at=?
    WHERE id=?`).run(now, id);
  appendTaskEvent(store, id, {
    text: `重派：复用本条任务，回到待审批（下一轮为第 ${task.attempt + 1} 次尝试）`,
    sender: "dispatcher",
    senderName: "调度器",
    ts: now,
  });
  return getTask(store, id)!;
}
