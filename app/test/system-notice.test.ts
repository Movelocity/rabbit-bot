/**
 * 系统通知的可见性：任务审批这类通知要按「自己发过的话」留在池里，
 * 否则飞书不回投自己发的消息，agent 看不到自己发过什么；Matrix 靠 sync 回灌天然可见。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Hub } from "../src/core/hub.ts";
import { Store } from "../src/core/db.ts";
import { loadConfig } from "../src/config.ts";

const log: any = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function setup() {
  const store = new Store(":memory:");
  const cfg = loadConfig({ agent: { name: "小兔" } } as any);
  const hub = new Hub(store, cfg, log, {} as any);
  const sent: { chat: string; text: string; msgId: string }[] = [];
  let n = 0;
  hub.addAdapter({
    platform: "feishu",
    async sendText(chat: string, text: string) {
      const msgId = `om_${++n}`;
      sent.push({ chat, text, msgId });
      return { msgId };
    },
  } as any);
  const pool = store.upsertPool("feishu", "oc_main", "private", "主人");
  return { store, hub, sent, pool };
}

test("remember=true 的系统通知按自己发的消息入池，但不算未读", async () => {
  const { store, hub, pool } = setup();
  const r = await hub.sendSystem("feishu", "oc_main", "任务 #1 审批通过，准备启动", { remember: true });
  assert.equal(r.ok, true);

  const rows = store.recentMessages(pool.pool_id, 10);
  const row = rows.find((m) => m.text.includes("审批通过"));
  assert.ok(row, "通知要留在池里，下一次唤醒能看到");
  assert.equal(row!.from_self, true);
  assert.equal(store.unread(pool.pool_id).length, 0, "系统通知不能算未读");
});

test("默认不 remember：host shell 审批提示不变成聊天素材", async () => {
  const { store, hub, pool } = setup();
  await hub.sendSystem("feishu", "oc_main", "【命令待审批】rm -rf /tmp/x");
  assert.equal(store.recentMessages(pool.pool_id, 10).length, 0);
});

test("平台回灌同一条消息时按 msgId 去重，不留两份", async () => {
  const { store, hub, pool } = setup();
  const r = await hub.sendSystem("feishu", "oc_main", "任务 #2 已取消", { remember: true });
  hub.ingest({
    platform: "feishu", external_chat_id: "oc_main", pool_kind: "private", pool_title: "主人",
    msg_id: r.msgId!, sender_id: "self", sender_name: "小兔", ts: Date.now(), text: "任务 #2 已取消",
    reply_to: null, mentions: [], is_mention_me: false, media_type: "text", from_self: true,
  });
  const rows = store.recentMessages(pool.pool_id, 10).filter((m) => m.text.includes("任务 #2"));
  assert.equal(rows.length, 1);
});

test("池不存在时不凭空建池", async () => {
  const { store, hub } = setup();
  await hub.sendSystem("feishu", "oc_never_seen", "任务 #3 审批通过", { remember: true });
  assert.equal(store.getPool(Store.poolIdFor("feishu", "oc_never_seen")), undefined);
});
