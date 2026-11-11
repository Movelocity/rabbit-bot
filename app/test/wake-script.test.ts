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

function mkWake(type: "message" | "tick"): any {
  return { type, pools: new Set<string>(), planFires: [], reasons: ["test"], enqueuedAt: Date.now() };
}

function mkStore() {
  return new Store(":memory:");
}

test("tick 剧本：路由指向 scene-tick，只报正事、不为存在感开口", () => {
  const s = mkStore();
  const p = wakePrompt(s, { wake: mkWake("tick"), now: Date.now(), unread: [], context: new Map() });
  assert.match(p, /【这一轮：tick】/, "第一行要给信号");
  assert.match(p, /read_file prompt\/scene-tick\.md/, "要指路，不然她不知道读哪份");

  const script = render("scene-tick", {});
  assert.match(script, /先看手上有没有正事/, "醒过来先看工作，不是先找话说");
  assert.match(script, /只有这几种情况开口/, "开口要有工作理由");
  assert.match(script, /不为了「保持存在感」而开口/, "不许为存在感发言");
  assert.match(script, /action=skip|skip/, "仍要留闭嘴的口子");
  assert.doesNotMatch(script, /默认说点什么/, "旧文案的默认闲聊已废弃");
  assert.doesNotMatch(script, /话题库/, "工作场景不再翻话题库");
  assert.doesNotMatch(script, /有人刚说了话/, "三类剧本不能串味");
});

test("message 剧本：路由指向 scene-message，先判断需求再回", () => {
  const s = mkStore();
  const p = wakePrompt(s, { wake: mkWake("message"), now: Date.now(), unread: [], context: new Map() });
  assert.match(p, /【这一轮：message】/);
  assert.match(p, /read_file prompt\/scene-message\.md/);

  const script = render("scene-message", {});
  assert.match(script, /有人刚说了话/);
  assert.match(script, /先判断他要什么/, "先判断需求类型");
  assert.match(script, /默认只回有信息的部分/, "不闲聊、不注水");
  assert.match(script, /不连发/, "不连发");
  assert.doesNotMatch(script, /连发 2~3 条/, "旧的连发闲聊已废弃");
  assert.doesNotMatch(script, /往下延半步/, "不再要求为续聊而续聊");
  assert.doesNotMatch(script, /定时检查/);
});

test("状态行：第一次主动 + 今天已发 0 条", () => {
  const s = mkStore();
  const p = wakePrompt(s, { wake: mkWake("tick"), now: Date.now(), unread: [], context: new Map() });
  assert.match(p, /这是第一次主动开口/);
  assert.match(p, /今天已主动 0 条/);
});

test("状态行：上次主动几小时前，附带当时的理由", () => {
  const s = mkStore();
  const now = Date.now();
  s.recordTideEvent({ day: localDay(now, TZ), pool_id: null, ts: now - 3 * 3600_000, kind: "fired", anchor_kind: "L2", why: "问他面试结果" });
  const p = wakePrompt(s, { wake: mkWake("tick"), now, unread: [], context: new Map() });
  assert.match(p, /上次主动：3 小时前/);
  assert.match(p, /当时说的理由：问他面试结果/);
  assert.match(p, /今天已主动 1 条/);
});

test("状态行：skip 不算主动次数", () => {
  const s = mkStore();
  const now = Date.now();
  s.recordTideEvent({ day: localDay(now, TZ), pool_id: null, ts: now - 1000, kind: "skip", anchor_kind: "L2", reason: "cap" });
  const p = wakePrompt(s, { wake: mkWake("tick"), now, unread: [], context: new Map() });
  assert.match(p, /今天已主动 0 条/);
  assert.match(p, /这是第一次主动开口/);
});
