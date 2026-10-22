import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeClock } from "../src/core/clock.ts";
import { Scheduler } from "../src/core/scheduler.ts";
import type { Wake } from "../src/types.ts";

const cfg = { tickMs: 180_000, activeTickMs: 60_000, activeWindowMs: 600_000, debounceMs: 30_000, debounceMaxWaitMs: 120_000 };

function setup(over: Partial<typeof cfg> = {}) {
  const clock = new FakeClock();
  const wakes: Wake[] = [];
  const state = { paused: false, unread: [] as string[], plans: [] as Wake["planFires"] };
  const s = new Scheduler({ ...cfg, ...over }, {
    clock, queue: { enqueue: (w: Wake) => { wakes.push(w); return "queued" as const; } },
    isPaused: () => state.paused, poolsWithUnread: () => state.unread, duePlans: () => { const p = state.plans; state.plans = []; return p; },
  });
  return { clock, wakes, state, s };
}

test("去抖：连发多条，最后一条后静默 debounceMs 再唤醒，合并为一次", () => {
  const { clock, wakes, s } = setup();
  s.onMessage("p1", true, "私聊新消息");
  clock.advance(10_000); s.onMessage("p1", true, "私聊新消息");
  clock.advance(10_000); s.onMessage("p1", true, "私聊新消息");
  clock.advance(29_999);
  assert.equal(wakes.length, 0);
  clock.advance(1);
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].type, "message");
  assert.deepEqual([...wakes[0].pools], ["p1"]);
  assert.match(wakes[0].reasons[0], /合并3条/);
});

test("去抖有最长等待：一直有人说话也会在 debounceMaxWaitMs 内唤醒", () => {
  const { clock, wakes, s } = setup();
  for (let i = 0; i < 20; i++) { s.onMessage("p1", true, "x"); clock.advance(10_000); }
  assert.ok(wakes.length >= 1);
  assert.ok(wakes.length <= 2);
});

test("不同池各自去抖", () => {
  const { clock, wakes, s } = setup();
  s.onMessage("a", true, "x"); clock.advance(5_000); s.onMessage("b", true, "x");
  clock.advance(30_000);
  assert.deepEqual(wakes.map((w) => [...w.pools][0]), ["a", "b"]);
});

test("群里未被@：不立即唤醒，只在 tick 时读", () => {
  const { clock, wakes, s, state } = setup();
  s.start();
  s.onMessage("g1", false, "x");
  state.unread = ["g1"];
  clock.advance(59_999);
  assert.equal(wakes.length, 0);
  clock.advance(1); // 活跃期 tick 缩短为 60s
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].type, "tick");
  s.stop();
});

test("tick：没有未读不唤醒（不调用 LLM）；默认 3 分钟", () => {
  const { clock, wakes, s, state } = setup();
  s.start();
  clock.advance(180_000 * 3);
  assert.equal(wakes.length, 0);
  state.unread = ["p9"];
  clock.advance(180_000);
  assert.equal(wakes.length, 1);
  assert.equal(s.currentTickMs(), 180_000);
  s.stop();
});

test("活跃对话缩短 tick，静默后回到默认", () => {
  const { clock, s } = setup();
  s.start();
  s.markActive();
  assert.equal(s.currentTickMs(), 60_000);
  clock.advance(600_000);
  assert.equal(s.currentTickMs(), 180_000);
  s.stop();
});

test("tick 跳过正在去抖的池", () => {
  const { s, wakes, state } = setup();
  s.onMessage("p1", true, "x");
  state.unread = ["p1", "g2"];
  s.tick();
  assert.deepEqual([...wakes[0].pools], ["g2"]);
});

test("计划到点走队列；暂停时不唤醒", () => {
  const { s, wakes, state, clock } = setup();
  state.plans = [{ planId: 7, fireTs: 1 }];
  s.tick();
  assert.equal(wakes[0].type, "plan");
  state.paused = true;
  state.unread = ["p1"];
  assert.equal(s.tick(), false);
  s.onMessage("p1", true, "x");
  clock.advance(60_000);
  assert.equal(wakes.length, 1);
});
