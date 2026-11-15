/** 飞书入站图片：image 消息与带图的富文本（post）都要落盘并带出稳定 id。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FeishuAdapter, imageKeysOf } from "../src/adapters/feishu.ts";
import { Logger } from "../src/core/logger.ts";
import type { InboundMessage } from "../src/types.ts";

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function adapter(dir: string) {
  return new FeishuAdapter(
    {
      appId: "test", appSecret: "test", domain: "feishu", fetchSenderName: false,
      media: { dir, maxEdge: 1024, maxBytes: 512000 },
    },
    new Logger(null, true),
  );
}

/** 假飞书下载接口：把一张 1x1 PNG 写到目标路径。 */
function stubDownload(a: FeishuAdapter, calls: string[] = []) {
  (a as any).client = {
    im: {
      messageResource: {
        get: async (p: any) => {
          calls.push(p.path.file_key);
          return { writeFile: async (file: string) => fs.writeFileSync(file, PNG_1PX) };
        },
      },
    },
  };
  return calls;
}

const event = (messageId: string, messageType: string, content: object) => ({
  sender: { sender_id: { open_id: "ou_1" }, sender_type: "user" },
  message: {
    message_id: messageId, chat_id: "oc_p2p", chat_type: "p2p", message_type: messageType,
    content: JSON.stringify(content), create_time: "1792641840000",
  },
});

async function deliver(a: FeishuAdapter, ev: ReturnType<typeof event>): Promise<InboundMessage> {
  const got: InboundMessage[] = [];
  (a as any).sink = (m: InboundMessage) => got.push(m);
  await a._deliver("im.message.receive_v1", ev);
  return got[0];
}

test("imageKeysOf 取 post 里的多张图", () => {
  const post = {
    zh_cn: {
      content: [
        [{ tag: "text", text: "看这两张" }],
        [{ tag: "img", image_key: "img_a" }, { tag: "img", image_key: "img_b" }],
      ],
    },
  };
  assert.deepEqual(imageKeysOf("post", JSON.stringify(post)), ["img_a", "img_b"]);
  assert.deepEqual(imageKeysOf("post", JSON.stringify({ zh_cn: { content: [[{ tag: "text", text: "纯文字" }]] } })), []);
});

test("富文本带图：按图片消息处理，下载落盘并写成 [图片#id]", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-bot-feishu-img-"));
  const a = adapter(dir);
  const calls = stubDownload(a);

  const m = await deliver(a, event("om_post_1", "post", {
    zh_cn: { content: [[{ tag: "text", text: "做一个圆角矩形 ico" }], [{ tag: "img", image_key: "img_v3_post" }]] },
  }));

  assert.equal(m.media_type, "image", "post 里有图就不能当纯文本");
  assert.ok(m.attachment, "应当有落盘附件");
  assert.equal(m.attachment!.mime, "image/jpeg");
  assert.ok(fs.existsSync(m.attachment!.path));
  assert.ok(m.attachment!.path.startsWith(dir), "图片要落在配置的 media/inbox 目录");
  assert.match(m.attachment!.id ?? "", /^img_[0-9a-f]{10}$/);
  assert.equal(path.basename(m.attachment!.path), `${m.attachment!.id}.jpg`);
  assert.equal(m.text, `做一个圆角矩形 ico\n[图片#${m.attachment!.id}]`);
  assert.deepEqual(calls, ["img_v3_post"]);
});

test("富文本多图：全部下载，占位按顺序替换成各自的 id", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-bot-feishu-img-"));
  const a = adapter(dir);
  const calls = stubDownload(a);

  const m = await deliver(a, event("om_post_2", "post", {
    zh_cn: { content: [[{ tag: "img", image_key: "img_one" }, { tag: "img", image_key: "img_two" }]] },
  }));

  assert.equal(m.media_type, "image");
  assert.deepEqual(calls, ["img_one", "img_two"]);
  const ids = [...m.text.matchAll(/\[图片#(img_[0-9a-f]+)\]/g)].map((x) => x[1]);
  assert.equal(ids.length, 2, "两张图都应带出 id");
  assert.equal(new Set(ids).size, 2, "id 不能重复");
  assert.equal(m.attachment!.id, ids[0], "主附件是第一张图");
  for (const id of ids) assert.ok(fs.existsSync(path.join(dir, `${id}.jpg`)));
});

test("图片下载失败：保留 [图片] 占位，消息照常入池", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-bot-feishu-img-"));
  const a = adapter(dir);
  (a as any).client = {
    im: { messageResource: { get: async () => { throw new Error("no permission"); } } },
  };

  const m = await deliver(a, event("om_img_bad", "image", { image_key: "img_nope" }));
  assert.equal(m.media_type, "image");
  assert.equal(m.attachment, null);
  assert.equal(m.text, "[图片]");
});
