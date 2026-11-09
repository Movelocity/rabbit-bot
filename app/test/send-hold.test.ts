import { test } from "node:test";
import assert from "node:assert/strict";
import { Hub } from "../src/core/hub.ts";
import { Store } from "../src/core/db.ts";
import { loadConfig } from "../src/config.ts";

const log: any = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function setup() {
  const cfg = loadConfig();
  cfg.send.confirmWaitMs = 0;
  cfg.send.pacing.enabled = false;   // 这条测的是「压住」，不是间隔
  const store = new Store(":memory:");
  const hub = new Hub(store, cfg, log, {} as any);
  const sent: string[] = [];
  let n = 0;
  hub.addAdapter({
    platform: "feishu" as const,
    start: async () => {},
    stop: async () => {},
    sendText: async (_id: string, text: string) => { sent.push(text); return { msgId: `m${++n}` }; },
  } as any);
  const userSays = (text: string, msgId: string) => hub.ingest({
    platform: "feishu", external_chat_id: "oc_hold", pool_kind: "private",
    msg_id: msgId, sender_id: "u1", sender_name: "他", ts: Date.now(), text,
    reply_to: null, mentions: [], is_mention_me: false, media_type: "text",
  });
  const taskSays = (text: string, msgId: string) => hub.ingest({
    platform: "task", external_chat_id: "task:1", pool_kind: "task",
    msg_id: msgId, sender_id: "task", sender_name: "任务", ts: Date.now(), text,
    reply_to: null, mentions: [], is_mention_me: false, media_type: "text",
  });
  // 第一句建池、并且模拟「wake 已经把未读抽走了」
  userSays("在吗", "u0");
  hub.takeUnread();
  return { hub, store, sent, userSays, taskSays };
}

test("发之前来了新消息：这句不发，原话退回", async () => {
  const { hub, sent, userSays } = setup();
  const first = await hub.send("feishu:oc_hold", "嗯");
  assert.equal(first.ok, true);
  assert.deepEqual(sent, ["嗯"]);

  // 他在这期间又说话了
  userSays("钥匙的事你别管了", "u1");
  const second = await hub.send("feishu:oc_hold", "那你自己去弄");
  assert.equal(second.ok, false);
  assert.equal(second.held, true);
  assert.equal(second.heldText, "那你自己去弄");
  assert.equal(second.newMessages.length, 1);
  assert.match(second.newMessages[0].text, /钥匙/);
  assert.deepEqual(sent, ["嗯"], "压住的这句不该落到聊天里");
});

test("看完新消息后再说：这时候没有未读，正常发出去", async () => {
  const { hub, sent, userSays } = setup();
  await hub.send("feishu:oc_hold", "嗯");
  userSays("钥匙的事你别管了", "u1");
  const held = await hub.send("feishu:oc_hold", "那你自己去弄");
  assert.equal(held.held, true);
  // 模型改了口径重新发
  const again = await hub.send("feishu:oc_hold", "行，那我不问了");
  assert.equal(again.ok, true);
  assert.deepEqual(sent, ["嗯", "行，那我不问了"]);
});

test("系统提示不被压住——那不是她说话", async () => {
  const { hub, sent, userSays } = setup();
  userSays("人呢", "u1");
  const r = await hub.send("feishu:oc_hold", "〔系统〕今天的额度用完了", { internal: true });
  assert.equal(r.ok, true);
  assert.deepEqual(sent, ["〔系统〕今天的额度用完了"]);
});

test("没新消息的时候不受影响（别把正常发送也拦了）", async () => {
  const { hub, sent } = setup();
  const r = await hub.send("feishu:oc_hold", "在");
  assert.equal(r.held, undefined);
  assert.equal(r.ok, true);
  assert.deepEqual(sent, ["在"]);
});

test("任务池的进度事件不算新消息：不压住发送，也不进 newMessages", async () => {
  const { hub, store, sent, taskSays } = setup();
  taskSays("任务 #1 进度 50%", "task1");
  const r = await hub.send("feishu:oc_hold", "在");
  assert.equal(r.ok, true);
  assert.equal(r.held, undefined);
  assert.deepEqual(r.newMessages, []);
  assert.deepEqual(sent, ["在"]);
  // 任务进度还留在池里，任务 tick / UI 照常能看
  assert.equal(store.unread("task:task:1").length, 1);
  assert.deepEqual(store.poolsWithUnread(), ["task:task:1"]);
});

test("任务池未读不影响普通私聊照常压住，且只退回私聊新消息", async () => {
  const { hub, taskSays, userSays } = setup();
  taskSays("任务 #1 退出", "task1");
  userSays("钥匙的事你别管了", "u1");
  const r = await hub.send("feishu:oc_hold", "那你自己去弄");
  assert.equal(r.held, true);
  assert.equal(r.newMessages.length, 1);
  assert.match(r.newMessages[0].text, /钥匙/);
  assert.ok(r.newMessages.every((m) => m.pool_id !== "task:task:1"));
});
