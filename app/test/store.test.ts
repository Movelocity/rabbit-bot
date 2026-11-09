import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/db.ts";
import { feishuContentToText } from "../src/adapters/feishu.ts";
import { readPool, searchPool } from "../src/ops/pools.ts";
import { fmtMsg } from "../src/agent/prompt.ts";
import type { InboundMessage } from "../src/types.ts";

let n = 0;
const msg = (o: Partial<InboundMessage>): InboundMessage => ({
  platform: "feishu", external_chat_id: "oc_1", pool_kind: "private", msg_id: `m${++n}`, sender_id: "ou_a", sender_name: "A",
  ts: Date.now(), text: "hi", reply_to: null, mentions: [], is_mention_me: false, media_type: "text", ...o,
});

test("入池去重、游标、未读不含自己的消息", () => {
  const s = new Store(":memory:");
  const a = s.insertMessage(msg({ msg_id: "x1" }))!;
  assert.equal(s.insertMessage(msg({ msg_id: "x1" })), null);
  s.insertMessage(msg({ msg_id: "self1", from_self: true, sender_id: "self" }));
  assert.deepEqual(s.unread(a.pool_id).map((m) => m.msg_id), ["x1"]);
  assert.deepEqual(s.poolsWithUnread(), [a.pool_id]);
  s.advanceCursor(a.pool_id, s.maxSeq(a.pool_id));
  assert.deepEqual(s.poolsWithUnread(), []);
  s.advanceCursor(a.pool_id, 0); // 游标不后退
  assert.deepEqual(s.poolsWithUnread(), []);
  assert.equal(s.resolvePool("p1")!.pool_id, a.pool_id);
});

test("lastUserMessageTs(null) 跨池不把任务池事件算作用户说话", () => {
  const s = new Store(":memory:");
  const early = Date.now() - 60_000;
  s.insertMessage(msg({ msg_id: "chat1", external_chat_id: "oc_1", ts: early }));
  s.insertMessage(msg({
    msg_id: "task1", platform: "task", external_chat_id: "task:1", pool_kind: "task",
    sender_id: "task", sender_name: "任务", ts: Date.now(),
  }));
  assert.equal(s.lastUserMessageTs(null), early);
  // 指定任务池时保持原样（调用方自己跳过任务池）
  assert.ok(s.lastUserMessageTs("task:task:1") > early);
});

test("身份映射：同一人跨平台映射到同一 user_id", () => {
  const s = new Store(":memory:");
  const u1 = s.resolveUser("feishu", "ou_a", "A");
  assert.equal(s.resolveUser("feishu", "ou_a"), u1);
  const u2 = s.resolveUser("mock", "123", "A");
  assert.notEqual(u1, u2);
  s.linkIdentity("mock", "123", u1);
  assert.equal(s.resolveUser("mock", "123"), u1);
});

test("resolveUser 拿到新名字时同时更新 users 和 identities", () => {
  const s = new Store(":memory:");
  const u = s.resolveUser("feishu", "ou_h", "用户449b");
  assert.equal(s.resolveUser("feishu", "ou_h", "贺伟康"), u);
  assert.equal(s.userDisplayName("feishu", "ou_h"), "贺伟康");
  assert.equal(s.listUsers().find((x) => x.user_id === u)!.display_name, "贺伟康");
  assert.equal(s.listIdentities().find((i) => i.platform === "feishu" && i.platform_user_id === "ou_h")!.display_name, "贺伟康");

  // users 为空时回退 identities；两边都没有就是空
  s.db.prepare("UPDATE users SET display_name='' WHERE user_id=?").run(u);
  assert.equal(s.userDisplayName("feishu", "ou_h"), "贺伟康");
  s.db.prepare("UPDATE identities SET display_name='' WHERE platform='feishu' AND platform_user_id='ou_h'").run();
  assert.equal(s.userDisplayName("feishu", "ou_h"), "");
});

test("人工别名不会被后续自动名冲掉", () => {
  const s = new Store(":memory:");
  const u = s.resolveUser("feishu", "ou_h", "用户449b");
  s.renameUser(u, "老大");
  s.resolveUser("feishu", "ou_h", "贺伟康");
  assert.equal(s.userDisplayName("feishu", "ou_h"), "老大");
  const row = s.listUsers().find((x) => x.user_id === u)!;
  assert.equal(row.alias, "老大");
  assert.equal(row.display_name, "贺伟康");
});

