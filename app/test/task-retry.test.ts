import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/db.ts";
import { createTask, getTask, listTasks, updateTask } from "../src/core/tasks.ts";
import { listTaskEvents } from "../src/core/task-events.ts";
import { retryTask } from "../src/core/task-retry.ts";

function mk(s: Store, extra: Record<string, unknown> = {}) {
  return createTask(s, { userId: "u1", poolId: "p1", name: "#重派", goal: "跑一下", work_dir: "/tmp", ...extra });
}

test("重派：复用同一条任务，回到待审批、清运行态，任务总数不变", () => {
  const s = new Store(":memory:");
  const t = mk(s);
  updateTask(s, t.id, {
    status: "cancelled", stage: "working", worker_id: "opencode-1", claimed_at: 1,
    runner_pid: 123, runner_started_at: 1, end_at: 2, result: "旧结论", artifact: "/tmp/old",
  });

  const retried = retryTask(s, t.id);
  assert.equal(retried.id, t.id);
  assert.equal(retried.status, "pending_approval");
  assert.equal(retried.stage, "");
  assert.equal(retried.worker_id, null);
  assert.equal(retried.runner_pid, null);
  assert.equal(retried.end_at, null);
  assert.equal(retried.result, "");
  assert.equal(retried.artifact, "");
  assert.equal(retried.attempt, t.attempt, "尝试次数在真正拉起执行器时才 +1");
  assert.equal(listTasks(s, { userId: "u1" }).length, 1, "不新建任务");

  const events = listTaskEvents(s, t.id);
  assert.ok(events.some((e) => /重派/.test(e.text) && /第 1 次尝试/.test(e.text)));

  s.close();
});

test("重派：运行中或已在待审批都拒绝", () => {
  const s = new Store(":memory:");
  const running = mk(s);
  updateTask(s, running.id, { status: "running" });
  assert.throws(() => retryTask(s, running.id), /正在运行/);

  const pending = mk(s);
  updateTask(s, pending.id, { status: "pending_approval" });
  assert.throws(() => retryTask(s, pending.id), /已在等待审批/);

  assert.throws(() => retryTask(s, 999999), /没有任务/);
  s.close();
});

test("重派：失败任务重派后仍是同一条，失败结论留在事件里", () => {
  const s = new Store(":memory:");
  const t = mk(s);
  updateTask(s, t.id, { status: "failed", result: "失败：超时", note: "失败：超时" });
  const retried = retryTask(s, t.id);
  assert.equal(retried.id, t.id);
  assert.equal(getTask(s, t.id)?.status, "pending_approval");
  assert.equal(listTasks(s, { userId: "u1" }).length, 1);
  s.close();
});
