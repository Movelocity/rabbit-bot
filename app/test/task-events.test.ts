/** 任务池：建池、WA 动作落事件、时间戳正序。 */
import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/db.ts";
import { createTask, ensureTaskPool, getTask, updateTask } from "../src/core/tasks.ts";
import { completeTask, failTask, progressTask } from "../src/core/workers.ts";
import { createApproval, decideApproval } from "../src/core/approvals.ts";
import { appendTaskEvent, listTaskEvents } from "../src/core/task-events.ts";
import { formatTask } from "../src/ops/tasks.ts";

test("createTask 自动建任务池：platform/external_id/kind/title 正确，重复 ensure 不新建", () => {
  const s = new Store(":memory:");
  const t = createTask(s, { userId: "u1", poolId: "p1", name: "#纪要", goal: "整理会议纪要，产出一份带待办的 notes.md" });

  assert.ok(t.task_pool_id, "createTask 要写回 task_pool_id");
  const pool = s.getPool(t.task_pool_id)!;
  assert.equal(pool.platform, "task");
  assert.equal(pool.external_id, `task:${t.id}`);
  assert.equal(pool.kind, "task");
  assert.equal(pool.title, "#纪要", "任务池标题直接用短任务名");

  const count = s.listPools().length;
  const again = ensureTaskPool(s, t.id);
  assert.equal(again.task_pool_id, t.task_pool_id);
  assert.equal(s.listPools().length, count, "同一任务不重复建池");

  s.close();
});

test("老任务没有 name：展示和池标题回退成 #任务<id>，不报错", () => {
  const s = new Store(":memory:");
  const t = createTask(s, { userId: "u1", poolId: "p1", name: "#临时", goal: "老任务" });
  s.db.prepare("UPDATE tasks SET name='', task_pool_id='' WHERE id=?").run(t.id);

  const fresh = getTask(s, t.id)!;
  assert.equal(formatTask(fresh).name, `#任务${t.id}`);

  const ensured = ensureTaskPool(s, t.id);
  assert.equal(s.getPool(ensured.task_pool_id)?.title, `#任务${t.id}`);

  s.close();
});

test("progress/complete 都写事件，时间戳递增且带本地时间", () => {
  const s = new Store(":memory:");
  const t = createTask(s, { userId: "u1", poolId: "p1", name: "#验收", goal: "跑验收", start_at: 0 });
  updateTask(s, t.id, { status: "running", worker_id: "opencode-1" });

  progressTask(s, t.id, { workerId: "opencode-1", stage: "fetch", note: "正在拉数据", now: 2000 });
  completeTask(s, t.id, { workerId: "opencode-1", result: "全部通过", artifact: "report.md", now: 3000 });

  const events = listTaskEvents(s, t.id);
  assert.deepEqual(events.map((e) => e.ts), [2000, 3000]);
  assert.match(events[0].text, /阶段 fetch/);
  assert.match(events[0].text, /正在拉数据/);
  assert.match(events[1].text, /任务完成：全部通过/);
  assert.match(events[1].text, /report\.md/);
  for (const e of events) assert.match(e.local, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(events[0].sender, "opencode-1", "sender 用 worker_id");

  s.close();
});

test("fail：retryable 写「失败，可重试」，非 retryable 写「任务失败」", () => {
  const s = new Store(":memory:");
  const t = createTask(s, { userId: "u1", poolId: "p1", name: "#会失败", goal: "会失败", start_at: 0 });

  updateTask(s, t.id, { status: "running", worker_id: "opencode-1" });
  failTask(s, t.id, { workerId: "opencode-1", error: "网络抖了", retryable: true, now: 2000 });
  let events = listTaskEvents(s, t.id, { limit: 1 });
  assert.match(events[0].text, /失败，可重试/);
  assert.match(events[0].text, /网络抖了/);

  updateTask(s, t.id, { status: "running", worker_id: "opencode-1" });
  failTask(s, t.id, { workerId: "opencode-1", error: "脚本炸了", retryable: false, now: 4000 });
  events = listTaskEvents(s, t.id, { limit: 1 });
  assert.match(events[0].text, /任务失败：脚本炸了/);

  const all = listTaskEvents(s, t.id);
  assert.deepEqual(all.map((e) => e.ts), [2000, 4000], "重试后继续按时间正序追加");

  s.close();
});

test("审批创建/裁决写进任务池；没有对应任务时不影响审批本身", () => {
  const s = new Store(":memory:");
  const t = createTask(s, { userId: "u1", poolId: "p1", name: "#权限", goal: "需要权限" });

  const a = createApproval(s, {
    taskId: t.id, workerId: "wa-1", action: "shell: npm publish", why: "发布产物", timeoutS: 60, now: 1000,
  });
  decideApproval(s, a.id, { decision: "approved", by: "u1", now: 2000 });

  const events = listTaskEvents(s, t.id);
  assert.equal(events.length, 2);
  assert.match(events[0].text, /申请权限：shell: npm publish/);
  assert.match(events[0].text, /发布产物/);
  assert.equal(events[1].text, "权限已批准（by u1）");

  // 不存在的 task_id 只是没有任务池可写，不应让审批失败
  const orphan = createApproval(s, { taskId: 9999, action: "shell: ls", now: 3000 });
  assert.equal(orphan.status, "pending");

  s.close();
});

test("老任务没有 task_pool_id 时，读写事件会自动补齐池", () => {
  const s = new Store(":memory:");
  const t = createTask(s, { userId: "u1", poolId: "p1", name: "#老数据", goal: "老数据" });
  s.db.prepare("UPDATE tasks SET task_pool_id='' WHERE id=?").run(t.id);

  const e = appendTaskEvent(s, t.id, { text: "补一条", sender: "wa-1", ts: 1000 });
  assert.ok(e.seq > 0);
  const fresh = getTask(s, t.id)!;
  assert.ok(fresh.task_pool_id, "写事件时补回 task_pool_id");
  assert.equal(s.getPool(fresh.task_pool_id)?.external_id, `task:${t.id}`);
  assert.equal(listTaskEvents(s, t.id).length, 1);

  s.close();
});
