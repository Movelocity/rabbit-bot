import { test } from "node:test";
import assert from "node:assert/strict";
import { Hub } from "../src/core/hub.ts";
import { Store } from "../src/core/db.ts";
import { loadConfig } from "../src/config.ts";
import { MockAdapter } from "../src/adapters/mock.ts";
import { feishuRecallError } from "../src/adapters/feishu.ts";

const log: any = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

async function setup() {
  const store = new Store(":memory:");
  const cfg = loadConfig();
  cfg.send.confirmWaitMs = 0;
  cfg.send.pacing.enabled = false;
  const hub = new Hub(store, cfg, log, {} as any);
  const mock = new MockAdapter();
  await mock.start(() => {});
  hub.addAdapter(mock);
  store.insertMessage({
    platform: "mock", external_chat_id: "chat1", pool_kind: "private",
    msg_id: "in-1", sender_id: "u1", sender_name: "他", ts: Date.now(), text: "在吗",
    reply_to: null, mentions: [], is_mention_me: false, media_type: "text", from_self: false,
  });
  hub.takeUnread();
  const pool = store.listPools()[0];
  return { store, hub, mock, poolId: pool.pool_id };
}

test("recall 按消息开头的 5 个字符定位自己发的消息", async () => {
  const { hub, mock, poolId } = await setup();
  const sent = await hub.send(poolId, "这是一句要说错的话");
  assert.equal(sent.ok, true);

  const r = await hub.recall(poolId, "这是一句要");
  assert.equal(r.ok, true);
  assert.equal(r.msgId, sent.sentParts[0].msgId);
  assert.ok(mock.recalled.has(r.msgId!));
});

test("消息不足 5 个字符时用全文作为定位串", async () => {
  const { hub, mock, poolId } = await setup();
  const sent = await hub.send(poolId, "好的");
  const r = await hub.recall(poolId, "好的");
  assert.equal(r.ok, true);
  assert.equal(r.msgId, sent.sentParts[0].msgId);
  assert.ok(mock.recalled.has(r.msgId!));
});

test("同前缀取最近一条", async () => {
  const { hub, mock, poolId } = await setup();
  await hub.send(poolId, "同样的开头第一句");
  const last = await hub.send(poolId, "同样的开头第二句");
  const r = await hub.recall(poolId, "同样的开头");
  assert.equal(r.ok, true);
  assert.equal(r.msgId, last.sentParts[0].msgId);
  assert.ok(mock.recalled.has(r.msgId!));
});

test("定位串对不上时明确报错", async () => {
  const { hub, poolId } = await setup();
  await hub.send(poolId, "这是一句要说错的话");
  const r = await hub.recall(poolId, "另一句要");
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /没有找到开头是「另一句要」/);
});

test("撤回失败时把平台原因带回给调用方", async () => {
  const { hub, mock, poolId } = await setup();
  await hub.send(poolId, "这句要撤回");
  mock.recallError = "code=230009 msg=Message has expired（超过管理员设置的撤回时限）";

  const r = await hub.recall(poolId, "这句要撤回");
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /230009/);
  assert.match(r.error ?? "", /撤回时限/);
});

test("只能撤回自己发的消息", async () => {
  const { hub, poolId } = await setup();
  const r = await hub.recall(poolId, "在吗");
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /只能撤回自己发出的消息/);
});

test("飞书撤回错误码会翻译成能行动的原因", () => {
  const msg = feishuRecallError({ response: { data: { code: 230009, msg: "Message has expired when recall message." } } });
  assert.match(msg, /code=230009/);
  assert.match(msg, /超过管理员设置的撤回时限/);
});
