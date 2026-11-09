import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/db.ts";
import {
  appendNote, cancelTask, createTask, getTask, isTaskStatus, listTasks, normalizeTaskName, TASK_NAME_MAX,
  TASK_STATUSES, updateTask, type CreateTaskInput,
} from "../src/core/tasks.ts";

const mk = (s: Store, goal: string, extra: Partial<CreateTaskInput> = {}) =>
  createTask(s, { userId: "u1", poolId: "p1", name: "#测试", goal, ...extra });

test("任务：建 → 查 → 列 → 改状态 → 追加 note → 取消", () => {
  const s = new Store(":memory:");
  const t = mk(s, "整理会议纪要", {
    deliverable: "notes.md",
    constraints: "只读不写",
    acceptance: "有结论和待办",
    files: ["a.txt", "b.txt"],
  });

  assert.equal(t.id > 0, true);
  assert.equal(t.status, "pending");
  assert.equal(t.goal, "整理会议纪要");
  assert.equal(t.files, JSON.stringify(["a.txt", "b.txt"]));
  assert.equal(t.start_at, t.created_at);
  assert.equal(t.end_at, null);

  assert.equal(getTask(s, t.id)?.id, t.id);
  assert.deepEqual(listTasks(s, { userId: "u1" }).map((x) => x.id), [t.id]);
  assert.deepEqual(listTasks(s, { status: "running" }), []);

  const running = updateTask(s, t.id, { status: "running" });
  assert.equal(running.status, "running");
  assert.ok(running.updated_at >= t.updated_at);

  const n1 = appendNote(s, t.id, "卡在等权限");
  assert.equal(n1.note, "卡在等权限");
  const n2 = appendNote(s, t.id, "已拿到权限");
  assert.equal(n2.note, "卡在等权限\n已拿到权限");
  assert.ok(n2.updated_at >= n1.updated_at);

  const cancelled = cancelTask(s, t.id);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.note, n2.note);
  assert.equal(cancelled.end_at, null, "取消只改 status，不伪造结束时间");

  s.close();
});

test("任务：缺 goal、非法 status、不存在的 id 都报错", () => {
  const s = new Store(":memory:");

  assert.throws(() => createTask(s, { userId: "u1", poolId: "p1", name: "#x", goal: "  " }), /goal/);
  assert.throws(() => createTask(s, { userId: "u1", poolId: "p1", name: "#x", goal: "x", status: "wat" as any }), /status/);

  const t = mk(s, "跑一下");
  assert.throws(() => updateTask(s, t.id, { status: "wat" as any }), /status/);
  assert.throws(() => appendNote(s, t.id, "   "), /note/);
  assert.throws(() => updateTask(s, 999999, { status: "done" }), /没有任务/);
  assert.throws(() => appendNote(s, 999999, "hello"), /没有任务/);
  assert.throws(() => cancelTask(s, 999999), /没有任务/);

  assert.equal(getTask(s, 999999), null);
  assert.equal(isTaskStatus("pending"), true);
  assert.equal(isTaskStatus("wat"), false);
  assert.deepEqual(TASK_STATUSES, ["pending", "running", "blocked", "done", "failed", "cancelled"]);

  s.close();
});

test("任务：dueBefore 只按 start_at 过滤，limit 生效", () => {
  const s = new Store(":memory:");
  const a = mk(s, "早", { start_at: 1000 });
  const b = mk(s, "中", { start_at: 2000 });
  const c = mk(s, "晚", { start_at: 3000 });

  assert.deepEqual(listTasks(s, { dueBefore: 2000 }).map((x) => x.id), [a.id, b.id]);
  assert.deepEqual(listTasks(s, { dueBefore: 500 }).map((x) => x.id), []);
  assert.deepEqual(listTasks(s, { dueBefore: 3000, limit: 2 }).map((x) => x.id), [a.id, b.id]);
  assert.deepEqual(listTasks(s, { limit: 1 }).map((x) => x.id), [a.id]);

  assert.equal(c.start_at, 3000);
  s.close();
});

test("任务名：自动补 #、空白拒绝、超长截断", () => {
  const s = new Store(":memory:");

  assert.equal(normalizeTaskName("发票修复"), "#发票修复");
  assert.equal(normalizeTaskName("  #发票修复  "), "#发票修复");
  assert.equal(normalizeTaskName(" #发票修复"), "#发票修复");
  assert.throws(() => normalizeTaskName("   "), /短任务名/);
  assert.throws(() => createTask(s, { userId: "u1", poolId: "p1", name: "   ", goal: "x" }), /短任务名/);

  const long = "一".repeat(TASK_NAME_MAX + 8);
  assert.equal(normalizeTaskName(long).length, TASK_NAME_MAX);
  assert.equal(normalizeTaskName(long).startsWith("#"), true);

  const noHash = createTask(s, { userId: "u1", poolId: "p1", name: "发票修复", goal: "修复发票" });
  assert.equal(noHash.name, "#发票修复");
  const withHash = createTask(s, { userId: "u1", poolId: "p1", name: "#对账", goal: "对账" });
  assert.equal(withHash.name, "#对账");

  s.close();
});
