import { test } from "node:test";
import assert from "node:assert/strict";
import { Hub } from "../src/core/hub.ts";
import { Store } from "../src/core/db.ts";
import { loadConfig } from "../src/config.ts";

const log: any = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function setup() {
  const store = new Store(":memory:");
  const hub = new Hub(store, loadConfig(), log, {} as any);
  return { store, hub };
}

const img = (msgId: string, seqKey = msgId) => ({
  platform: "feishu" as const, external_chat_id: "oc_test", pool_kind: "private" as const,
  msg_id: msgId, sender_id: "ou_1", sender_name: "主人", ts: Date.now(), text: "[图片]",
  reply_to: null, mentions: [], is_mention_me: false, media_type: "image" as const, from_self: false,
  attachment: { path: `/tmp/${seqKey}.jpg`, mime: "image/jpeg", width: 10, height: 10, bytes: 100 },
});

test("图片被 takeUnread 消费后仍留档，下一轮能取回", () => {
  const { hub } = setup();
  hub.ingest(img("m1"));
  const first = hub.takeUnread();          // 等价于 send 里的 newMessages
  assert.equal(first.length, 1);
  assert.ok(first[0].attachment);
  // 游标已推进：再取就是空的
  assert.equal(hub.takeUnread().length, 0);
  // 但图片留了一份，留给下一次唤醒
  const pending = hub.takePendingMedia();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].msg_id, "m1");
  // 取过即清空
  assert.equal(hub.takePendingMedia().length, 0);
});

test("同一条图片不会重复留档", () => {
  const { hub } = setup();
  hub.ingest(img("m2"));
  hub.takeUnread();
  hub.takeUnread(); // 再来一次也不会重复
  assert.equal(hub.takePendingMedia().length, 1);
});

test("纯文字消息不进图片留档", () => {
  const { hub } = setup();
  hub.ingest({ ...img("m3"), media_type: "text", text: "在吗", attachment: null });
  hub.takeUnread();
  assert.equal(hub.takePendingMedia().length, 0);
});
