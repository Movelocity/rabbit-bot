import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startInjectServer } from "../src/inject.ts";
import { Hub } from "../src/core/hub.ts";
import { Store } from "../src/core/db.ts";
import { loadConfig } from "../src/config.ts";

const log: any = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, wake: () => {} };

function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "poolchat-inject-"));
  const cfg = { ...loadConfig(), dataDir, inject: { port: 0 } };
  const store = new Store(":memory:");
  const hub = new Hub(store, cfg, log, {} as any);
  // 先造一个飞书私聊池
  store.insertMessage({
    platform: "feishu", external_chat_id: "oc_inject", pool_kind: "private", msg_id: "m0",
    sender_id: "ou_1", sender_name: "主人", ts: Date.now(), text: "上下文", reply_to: null,
    mentions: [], is_mention_me: false, media_type: "text", from_self: false,
  } as any);
  return { cfg, store, hub, dataDir };
}

const TOKEN = "0123456789abcdef0123456789abcdef";

test("没有 token 就不启动（fail-closed）", async () => {
  const { cfg, store, hub } = setup();
  const old = process.env.POOLCHAT_INJECT_TOKEN;
  delete process.env.POOLCHAT_INJECT_TOKEN;
  const srv = await startInjectServer({ cfg, hub, store, log });
  assert.equal(srv, null);
  if (old) process.env.POOLCHAT_INJECT_TOKEN = old;
});

test("本地入口：鉴权、入池、参数校验", async () => {
  const { cfg, store, hub } = setup();
  process.env.POOLCHAT_INJECT_TOKEN = TOKEN;
  const srv = await startInjectServer({ cfg, hub, store, log });
  assert.ok(srv, "应当启动");
  const port = (srv!.address() as any).port;
  const url = `http://127.0.0.1:${port}/inject`;
  const post = (body: any, tok = TOKEN) =>
    fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-poolchat-token": tok }, body: JSON.stringify(body) });

  try {
    // token 不对
    let r = await post({ text: "hi" }, "wrong-token-wrong-token-wrong-token");
    assert.equal(r.status, 401);

    // 非 POST
    r = await fetch(`http://127.0.0.1:${port}/inject`, { method: "GET" });
    assert.equal(r.status, 404);

    // 空文本
    r = await post({ text: "   " });
    assert.equal(r.status, 400);

    // 正常注入
    r = await post({ text: "明天九点提醒主人开会", sender: "大肥鱼" });
    assert.equal(r.status, 200);
    const j: any = await r.json();
    assert.equal(j.ok, true);
    assert.match(j.pool, /^p\d+$/);

    const rows = store.db.prepare("select text, sender_name from messages where msg_id like 'inject-%'").all() as any[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].text, "明天九点提醒主人开会");
    assert.equal(rows[0].sender_name, "大肥鱼");

    // 池不存在
    r = await post({ text: "x", pool: "p999" });
    assert.equal(r.status, 404);

    // body 过大
    r = await post({ text: "x".repeat(20000) });
    assert.equal(r.status, 413);
  } finally {
    await new Promise<void>((res) => srv!.close(() => res()));
  }
});
