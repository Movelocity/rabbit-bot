import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { App } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { saveImage } from "../src/core/media.ts";

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const log: any = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, wake: () => {} };

test("handleWake 会把图片消息的图传给引擎", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "poolchat-wake-"));
  const cfg = { ...loadConfig(), dataDir };
  // 引擎会被替换成假的，模型只要占位（不碰真实凭据/网络）
  const app = new App({ cfg, model: { id: "fake/model" } as any, modelRuntime: {} as any, logger: log, dbFile: ":memory:", inMemorySessions: true });
  const calls: any[] = [];
  (app as any).engine = {
    seenPools: new Set(),
    takePendingHandoff: () => null,
    run: async (prompt: string, _limits: any, images?: any[]) => {
      calls.push({ prompt, images });
      return { assistantText: "", toolCalls: [], llmCalls: 1, tokens: 5, aborted: false };
    },
    dispose: async () => {},
  };

  // 造一张落盘的图 + 一条图片消息
  fs.mkdirSync(path.join(dataDir, "media"), { recursive: true });
  const a = saveImage(PNG_1PX, { dir: path.join(dataDir, "media"), maxEdge: 1024, maxBytes: 512000 }, "wake1");
  const saved = app.hub.ingest({
    platform: "feishu", external_chat_id: "oc_wake", pool_kind: "private", pool_title: "测试",
    msg_id: "m_wake_1", sender_id: "ou_1", sender_name: "主人", ts: Date.now(), text: "[图片]",
    reply_to: null, mentions: [], is_mention_me: false, media_type: "image", from_self: false, attachment: a,
  } as any);
  assert.ok(saved);

  await app.handleWake({ type: "message", pools: new Set([saved!.pool_id]), planFires: [], reasons: ["测试"], enqueuedAt: Date.now() });

  assert.equal(calls.length, 1, "应当调用一次引擎");
  assert.ok(Array.isArray(calls[0].images), "第三个参数应是图片数组");
  assert.equal(calls[0].images.length, 1);
  assert.equal(calls[0].images[0].type, "image");
  assert.ok(calls[0].images[0].data.length > 10);
  assert.match(calls[0].prompt, /附带图片/);
  await app.stop?.();
});
