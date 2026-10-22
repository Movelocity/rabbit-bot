/** 复现 12:04~12:09 的事故：VM 被冻结约 221s，单调时钟上的定时器一起被推迟；看门狗按墙上时间补触发 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeClock } from "../src/core/clock.ts";
import { Scheduler } from "../src/core/scheduler.ts";
import { FeishuAdapter } from "../src/adapters/feishu.ts";
import { Logger } from "../src/core/logger.ts";
import type { Wake, InboundMessage } from "../src/types.ts";

const base = { tickMs: 180_000, activeTickMs: 60_000, activeWindowMs: 600_000, debounceMs: 30_000, debounceMaxWaitMs: 120_000 };

function setup(over: Record<string, unknown> = {}) {
  const clock = new FakeClock();
  const wakes: Wake[] = [];
  const logs: string[] = [];
  const state = { unread: [] as string[], planThrows: 0 };
  const s = new Scheduler({ ...base, watchdogMs: 5_000, overdueGraceMs: 2_000, ...over } as any, {
    clock, queue: { enqueue: (w: Wake) => { wakes.push(w); return "queued" as const; } },
    isPaused: () => false, poolsWithUnread: () => state.unread,
    duePlans: () => { if (state.planThrows > 0) { state.planThrows--; throw new Error("db busy"); } return []; },
    log: (m) => logs.push(m), warn: (m) => logs.push("WARN " + m),
  });
  s.start();
  return { clock, wakes, logs, state, s };
}

test("VM 冻结：去抖定时器被推迟时，看门狗在恢复后 ≤5s 内补触发，并记录暂停", () => {
  const { clock, wakes, logs, s } = setup();
  s.onMessage("p1", true, "私聊新消息");
  clock.advance(6_000);
  clock.freeze(221_000); // 墙上时间走了 221s，定时器没动
  assert.equal(wakes.length, 0);
  clock.advance(5_000);
  assert.equal(wakes.length, 1, "恢复后看门狗立即补触发，而不是再等 24s");
  assert.equal(wakes[0].type, "message");
  assert.ok(logs.some((l) => l.includes("看门狗补触发")), logs.join("\n"));
  assert.ok(logs.some((l) => l.startsWith("WARN 检测到时钟跳变")), logs.join("\n"));
  assert.equal(s.stats().pausesDetected, 1);
  clock.advance(60_000); // 原定时器若残留也不会重复唤醒
  assert.equal(wakes.filter((w) => w.type === "message").length, 1);
});

test("VM 冻结：逾期的 tick 也补触发，且之后 tick 链继续", () => {
  const { clock, wakes, state, s } = setup();
  s.markActive(); // 活跃期 60s tick
  state.unread = ["g1"];
  clock.advance(50_000);
  clock.freeze(300_000);
  clock.advance(5_000);
  assert.equal(wakes.filter((w) => w.type === "tick").length, 1, "看门狗补 tick");
  clock.advance(60_000);
  assert.equal(wakes.filter((w) => w.type === "tick").length, 2, "tick 链没有断");
});

test("tick 抛错不会让 tick 链断掉", () => {
  const { clock, wakes, state } = setup({ watchdogMs: 0 });
  state.unread = ["g1"];
  state.planThrows = 1;
  clock.advance(180_000); // 第一次 tick 抛错
  assert.equal(wakes.length, 0);
  clock.advance(180_000);
  assert.equal(wakes.length, 1, "下一次 tick 照常");
});

test("没有冻结时看门狗不干预：去抖仍精确在 30s 触发、只触发一次", () => {
  const { clock, wakes, logs, s } = setup();
  s.onMessage("p1", true, "x");
  clock.advance(29_999);
  assert.equal(wakes.length, 0);
  clock.advance(1);
  assert.equal(wakes.length, 1);
  clock.advance(120_000);
  assert.equal(wakes.filter((w) => w.type === "message").length, 1);
  assert.ok(!logs.some((l) => l.includes("看门狗") || l.includes("跳变")), logs.join("\n"));
});

test("看门狗补触发后同池新消息重新去抖，旧定时器不会提前触发新的去抖", () => {
  const { clock, wakes, s } = setup();
  s.onMessage("p1", true, "x");
  clock.freeze(40_000);
  clock.advance(5_000); // 看门狗补触发
  assert.equal(wakes.length, 1);
  s.onMessage("p1", true, "y");
  clock.advance(29_000);
  assert.equal(wakes.length, 1, "新去抖未到点");
  clock.advance(1_000);
  assert.equal(wakes.length, 2);
});

test("飞书：重连后重复投递同一 message_id 只入池一次", async () => {
  const a = new FeishuAdapter({ appId: "test", appSecret: "test", domain: "feishu", fetchSenderName: false }, new Logger(null, true));
  const got: InboundMessage[] = [];
  (a as any).sink = (m: InboundMessage) => got.push(m);
  const ev = { sender: { sender_id: { open_id: "ou_x" }, sender_type: "user" }, message: { message_id: "om_1", chat_id: "oc_1", chat_type: "p2p", message_type: "text", content: JSON.stringify({ text: "你会做什么" }), create_time: "1792641840000" } };
  await a._deliver("im.message.receive_v1", ev);
  await a._deliver("im.message.receive_v1", ev);
  assert.equal(got.length, 1);
  assert.equal(got[0].text, "你会做什么");
  assert.equal(got[0].ts, 1792641840000, "ts 用平台 create_time，便于看出投递延迟");
});
