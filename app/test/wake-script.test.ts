import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/db.ts";
import { wakePrompt } from "../src/agent/prompt.ts";
import { localDay } from "../src/core/tide.ts";

const TZ = "Asia/Shanghai";

function mkWake(type: "message" | "tick" | "plan"): any {
  return { type, pools: new Set<string>(), planFires: [], reasons: ["test"], enqueuedAt: Date.now() };
}

function mkStore() {
  return new Store(":memory:");
}

test("tick 剧本：明确授权沉默，且不许为证明在线而发消息", () => {
  const s = mkStore();
  const p = wakePrompt(s, { wake: mkWake("tick"), now: Date.now(), unread: [], context: new Map(), memories: new Map(), plans: [] });
  assert.match(p, /定时检查，没有人在等你/);
  assert.match(p, /重点.*判断.*不是说话/);
  assert.match(p, /调 stay_silent/);
  assert.match(p, /或者什么都不调用直接结束/);
  assert.match(p, /那句话本身就是打扰/, "不能用 send 发一句「我先不打扰了」");
  assert.match(p, /不是失败/);
  assert.match(p, /沉默不等于欠债/);
  assert.doesNotMatch(p, /有人刚说了话/, "三类剧本不能串味");
});

test("message 剧本：先读懂再说，不出现「定时检查」", () => {
  const s = mkStore();
  const p = wakePrompt(s, { wake: mkWake("message"), now: Date.now(), unread: [], context: new Map(), memories: new Map(), plans: [] });
  assert.match(p, /有人刚说了话/);
  assert.match(p, /一句话说出他为什么挑这个时候说这个/);
  assert.doesNotMatch(p, /定时检查/);
  assert.doesNotMatch(p, /沉默不等于欠债/);
});

test("plan 剧本：带上当时排它的理由，并允许作废", () => {
  const s = mkStore();
  const plan = s.insertPlan({
    title: "问他面试结果", content: "", pool_id: null, schedule_kind: "none", schedule: null,
    expires_at: null, anchor_kind: "L1", why: "他周三说今天出结果",
  } as any);
  const p = wakePrompt(s, { wake: mkWake("plan"), now: Date.now(), unread: [], context: new Map(), memories: new Map(), plans: [plan] });
  assert.match(p, /问他面试结果/);
  assert.match(p, /当时排它的理由是：他周三说今天出结果/);
  assert.match(p, /已经聊过、或者已经没意义了 → `rb plan-update <id> --status cancelled`/);
  assert.match(p, /别念计划/);
});

test("plan 剧本：计划没写 why 时，让它当场想清楚否则作废", () => {
  const s = mkStore();
  const plan = s.insertPlan({
    title: "旧计划", content: "", pool_id: null, schedule_kind: "none", schedule: null, expires_at: null,
  } as any);
  const p = wakePrompt(s, { wake: mkWake("plan"), now: Date.now(), unread: [], context: new Map(), memories: new Map(), plans: [plan] });
  assert.match(p, /当时没写理由/);
  assert.match(p, /说不出来就作废/);
});

test("潮汐数据行：第一次主动 + 今天已发 0 条", () => {
  const s = mkStore();
  const p = wakePrompt(s, { wake: mkWake("tick"), now: Date.now(), unread: [], context: new Map(), memories: new Map(), plans: [] });
  assert.match(p, /这是第一次主动开口/);
  assert.match(p, /今天已主动 0 条/);
});

test("潮汐数据行：上次主动几小时前，附带当时的理由", () => {
  const s = mkStore();
  const now = Date.now();
  s.recordTideEvent({ day: localDay(now, TZ), pool_id: null, ts: now - 3 * 3600_000, kind: "fired", anchor_kind: "L2", why: "问他面试结果" });
  const p = wakePrompt(s, { wake: mkWake("tick"), now, unread: [], context: new Map(), memories: new Map(), plans: [] });
  assert.match(p, /上次主动：3 小时前/);
  assert.match(p, /当时说的理由：问他面试结果/);
  assert.match(p, /今天已主动 1 条/);
});

test("潮汐数据行：skip 不算主动次数", () => {
  const s = mkStore();
  const now = Date.now();
  s.recordTideEvent({ day: localDay(now, TZ), pool_id: null, ts: now - 1000, kind: "skip", anchor_kind: "L2", reason: "cap" });
  const p = wakePrompt(s, { wake: mkWake("tick"), now, unread: [], context: new Map(), memories: new Map(), plans: [] });
  assert.match(p, /今天已主动 0 条/);
  assert.match(p, /这是第一次主动开口/);
});
