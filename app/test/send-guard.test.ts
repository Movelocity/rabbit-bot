import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTools } from "../src/agent/tools.ts";
import { Store } from "../src/core/db.ts";
import { loadConfig } from "../src/config.ts";

/** 假 Hub：记下每次 send 的内容，永远成功。 */
function setup(opts: { wake?: string; sent?: string[] } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "poolchat-send-"));
  const cfg = { ...loadConfig(), dataDir };
  const sent: string[] = opts.sent ?? [];
  let count = 0;
  const hub = {
    send: async (_pool: string, content: string) => {
      sent.push(content);
      // 计数只由 bumpSend 递增（真实代码里 hub 不碰这个计数器），这里别重复加
      return { ok: true, sentParts: [{ confirmed: true }], newMessages: [] };
    },
  };
  const tools = createTools({
    store: new Store(":memory:"),
    hub: hub as any,
    cfg,
    now: () => Date.now(),
    currentWake: () => (opts.wake ? { type: opts.wake } : null),
    sendsThisWake: () => count,
    bumpSend: () => { count += 1; },
  });
  const send = (tools as any[]).find((t) => t.name === "send");
  return { send, sent };
}

test("send：一轮连发 3 条以内正常，第 4 条被拦下", async () => {
  const { send, sent } = setup();
  for (const t of ["一", "二", "三"]) {
    const r = await send.execute("c", { pool: "p1", content: t });
    assert.equal(r.details.ok, true, `第 ${sent.length} 条该发出去`);
  }
  const blocked = await send.execute("c", { pool: "p1", content: "四" });
  assert.equal(blocked.details.ok, false);
  assert.equal(blocked.details.blocked, "too-many");
  assert.deepEqual(sent, ["一", "二", "三"], "第 4 条不该到 hub");
  assert.match(blocked.content[0].text, /刷屏/);
});

test("send：plan 主动消息命中情感绑架时被拦，不调 hub", async () => {
  const { send, sent } = setup({ wake: "plan" });
  const r = await send.execute("c", { pool: "p1", content: "我一直在等你回消息" });
  assert.equal(r.details.ok, false);
  assert.equal(r.details.blocked, "coercive");
  assert.equal(sent.length, 0);
});

test("send：日常对话（message 唤醒）不过情感绑架护栏", async () => {
  const { send, sent } = setup({ wake: "message" });
  const r = await send.execute("c", { pool: "p1", content: "你怎么还不回来，饭都凉了" });
  assert.equal(r.details.ok, true, "日常里这种话可能是玩笑，不该拦");
  assert.equal(sent.length, 1);
});

test("send：正常的主动消息照发", async () => {
  const { send, sent } = setup({ wake: "plan" });
  const r = await send.execute("c", { pool: "p1", content: "刚吃完饭，想起你昨天说的那家店" });
  assert.equal(r.details.ok, true);
  assert.equal(sent.length, 1);
});
