/** 飞书群聊：占位名用群成员列表补齐；拉取失败不影响消息入池。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FeishuAdapter } from "../src/adapters/feishu.ts";
import { Logger } from "../src/core/logger.ts";
import type { InboundMessage } from "../src/types.ts";

const adapter = () => new FeishuAdapter(
  { appId: "test", appSecret: "test", domain: "feishu", fetchSenderName: false },
  new Logger(null, true),
);

const event = (messageId: string, chatId = "oc_group", openId = "ou_ab12") => ({
  sender: { sender_id: { open_id: openId }, sender_type: "user" },
  message: {
    message_id: messageId, chat_id: chatId, chat_type: "group", message_type: "text",
    content: JSON.stringify({ text: "hi" }), create_time: "1792641840000",
  },
});

const deliver = async (a: FeishuAdapter, ev: ReturnType<typeof event>) => {
  const got: InboundMessage[] = [];
  (a as any).sink = (m: InboundMessage) => got.push(m);
  await a._deliver("im.message.receive_v1", ev);
  return got[0];
};

test("群成员列表补齐占位名，同一群 10 分钟内只拉一次", async () => {
  const a = adapter();
  const calls: any[] = [];
  (a as any).client = {
    im: { v1: { chatMembers: { get: async (p: any) => {
      calls.push(p);
      return { code: 0, data: { items: [{ member_id: "ou_ab12", name: "群友真名" }], has_more: false } };
    } } } },
  };

  const first = await deliver(a, event("om_1"));
  assert.equal(first.sender_name, "群友真名");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path.chat_id, "oc_group");
  assert.equal(calls[0].params.member_id_type, "open_id");

  const second = await deliver(a, event("om_2"));
  assert.equal(second.sender_name, "群友真名");
  assert.equal(calls.length, 1, "缓存命中，不再打群成员接口");
});

test("群成员拉取失败：消息照常入池，仍用占位名", async () => {
  const a = adapter();
  (a as any).client = {
    im: { v1: { chatMembers: { get: async () => { throw new Error("no permission"); } } } },
  };
  const m = await deliver(a, event("om_3"));
  assert.equal(m.sender_name, "用户ab12");
  assert.equal(m.text, "hi");
});
