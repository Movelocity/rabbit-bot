import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/db.ts";
import { createTask, getTask, listTasksUpdatedSince, takePendingTick } from "../src/core/tasks.ts";
import {
  WorkerMismatchError, claimNextTask, completeTask, failTask, getWorker, listWorkers, registerWorker, sweepWorkers,
  touchTask,
} from "../src/core/workers.ts";

const mkTask = (s: Store, goal: string, startAt = 0) =>
  createTask(s, { userId: "u1", poolId: "p1", name: "#测试", goal, start_at: startAt });

test("worker：注册幂等，重复注册只更新状态与 last_seen", () => {
  const s = new Store(":memory:");
  const first = registerWorker(s, { workerId: "wa-1", name: "本地", kind: "wa", now: 1000 });
  assert.equal(first.worker_id, "wa-1");
  assert.equal(first.status, "online");
  assert.equal(first.registered_at, 1000);
  assert.equal(first.last_seen_at, 1000);

  const second = registerWorker(s, { workerId: "wa-1", name: "改名了", now: 2000 });
  assert.equal(second.name, "改名了");
  assert.equal(second.status, "online");
  assert.equal(second.registered_at, 1000, "注册时间保留第一次");
  assert.equal(second.last_seen_at, 2000);

  assert.equal(listWorkers(s).length, 1);
  assert.equal(getWorker(s, "wa-1")?.name, "改名了");
  assert.equal(getWorker(s, "nope"), null);

  assert.throws(() => registerWorker(s, { workerId: " ", name: "x" }), /worker_id/);
  assert.throws(() => registerWorker(s, { workerId: "wa-2", name: " " }), /name/);
  s.close();
});

test("worker：claim 只领一条，重复 claim 不会重复领，未到点不领", () => {
  const s = new Store(":memory:");
  registerWorker(s, { workerId: "wa-1", name: "本地", now: 10 });
  registerWorker(s, { workerId: "wa-2", name: "备用", now: 10 });
  const a = mkTask(s, "早", 0);
  const b = mkTask(s, "中", 0);
  const future = mkTask(s, "晚", 10_000);

  const first = claimNextTask(s, "wa-1", { now: 1000, leaseMs: 100 });
  assert.equal(first?.id, a.id);
  assert.equal(first?.status, "running");
  assert.equal(first?.worker_id, "wa-1");
  assert.equal(first?.claimed_at, 1000);
  assert.equal(first?.lease_until, 1100);
  assert.equal(first?.attempt, 1);
  assert.equal(getWorker(s, "wa-1")?.last_seen_at, 1000, "claim 顺带刷新 liveness");

  const second = claimNextTask(s, "wa-2", { now: 1001, leaseMs: 100 });
  assert.equal(second?.id, b.id);
  assert.equal(second?.worker_id, "wa-2");

  // 没有更多到点的 pending：future 还没到 start_at
  assert.equal(claimNextTask(s, "wa-1", { now: 1002 }), null);
  // 已经被领走的任务不会被第二次领到
  assert.equal(claimNextTask(s, "wa-2", { now: 1002 }), null);
  assert.equal(getTask(s, future.id)?.status, "pending");
  s.close();
});

test("worker：touch 续租并刷新 last_seen，非 running/非持有者被拒", () => {
  const s = new Store(":memory:");
  registerWorker(s, { workerId: "wa-1", name: "本地", now: 500 });
  registerWorker(s, { workerId: "wa-2", name: "备用", now: 500 });
  const t = mkTask(s, "租约测试");
  claimNextTask(s, "wa-1", { now: 1000, leaseMs: 100 });

  const touched = touchTask(s, t.id, "wa-1", { now: 1050, leaseMs: 100 });
  assert.equal(touched?.lease_until, 1150);
  assert.equal(getWorker(s, "wa-1")?.last_seen_at, 1050);
  assert.throws(() => touchTask(s, t.id, "wa-2"), WorkerMismatchError);

  completeTask(s, t.id, { workerId: "wa-1", now: 1200 });
  assert.equal(touchTask(s, t.id, "wa-1", { now: 1300 }), null, "done 之后不再续租");
  assert.equal(touchTask(s, 99999, "wa-1"), null);
  s.close();
});