test("唤醒上下文也用人工别名，不靠 @ 或平台原名", () => {
  const s = new Store(":memory:");
  const m = s.insertMessage(msg({ sender_id: "ou_alias", sender_name: "用户449b" }))!;
  const u = s.resolveUser("feishu", "ou_alias", "贺伟康");
  s.renameUser(u, "老大");
  s.resolveUser("feishu", "ou_alias", "贺伟康改的名");
  const line = fmtMsg(s, m);
  assert.match(line, /老大/);
  assert.doesNotMatch(line, /用户449b|贺伟康/);
});

test("池消息显示映射后的名字：旧消息也能补，sender_name 保留原名", () => {
  const s = new Store(":memory:");
  const m = s.insertMessage(msg({ msg_id: "old1", sender_id: "ou_h", sender_name: "用户449b" }))!;
  const alias = s.poolAlias(m.pool_id);
  assert.equal(readPool(s, alias).messages[0].sender, "用户449b");

  s.renameUser(m.user_id!, "贺伟康");
  const read = readPool(s, alias).messages[0];
  assert.equal(read.sender, "贺伟康");
  assert.equal(read.sender_name, "用户449b");

  const found = searchPool(s, "hi", alias);
  assert.equal(found.messages[0].sender, "贺伟康");
  assert.equal(found.messages[0].sender_name, "用户449b");
});

test("renameUser 同步 identities，backfill 连历史 sender_name 一起改", () => {
  const s = new Store(":memory:");
  const m = s.insertMessage(msg({ msg_id: "old2", sender_id: "ou_h", sender_name: "用户449b" }))!;
  const renamed = s.renameUser(m.user_id!, "贺伟康", { backfill: true })!;
  assert.equal(renamed.display_name, "贺伟康");
  assert.equal(renamed.backfilled, 1);
  assert.deepEqual(renamed.identities.map((i) => i.display_name), ["贺伟康"]);
  assert.equal(s.getMessageBySeq(m.seq)!.sender_name, "贺伟康");
  assert.equal(readPool(s, s.poolAlias(m.pool_id)).messages[0].sender, "贺伟康");
  assert.equal(s.renameUser("u_nope", "x"), null);
  assert.equal(s.renameUser(m.user_id!, "   "), null);
});

test("记忆可见范围：群里的不进私聊，反之亦然", () => {
  const s = new Store(":memory:");
  const dm = s.upsertPool("feishu", "oc_dm", "private");
  const g1 = s.upsertPool("feishu", "oc_g1", "group");
  const g2 = s.upsertPool("feishu", "oc_g2", "group");
  const u = "u_1";
  s.addMemory({ user_id: u, content: "私聊里说的", source_pool_id: dm.pool_id, source_kind: "private", scope: "private" });
  s.addMemory({ user_id: u, content: "群里说的", source_pool_id: g1.pool_id, source_kind: "group", scope: "group" });
  s.addMemory({ user_id: u, content: "只在g1", source_pool_id: g1.pool_id, source_kind: "group", scope: "pool" });
  s.addMemory({ user_id: u, content: "公开", source_pool_id: dm.pool_id, source_kind: "private", scope: "all" });
  const c = (p: any) => s.visibleMemories(u, p, 10).map((m: any) => m.content).sort();
  assert.deepEqual(c(dm), ["公开", "私聊里说的"].sort());
  assert.deepEqual(c(g1), ["公开", "只在g1", "群里说的"].sort());
  assert.deepEqual(c(g2), ["公开", "群里说的"].sort());
});

test("飞书消息内容转文字（含 @ 替换与非文字占位）", () => {
  assert.deepEqual(feishuContentToText("text", JSON.stringify({ text: "@_user_1 你好" }), [{ key: "@_user_1", name: "小池" }]), { text: "@小池 你好", media: "text" });
  assert.deepEqual(feishuContentToText("image", "{}"), { text: "[图片]", media: "image" });
  assert.deepEqual(feishuContentToText("audio", "{}"), { text: "[语音]", media: "audio" });
  assert.deepEqual(feishuContentToText("file", JSON.stringify({ file_name: "a.pdf" })), { text: "[文件:a.pdf]", media: "file" });
  const post = { zh_cn: { title: "标题", content: [[{ tag: "text", text: "第一行" }, { tag: "at", user_name: "B" }], [{ tag: "img" }]] } };
  assert.equal(feishuContentToText("post", JSON.stringify(post)).text, "标题\n第一行@B\n[图片]");
});
