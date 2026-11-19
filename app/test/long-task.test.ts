/** 长任务提醒：running 超过 10 分钟在任务池写一次普通事件，算未读、会唤醒、不重复。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/db.ts";
import { createTask, updateTask } from "../src/core/tasks.ts";
import { listTaskEvents, setTaskEventNotifier } from "../src/core/task-events.ts";
import { sweepLongRunningTasks } from "../src/core/dispatch.ts";

const NOW = Date.parse("2026-11-11T03:00:00Z");

function setup(startedAt: number | null) {
  const store = new Store(":memory:");
  const task = createTask(store, {
    userId: "u1", poolId: "p1", name: "#长任务", goal: "跑一个很久的任务",
    work_dir: "/tmp", status: "running",
  });
  updateTask(store, task.id, {
    status: "running", runner_pid: 123, runner_started_at: startedAt,
  });
  return { store, task };
}

test("不到 10 分钟不提醒", () => {
  const { store } = setup(NOW - 9 * 60_000);
  const r = sweepLongRunningTasks(store, { now: NOW, thresholdMs: 10 * 60_000 });
  assert.deepEqual(r.warned, []);
  assert.equal(listTaskEvents(store, 1).filter((e) => e.sender === "调度器").length, 0);
});

test("到 10 分钟提醒一次，再扫不重复", () => {
  const { store, task } = setup(NOW - 10 * 60_000);
  const r = sweepLongRunningTasks(store, { now: NOW, thresholdMs: 10 * 60_000 });
  assert.deepEqual(r.warned, [task.id]);

  const events = listTaskEvents(store, task.id);
  assert.equal(events.length, 1);
  assert.match(events[0].text, /已持续 10 分钟，可能有异常/);
  assert.match(events[0].text, /勿回复此消息/);
  assert.ok(
    store.recentMessages(task.task_pool_id, 10).some((m) => /已持续 10 分钟/.test(m.text ?? "")),
    "提醒要进 UFA 的上下文（recentMessages 不能把它排掉）",
  );

  const again = sweepLongRunningTasks(store, { now: NOW + 60_000, thresholdMs: 10 * 60_000 });
  assert.deepEqual(again.warned, []);
  assert.equal(listTaskEvents(store, task.id).length, 1);
});

test("提醒是普通事件：算未读，能唤醒任务 tick", () => {
  const { store, task } = setup(NOW - 10 * 60_000);
  let notified = 0;
  setTaskEventNotifier(store, () => { notified += 1; });
  sweepLongRunningTasks(store, { now: NOW, thresholdMs: 10 * 60_000 });
  assert.equal(store.unread(task.task_pool_id).length, 1);
  assert.deepEqual(store.poolsWithUnread(), [task.task_pool_id]);
  assert.equal(notified, 1, "写事件后要通知调度器，让任务 tick 尽快跑");
  setTaskEventNotifier(store, null);
});

test("新一轮执行重置后可以再提醒一次", () => {
  const { store, task } = setup(NOW - 10 * 60_000);
  sweepLongRunningTasks(store, { now: NOW, thresholdMs: 10 * 60_000 });
  updateTask(store, task.id, { long_run_notified_at: null });
  const r = sweepLongRunningTasks(store, { now: NOW + 60_000, thresholdMs: 10 * 60_000 });
  assert.deepEqual(r.warned, [task.id]);
  assert.equal(listTaskEvents(store, task.id).length, 2);
});

test("thresholdMs=0 关闭提醒", () => {
  const { store } = setup(NOW - 60 * 60_000);
  const r = sweepLongRunningTasks(store, { now: NOW, thresholdMs: 0 });
  assert.deepEqual(r.warned, []);
});