test("worker：完成写 done/end_at/清 lease，并置 pending tick", () => {
  const s = new Store(":memory:");
  registerWorker(s, { workerId: "wa-1", name: "本地", now: 500 });
  const t = mkTask(s, "租约测试");
  claimNextTask(s, "wa-1", { now: 1000, leaseMs: 100 });

  let enqueued = 0;
  const done = completeTask(s, t.id, {
    workerId: "wa-1", result: "纪要写好了", artifact: "notes.md", note: "已交付", now: 2000,
  }, () => { enqueued++; });
  assert.equal(done.status, "done");
  assert.equal(done.result, "纪要写好了");
  assert.equal(done.artifact, "notes.md");
  assert.equal(done.note, "已交付");
  assert.equal(done.end_at, 2000);
  assert.equal(done.lease_until, null);
  assert.equal(done.worker_id, "wa-1");
  assert.equal(enqueued, 1);

  assert.throws(() => completeTask(s, t.id, { workerId: "wa-1", now: 2100 }), /不在运行/);
  assert.throws(() => completeTask(s, 99999, { workerId: "wa-1" }), /没有任务/);
  s.close();
});

test("worker：fail retryable 回 pending 清归属，非 retryable 置 failed", () => {
  const s = new Store(":memory:");
  registerWorker(s, { workerId: "wa-1", name: "本地", now: 500 });

  const retry = mkTask(s, "重试我");
  claimNextTask(s, "wa-1", { now: 1000, leaseMs: 100 });
  let enqueued = 0;
  const back = failTask(s, retry.id, { workerId: "wa-1", error: "网络抖了", retryable: true, now: 1100 }, () => { enqueued++; });
  assert.equal(back.status, "pending");
  assert.equal(back.worker_id, null);
  assert.equal(back.claimed_at, null);
  assert.equal(back.lease_until, null);
  assert.match(back.note, /网络抖了/);
  assert.equal(enqueued, 0, "回 pending 不是终态，不置 tick");

  const again = claimNextTask(s, "wa-1", { now: 1200, leaseMs: 100 });
  assert.equal(again?.id, retry.id);
  assert.equal(again?.attempt, 2, "重试后 attempt 继续累加");

  const dead = mkTask(s, "别重试");
  claimNextTask(s, "wa-1", { now: 2000, leaseMs: 100 });
  const failed = failTask(s, dead.id, { workerId: "wa-1", error: "脚本炸了", retryable: false, now: 2100 }, () => { enqueued++; });
  assert.equal(failed.status, "failed");
  assert.equal(failed.result, "脚本炸了");
  assert.match(failed.note, /失败：脚本炸了/);
  assert.equal(failed.end_at, 2100);
  assert.equal(failed.lease_until, null);
  assert.equal(enqueued, 1);

  assert.throws(() => failTask(s, dead.id, { workerId: "wa-1" }), /不在运行/);
  assert.throws(() => failTask(s, 99999, { workerId: "wa-1" }), /没有任务/);
  s.close();
});

test("worker：sweep 把超过阈值的 online 置 offline", () => {
  const s = new Store(":memory:");
  registerWorker(s, { workerId: "wa-1", name: "本地", now: 1000 });

  assert.equal(sweepWorkers(s, { staleMs: 1000, now: 1500 }), 0);
  assert.equal(getWorker(s, "wa-1")?.status, "online");

  assert.equal(sweepWorkers(s, { staleMs: 1000, now: 3000 }), 1);
  assert.equal(getWorker(s, "wa-1")?.status, "offline");

  registerWorker(s, { workerId: "wa-1", name: "本地", now: 4000 });
  assert.equal(getWorker(s, "wa-1")?.status, "online");
  s.close();
});

test("pending tick：多任务完成只 enqueue 一次，一次消费多条，消费后可重新置位", () => {
  const s = new Store(":memory:");
  registerWorker(s, { workerId: "wa-1", name: "本地", now: 100 });
  const ids = [mkTask(s, "A"), mkTask(s, "B"), mkTask(s, "C")].map((t) => t.id);

  let enqueued = 0;
  const enqueue = () => { enqueued++; };
  let tick = 1000;
  for (const id of ids) {
    claimNextTask(s, "wa-1", { now: tick, leaseMs: 100 });
    completeTask(s, id, { workerId: "wa-1", result: `done-${id}`, now: tick + 1 }, enqueue);
    tick += 2;
  }

  assert.equal(enqueued, 1, "三个任务先后完成只产生一次唤醒");
  const setAt = takePendingTick(s);
  assert.equal(setAt, 1001, "游标保留第一次置位时间");
  const batch = listTasksUpdatedSince(s, setAt!, ["done", "failed", "blocked"]);
  assert.deepEqual(batch.map((t) => t.id).sort((a, b) => a - b), [...ids].sort((a, b) => a - b));
  assert.equal(takePendingTick(s), null, "取一次就删掉");

  const d = mkTask(s, "D");
  claimNextTask(s, "wa-1", { now: 2000, leaseMs: 100 });
  completeTask(s, d.id, { workerId: "wa-1", now: 2001 }, enqueue);
  assert.equal(enqueued, 2, "消费完成后新的完成会重新置位");
  assert.equal(takePendingTick(s), 2001);
  s.close();
});
