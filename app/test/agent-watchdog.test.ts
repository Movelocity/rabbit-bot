/** 发完消息后的看门狗：静默 10s、有人接话就不动、冷却和重置。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeClock } from "../src/core/clock.ts";
import { Store } from "../src/core/db.ts";
import { Logger } from "../src/core/logger.ts";
import { AgentWatchdog } from "../src/core/agent-watchdog.ts";
import type { WatchdogSettings } from "../src/ops/watchdog-settings.ts";

const flush = () => new Promise<void>((r) => setImmediate(r));

function setup(opts: { enabled?: boolean; cooldownMs?: number; paused?: boolean } = {}) {
  const clock = new FakeClock();
  const store = new Store(":memory:");
  const log = new Logger(null, true);
  const reviews: number[] = [];
  const nudges: { pool: string; reason: string }[] = [];
  let seq = 0;
  const insert = (pool: string, text: string, fromSelf: boolean, kind: "private" | "group" | "task" = "private") => {
    const m = store.insertMessage({
      platform: "mock", external_chat_id: pool, pool_kind: kind, pool_title: pool,
      msg_id: `${pool}-${++seq}`, sender_id: fromSelf ? "self" : "u1", sender_name: fromSelf ? "bot" : "user",
      ts: clock.now(), text, reply_to: null, mentions: [], is_mention_me: false,
      media_type: "text", from_self: fromSelf,
    });
    assert.ok(m);
    return m!;
  };
  const settings: WatchdogSettings = {
    enabled: opts.enabled ?? true,
    delayMs: 10_000,
    cooldownMs: opts.cooldownMs ?? 600_000,
  };
  const wd = new AgentWatchdog({
    clock, store, log,
    settings: () => settings,
    isPaused: () => !!opts.paused,
    review: async (_pool, last) => {
      reviews.push(last.seq);
      return { execute: true, reason: "ready" };
    },
    nudge: (pool, reason) => { nudges.push({ pool, reason }); },
  });
  return { clock, store, settings, wd, reviews, nudges, insert };
}

test("静默满 10s 才复核；复核通过后插系统消息并立即唤醒", async () => {
  const t = setup();
  t.insert("p1", "要我先建任务吗？", true);
  const self = t.insert("p1", "万事俱备，你说声就派。", true);
  t.wd.onSent(self.pool_id, self.seq);
  t.clock.advance(9_999);
  assert.equal(t.reviews.length, 0, "没到 10s 不打扰");
  t.clock.advance(1);
  await flush();
  assert.deepEqual(t.reviews, [self.seq]);
  assert.equal(t.nudges.length, 1);
  assert.equal(t.nudges[0].pool, self.pool_id);
});

test("10s 内有人接话：看门狗不复核", async () => {
  const t = setup();
  const self = t.insert("p1", "等你点头我就派。", true);
  t.wd.onSent(self.pool_id, self.seq);
  t.clock.advance(5_000);
  t.insert("p1", "行，去办", false);
  t.clock.advance(5_000);
  await flush();
  assert.equal(t.reviews.length, 0, "用户已经接上了，不需要看门狗");
  assert.equal(t.nudges.length, 0);
});

test("关掉开关：不排计时器", async () => {
  const t = setup({ enabled: false });
  const self = t.insert("p1", "等你点头。", true);
  t.wd.onSent(self.pool_id, self.seq);
  assert.deepEqual(t.wd.pending(), []);
  t.clock.advance(20_000);
  await flush();
  assert.equal(t.reviews.length, 0);
});

test("同池冷却：第一次放行后，冷却期内不再放行", async () => {
  const t = setup({ cooldownMs: 60_000 });
  const first = t.insert("p1", "第一次等你点头。", true);
  t.wd.onSent(first.pool_id, first.seq);
  t.clock.advance(10_000);
  await flush();
  assert.equal(t.nudges.length, 1);

  const second = t.insert("p1", "第二次等你点头。", true);
  t.wd.onSent(second.pool_id, second.seq);
  t.clock.advance(10_000);
  await flush();
  assert.equal(t.reviews.length, 1, "冷却期内不重复复核");
  assert.equal(t.nudges.length, 1);
});

test("同池后发消息会重置计时，只复核最后一条", async () => {
  const t = setup();
  const first = t.insert("p1", "第一句等你点头。", true);
  t.wd.onSent(first.pool_id, first.seq);
  t.clock.advance(5_000);
  const second = t.insert("p1", "第二句等你点头。", true);
  t.wd.onSent(second.pool_id, second.seq);
  t.clock.advance(10_000);
  await flush();
  assert.deepEqual(t.reviews, [second.seq], "旧计时器不该拿第一条去复核");
});

test("任务池和日程池不跑看门狗", async () => {
  const t = setup();
  const self = t.insert("task-1", "任务进度。", true, "task");
  t.wd.onSent(self.pool_id, self.seq);
  assert.deepEqual(t.wd.pending(), []);
  t.clock.advance(20_000);
  await flush();
  assert.equal(t.reviews.length, 0);
});

test("暂停时不复核", async () => {
  const t = setup({ paused: true });
  const self = t.insert("p1", "等你点头。", true);
  t.wd.onSent(self.pool_id, self.seq);
  t.clock.advance(10_000);
  await flush();
  assert.equal(t.reviews.length, 0);
});
