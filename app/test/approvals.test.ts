/** 权限申请：创建 / 查询 / 裁决 / 重复 / 过期 / 列表过滤 / pending tick。 */
import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/db.ts";
import {
  ApprovalConflictError, createApproval, decideApproval, getApproval, listApprovals, sweepExpirations,
} from "../src/core/approvals.ts";
import { takePendingTick } from "../src/core/tasks.ts";

test("创建：pending、expires_at、默认 worker，创建置一次 pending tick", () => {
  const s = new Store(":memory:");
  let enqueued = 0;

  const a = createApproval(s, {
    taskId: 7, workerId: "wa-1", action: "shell: npm publish", detail: "/work", why: "发布",
    timeoutS: 30, now: 1000,
  }, () => { enqueued++; });

  assert.equal(a.status, "pending");
  assert.equal(a.task_id, 7);
  assert.equal(a.worker_id, "wa-1");
  assert.equal(a.action, "shell: npm publish");
  assert.equal(a.detail, "/work");
  assert.equal(a.why, "发布");
  assert.equal(a.created_at, 1000);
  assert.equal(a.expires_at, 31_000);
  assert.equal(a.decided_by, null);
  assert.equal(a.decided_at, null);
  assert.equal(enqueued, 1, "0→1 才唤醒");
  assert.deepEqual(getApproval(s, a.id), a);

  // 标记还在时再建一条：不重复唤醒
  createApproval(s, { action: "shell: ls", now: 1001 }, () => { enqueued++; });
  assert.equal(enqueued, 1);
  assert.equal(takePendingTick(s), 1000);

  // 消费之后再建一条：重新 0→1
  createApproval(s, { action: "shell: pwd", now: 1002 }, () => { enqueued++; });
  assert.equal(enqueued, 2);

  // 默认 600s
  const d = createApproval(s, { action: "shell: whoami", now: 2000 });
  assert.equal(d.expires_at - d.created_at, 600_000);

  s.close();
});

test("创建：缺 action、非法 task_id、非法 timeout_s 都报错", () => {
  const s = new Store(":memory:");
  assert.throws(() => createApproval(s, { action: "  " }), /action/);
  assert.throws(() => createApproval(s, { action: "x", taskId: -1 }), /task_id/);
  assert.throws(() => createApproval(s, { action: "x", taskId: 1.5 }), /task_id/);
  assert.throws(() => createApproval(s, { action: "x", timeoutS: 0 }), /timeout_s/);
  assert.throws(() => createApproval(s, { action: "x", timeoutS: -3 }), /timeout_s/);
  assert.equal(getApproval(s, 999999), null);
  s.close();
});

test("列表：status / task_id / limit 过滤", () => {
  const s = new Store(":memory:");
  const a = createApproval(s, { taskId: 1, action: "a1", now: 1000 });
  const b = createApproval(s, { taskId: 1, action: "a2", now: 2000 });
  const c = createApproval(s, { taskId: 2, action: "a3", now: 3000 });
  decideApproval(s, a.id, { decision: "approved", by: "u1", now: 4000 });

  assert.deepEqual(listApprovals(s).map((x) => x.id), [a.id, b.id, c.id]);
  assert.deepEqual(listApprovals(s, { status: "pending" }).map((x) => x.id), [b.id, c.id]);
  assert.deepEqual(listApprovals(s, { status: "approved" }).map((x) => x.id), [a.id]);
  assert.deepEqual(listApprovals(s, { taskId: 1 }).map((x) => x.id), [a.id, b.id]);
  assert.deepEqual(listApprovals(s, { taskId: 1, limit: 1 }).map((x) => x.id), [a.id]);
  assert.deepEqual(listApprovals(s, { status: "timeout" }), []);
  assert.throws(() => listApprovals(s, { status: "wat" as any }), /status/);
  assert.throws(() => listApprovals(s, { taskId: -1 }), /task_id/);

  s.close();
});

test("裁决：approved 写 decided_by/at，重复裁决冲突且不置 tick", () => {
  const s = new Store(":memory:");
  let enqueued = 0;
  const a = createApproval(s, { action: "shell: deploy", now: 1000 }, () => { enqueued++; });
  takePendingTick(s);
  enqueued = 0;

  const done = decideApproval(s, a.id, { decision: "approved", by: "u1", now: 5000 }, () => { enqueued++; });
  assert.equal(done.status, "approved");
  assert.equal(done.decided_by, "u1");
  assert.equal(done.decided_at, 5000);
  assert.equal(takePendingTick(s), null, "批准不是终态拒绝，不置 tick");
  assert.equal(enqueued, 0);

  assert.throws(
    () => decideApproval(s, a.id, { decision: "rejected", by: "u2", now: 6000 }),
    (e: unknown) => e instanceof ApprovalConflictError && /不能重复裁决/.test((e as Error).message),
  );
  assert.equal(getApproval(s, a.id)?.status, "approved");
  assert.equal(getApproval(s, a.id)?.decided_by, "u1");

  assert.throws(() => decideApproval(s, a.id, { decision: "approved", by: "" }), /by/);
  assert.throws(() => decideApproval(s, a.id, { decision: "maybe" as any, by: "u1" }), /decision/);
  assert.throws(() => decideApproval(s, 999999, { decision: "approved", by: "u1" }), /没有审批/);

  s.close();
});

test("裁决：rejected 是终态拒绝，置 pending tick（0→1 才唤醒）", () => {
  const s = new Store(":memory:");
  let enqueued = 0;
  const a = createApproval(s, { action: "shell: rm -rf build", now: 1000 }, () => { enqueued++; });
  takePendingTick(s);
  enqueued = 0;

  const done = decideApproval(s, a.id, { decision: "rejected", by: "u1", now: 2000 }, () => { enqueued++; });
  assert.equal(done.status, "rejected");
  assert.equal(enqueued, 1);
  assert.equal(takePendingTick(s), 2000);

  s.close();
});

test("过期：裁决时先落成 timeout 并冲突；sweep 只收过期 pending", () => {
  const s = new Store(":memory:");
  let enqueued = 0;
  const a = createApproval(s, { action: "shell: publish", timeoutS: 1, now: 1000 }, () => { enqueued++; });
  const b = createApproval(s, { action: "shell: later", timeoutS: 100, now: 1000 });
  takePendingTick(s);
  enqueued = 0;

  assert.throws(
    () => decideApproval(s, a.id, { decision: "approved", by: "u1", now: 2000 }, () => { enqueued++; }),
    (e: unknown) => e instanceof ApprovalConflictError && /过期/.test((e as Error).message),
  );
  assert.equal(getApproval(s, a.id)?.status, "timeout");
  assert.equal(getApproval(s, a.id)?.decided_at, 2000);
  assert.equal(getApproval(s, a.id)?.decided_by, null);
  assert.equal(enqueued, 1, "timeout 是终态拒绝，置一次 tick");
  takePendingTick(s);

  // 还没到期的 b 不动
  assert.equal(sweepExpirations(s, 50_000, () => { enqueued++; }), 0);
  assert.equal(getApproval(s, b.id)?.status, "pending");
  assert.equal(enqueued, 1);

  // b 到期后被扫成 timeout，置 tick；再扫不重复
  assert.equal(sweepExpirations(s, 101_000, () => { enqueued++; }), 1);
  assert.equal(getApproval(s, b.id)?.status, "timeout");
  assert.equal(getApproval(s, b.id)?.decided_at, 101_000);
  assert.equal(enqueued, 2);
  assert.equal(takePendingTick(s), 101_000);
  assert.equal(sweepExpirations(s, 200_000), 0);

  s.close();
});
