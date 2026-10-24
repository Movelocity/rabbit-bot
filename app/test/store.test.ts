import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/db.ts";
import { feishuContentToText } from "../src/adapters/feishu.ts";
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

test("身份映射：同一人跨平台映射到同一 user_id", () => {
  const s = new Store(":memory:");
  const u1 = s.resolveUser("feishu", "ou_a", "A");
  assert.equal(s.resolveUser("feishu", "ou_a"), u1);
  const u2 = s.resolveUser("mock", "123", "A");
  assert.notEqual(u1, u2);
  s.linkIdentity("mock", "123", u1);
  assert.equal(s.resolveUser("mock", "123"), u1);
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
