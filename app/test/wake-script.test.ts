/**
 * 唤醒剧本：路由化之后，剧本正文住 scene-*.md，唤醒消息里只留「这轮读哪个文件」。
 * 所以每个剧本测两件事：
 *   1. 唤醒消息有没有把这一轮指向正确的文件（路由不漏）
 *   2. 那个文件里有没有该有的话（文案没写丢）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/db.ts";
import { wakePrompt } from "../src/agent/prompt.ts";
import { render } from "../src/agent/template.ts";
import { localDay } from "../src/core/tide.ts";

const TZ = "Asia/Shanghai";

function mkWake(type: "message" | "tick" | "plan"): any {
  return { type, pools: new Set<string>(), planFires: [], reasons: ["test"], enqueuedAt: Date.now() };
}

function mkStore() {
  return new Store(":memory:");
}

test("tick 剧本：路由指向 scene-tick，文案里许空手开口、不许发空话", () => {
  const s = mkStore();
  const p = wakePrompt(s, { wake: mkWake("tick"), now: Date.now(), unread: [], context: new Map(), memories: new Map(), plans: [] });
  assert.match(p, /【这一轮：tick】/, "第一行要给信号");
  assert.match(p, /\/work\/prompt\/scene-tick\.md/, "要指路，不然她不知道读哪份");

  const script = render("scene-tick", {});
  // 默认动作是「说」，不是「想清楚再说」——旧文案到处都是免责句，把它养成了不敢开口
  assert.match(script, /默认说点什么/, "醒过来默认开口");
  assert.match(script, /不用先证明它值得说/);
  assert.match(script, /别为了「不打扰他」而沉默/, "沉默不是稳，是错过");
  assert.match(script, /调 stay_silent|stay_silent/, "仍要留闭嘴的口子");
  assert.match(script, /话题库/);
  // 旧契约是「说不出具体的事，就是没有」——把主动变成了举证责任，已废弃
  assert.doesNotMatch(script, /说不出具体的事，就是没有/);
  assert.doesNotMatch(script, /沉默不等于欠债/);
  assert.doesNotMatch(script, /有人刚说了话/, "三类剧本不能串味");
});

test("message 剧本：路由指向 scene-message，先读懂再说", () => {
  const s = mkStore();
  const p = wakePrompt(s, { wake: mkWake("message"), now: Date.now(), unread: [], context: new Map(), memories: new Map(), plans: [] });
  assert.match(p, /【这一轮：message】/);
  assert.match(p, /\/work\/prompt\/scene-message\.md/);

  const script = render("scene-message", {});
  assert.match(script, /有人刚说了话/);
  assert.match(script, /默认动作是回/, "有人说话就回，不是可选");
  assert.match(script, /往下延半步/, "要往下走，不能一问一答");
  assert.match(script, /连发 2~3 条/);
  assert.doesNotMatch(script, /定时检查/);
  assert.doesNotMatch(script, /沉默不等于欠债/);
});

test("plan 剧本：带上当时排它的理由，并允许作废", () => {
  const s = mkStore();
  const plan = s.insertPlan({
    title: "问他面试结果", content: "", pool_id: null, schedule_kind: "none", schedule: null,
    expires_at: null, anchor_kind: "L1", why: "他周三说今天出结果",
  } as any);
  const p = wakePrompt(s, { wake: mkWake("plan"), now: Date.now(), unread: [], context: new Map(), memories: new Map(), plans: [plan] });
  assert.match(p, /【这一轮：plan】/);
  assert.match(p, /\/work\/prompt\/scene-plan\.md/);
  // 计划本身是数据，还在唤醒消息里
  assert.match(p, /问他面试结果/);
  assert.match(p, /当初排它的理由：他周三说今天出结果/);

  const script = render("scene-plan", {});
  assert.match(script, /`rb plan-update <id> --status cancelled`/);
  assert.match(script, /别念计划/);
});

test("plan 剧本：计划没写 why 时，让它当场想清楚否则作废", () => {
  const s = mkStore();
  const plan = s.insertPlan({
    title: "旧计划", content: "", pool_id: null, schedule_kind: "none", schedule: null, expires_at: null,
  } as any);
  const p = wakePrompt(s, { wake: mkWake("plan"), now: Date.now(), unread: [], context: new Map(), memories: new Map(), plans: [plan] });
  assert.match(p, /当时没写/);
  assert.match(p, /说不出来就作废/);
});

test("状态行：第一次主动 + 今天已发 0 条", () => {
  const s = mkStore();
  const p = wakePrompt(s, { wake: mkWake("tick"), now: Date.now(), unread: [], context: new Map(), memories: new Map(), plans: [] });
  assert.match(p, /这是第一次主动开口/);
  assert.match(p, /今天已主动 0 条/);
});

test("状态行：上次主动几小时前，附带当时的理由", () => {
  const s = mkStore();
  const now = Date.now();
  s.recordTideEvent({ day: localDay(now, TZ), pool_id: null, ts: now - 3 * 3600_000, kind: "fired", anchor_kind: "L2", why: "问他面试结果" });
  const p = wakePrompt(s, { wake: mkWake("tick"), now, unread: [], context: new Map(), memories: new Map(), plans: [] });
  assert.match(p, /上次主动：3 小时前/);
  assert.match(p, /当时说的理由：问他面试结果/);
  assert.match(p, /今天已主动 1 条/);
});

test("状态行：skip 不算主动次数", () => {
  const s = mkStore();
  const now = Date.now();
  s.recordTideEvent({ day: localDay(now, TZ), pool_id: null, ts: now - 1000, kind: "skip", anchor_kind: "L2", reason: "cap" });
  const p = wakePrompt(s, { wake: mkWake("tick"), now, unread: [], context: new Map(), memories: new Map(), plans: [] });
  assert.match(p, /今天已主动 0 条/);
  assert.match(p, /这是第一次主动开口/);
});
