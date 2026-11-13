/** 飞书出站：包含 markdown 标记的文本改发 post + md 标签，普通文本保持 text 消息。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FeishuAdapter, buildFeishuMarkdown, buildFeishuPost, looksLikeMarkdown } from "../src/adapters/feishu.ts";
import { Logger } from "../src/core/logger.ts";

const adapter = () => new FeishuAdapter(
  { appId: "test", appSecret: "test", domain: "feishu", fetchSenderName: false },
  new Logger(null, true),
);

const stubSend = (a: FeishuAdapter) => {
  const calls: any[] = [];
  (a as any).client = {
    im: { v1: { message: { create: async (p: any) => {
      calls.push(p);
      return { code: 0, data: { message_id: `om_${calls.length}` } };
    } } } },
  };
  return calls;
};

test("markdown 标记识别：加粗/代码/标题/列表/表格/链接", () => {
  for (const s of ["你好**世界**", "```ts\nx\n```", "`code`", "# 标题", "- item", "1. item", "> quote", "| a | b |", "[文档](https://x.y)"]) {
    assert.equal(looksLikeMarkdown(s), true, s);
  }
  for (const s of ["普通消息", "2*3*4", "价格 100 元", "第一行\n第二行"]) {
    assert.equal(looksLikeMarkdown(s), false, s);
  }
});

test("发送含 ** 的文本：改发 post + md 标签", async () => {
  const a = adapter();
  const calls = stubSend(a);
  await a.sendText("oc_x", "这是**重点**");
  assert.equal(calls[0].data.msg_type, "post");
  assert.equal(calls[0].data.receive_id, "oc_x");
  assert.deepEqual(JSON.parse(calls[0].data.content), buildFeishuMarkdown("这是**重点**"));
});

test("普通文本仍发 text 消息", async () => {
  const a = adapter();
  const calls = stubSend(a);
  await a.sendText("oc_x", "普通消息");
  assert.equal(calls[0].data.msg_type, "text");
  assert.equal(JSON.parse(calls[0].data.content).text, "普通消息");
});

test("富文本：markdown 片段独占 md 段落，表情另起一段", () => {
  const post = buildFeishuPost([
    { type: "text", text: "**重点**" },
    { type: "emoji", id: "强", key: "THUMBSUP" },
  ]);
  assert.deepEqual(post, { zh_cn: { content: [
    [{ tag: "md", text: "**重点**" }],
    [{ tag: "emotion", emoji_type: "THUMBSUP" }],
  ] } });
});

test("富文本：markdown 前面的文字单独成段，不拼进 md", () => {
  const post = buildFeishuPost([
    { type: "text", text: "开头" },
    { type: "text", text: "**重点**" },
    { type: "text", text: "结尾" },
  ]);
  assert.deepEqual(post, { zh_cn: { content: [
    [{ tag: "text", text: "开头" }],
    [{ tag: "md", text: "**重点**" }],
    [{ tag: "text", text: "结尾" }],
  ] } });
});
