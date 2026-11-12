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

test("recall 不给 id 就撤回池里最后一条自己发的消息", async () => {
  const { hub, mock, poolId } = await setup();
  const sent = await hub.send(poolId, "说错话了");
  assert.equal(sent.ok, true);

  const r = await hub.recall(poolId);
  assert.equal(r.ok, true);
  assert.equal(r.msgId, sent.sentParts[0].msgId);
  assert.ok(mock.recalled.has(r.msgId!));
});

test("撤回失败时把平台原因带回给调用方", async () => {
  const { hub, mock, poolId } = await setup();
  const sent = await hub.send(poolId, "这句要撤回");
  mock.recallError = "code=230009 msg=Message has expired（超过管理员设置的撤回时限）";

  const r = await hub.recall(poolId, sent.sentParts[0].msgId);
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /230009/);
  assert.match(r.error ?? "", /撤回时限/);
});

test("只能撤回自己发的消息", async () => {
  const { store, hub, poolId } = await setup();
  const inbound = store.messageByMsgId("mock", "in-1")!;
  const r = await hub.recall(poolId, inbound.msg_id);
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /只能撤回自己发出的消息/);
});

test("飞书撤回错误码会翻译成能行动的原因", () => {
  const msg = feishuRecallError({ response: { data: { code: 230009, msg: "Message has expired when recall message." } } });
  assert.match(msg, /code=230009/);
  assert.match(msg, /超过管理员设置的撤回时限/);
});
