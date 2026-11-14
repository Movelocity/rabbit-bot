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
import { appendScheduleEvent, ensureSchedulePool } from "../src/core/schedules.ts";

function mkWake(type: "message" | "tick" | "schedule"): any {
  return { type, pools: new Set<string>(), planFires: [], reasons: ["test"], enqueuedAt: Date.now() };
}

function mkStore() {
  return new Store(":memory:");
}

test("tick 剧本：路由指向 scene-tick，只报正事、不为存在感开口", () => {
  const s = mkStore();
  const p = wakePrompt(s, { wake: mkWake("tick"), now: Date.now(), unread: [], context: new Map() });
  assert.match(p, /^【test】/, "第一行给唤醒原因");
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
  assert.match(p, /^【test】/);
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

test("schedule 剧本：路由指向 scene-schedule，并从共用日程池读到原文", () => {
  const s = mkStore();
  const now = Date.now();
  const poolId = ensureSchedulePool(s);
  appendScheduleEvent(s, {
    id: 7, title: "交周报", content: "提醒他周五下班前交周报",
    kind: "delay", cron: null, delay_minutes: 1, next_at: now, status: "active",
    last_fired_at: null, created_at: now, updated_at: now,
  }, now);
  const wake = mkWake("schedule");
  wake.pools = new Set([poolId]);
  const unread = s.unread(poolId);
  const p = wakePrompt(s, { wake, now, unread, context: new Map() });
  assert.match(p, /^【test】/);
  assert.match(p, /read_file prompt\/scene-schedule\.md/);
  assert.match(p, /日程/);
  assert.match(p, /提醒他周五下班前交周报/, "日程原文要进提示词");
  assert.equal(s.poolsWithUnread().includes(poolId), true);

  const script = render("scene-schedule", {});
  assert.match(script, /日程池有到点的事件/);
  assert.match(script, /不要往这个池发消息/);
  assert.match(script, /不代表现在还合适/, "过期日程允许跳过");
});

test("说话人名字用身份映射，不用平台兜底名", () => {
  const s = mkStore();
  const m = s.insertMessage({
    platform: "feishu", external_chat_id: "c1", pool_kind: "group", msg_id: "m1",
    sender_id: "ou_x", sender_name: "用户144b", ts: Date.now(), text: "在吗",
    reply_to: null, mentions: [], is_mention_me: true, media_type: "text",
  })!;
  s.renameUser(m.user_id!, "刘兴旺");
  const wake = mkWake("message");
  wake.pools = new Set([m.pool_id]);
  const p = wakePrompt(s, { wake, now: Date.now(), unread: [m], context: new Map() });
  assert.match(p, /正在跟你说话的人：刘兴旺/);
  assert.doesNotMatch(p, /正在跟你说话的人：用户144b/);
});

test("状态行：不再展示主动次数与上次主动", () => {
  const s = mkStore();
  const p = wakePrompt(s, { wake: mkWake("tick"), now: Date.now(), unread: [], context: new Map() });
  assert.match(p, /## 状态/);
  assert.match(p, /距上次对话：/);
  assert.doesNotMatch(p, /上次主动/);
  assert.doesNotMatch(p, /今天已主动/);
});
