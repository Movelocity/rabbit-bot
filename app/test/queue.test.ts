import { test } from "node:test";
import assert from "node:assert/strict";
import { RunQueue, makeWake } from "../src/core/queue.ts";
import type { Wake } from "../src/types.ts";

const tick = () => new Promise((r) => setTimeout(r, 5));

test("单实例：同一时间只运行一个，FIFO", async () => {
  let running = 0, maxRunning = 0;
  const order: string[] = [];
  const q = new RunQueue(async (w) => { running++; maxRunning = Math.max(maxRunning, running); order.push(w.type); await tick(); running--; });
  q.enqueue(makeWake("message", ["a"]));
  q.enqueue(makeWake("tick", ["b"]));
  q.enqueue(makeWake("plan", [], "", [{ planId: 1, fireTs: 1 }]));
  await q.idle();
  assert.equal(maxRunning, 1);
  assert.deepEqual(order, ["message", "tick", "plan"]);
});

test("排队中的同类唤醒合并；运行中的不合并", async () => {
  const seen: Wake[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const q = new RunQueue(async (w) => { seen.push(w); if (seen.length === 1) await gate; });
  q.enqueue(makeWake("message", ["a"], "r1"));
  await tick(); // 第一个开始运行
  assert.equal(q.enqueue(makeWake("message", ["b"], "r2")), "queued");
  assert.equal(q.enqueue(makeWake("tick", ["x"])), "queued");
  assert.equal(q.enqueue(makeWake("message", ["c"], "r2")), "merged");
  assert.equal(q.enqueue(makeWake("plan", [], "", [{ planId: 1, fireTs: 5 }])), "queued");
  assert.equal(q.enqueue(makeWake("plan", [], "", [{ planId: 1, fireTs: 5 }, { planId: 2, fireTs: 5 }])), "merged");
  release();
  await q.idle();
  assert.deepEqual(seen.map((w) => w.type), ["message", "message", "tick", "plan"]);
  assert.deepEqual([...seen[1].pools], ["b", "c"]);
  assert.deepEqual(seen[1].reasons, ["r2"]);
  assert.equal(seen[3].planFires.length, 2);
});

test("handler 抛错不影响后续", async () => {
  const done: string[] = [];
  const q = new RunQueue(async (w) => { if (w.type === "tick") throw new Error("x"); done.push(w.type); });
  q.onError = () => {};
  q.enqueue(makeWake("tick"));
  q.enqueue(makeWake("message"));
  await q.idle();
  assert.deepEqual(done, ["message"]);
});
