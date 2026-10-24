import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTools } from "../src/agent/tools.ts";
import { Store } from "../src/core/db.ts";
import { loadConfig } from "../src/config.ts";

/** 带沉默状态的假环境：silent / sent 都按轮次算 */
function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "poolchat-silent-"));
  const cfg = { ...loadConfig(), dataDir };
  const sent: string[] = [];
  let silent: string | null = null;
  const hub = {
    send: async (_p: string, content: string) => {
      sent.push(content);
      return { ok: true, sentParts: [{ confirmed: true }], newMessages: [] };
    },
  };
  const tools = createTools({
    store: new Store(":memory:"),
    hub: hub as any,
    cfg,
    now: () => Date.now(),
    currentWake: () => ({ type: "message" }),
    silenceReason: () => silent,
    markSilent: (r: string) => { silent = r; },
    alreadySent: () => sent.length > 0,
  });
  const get = (n: string) => (tools as any[]).find((t) => t.name === n);
  return { send: get("send"), staySilent: get("stay_silent"), sent, silent: () => silent };
}

test("stay_silent：存在且不发送任何消息", async () => {
  const { staySilent, sent } = setup();
  assert.ok(staySilent, "工具必须存在——它是唯一能表达「不回」的方式");
  const r = await staySilent.execute("c", { reason: "他说了不用回" });
  assert.equal(r.details.ok, true);
  assert.equal(sent.length, 0, "沉默不该产生任何消息");
});

test("stay_silent 之后 send 被拦：两个决定不能同时成立", async () => {
  const { staySilent, send, sent, silent } = setup();
  await staySilent.execute("c", { reason: "只是个表情" });
  assert.equal(silent(), "只是个表情");
  const r = await send.execute("c", { pool: "p1", content: "好，那我不回" });
  assert.equal(r.details.ok, false);
  assert.equal(r.details.blocked, "silent");
  assert.equal(sent.length, 0, "「好，那我不回」这种话不该发出去");
});

test("已经 send 过再 stay_silent 被拒", async () => {
  const { staySilent, send, sent } = setup();
  await send.execute("c", { pool: "p1", content: "在呢" });
  assert.equal(sent.length, 1);
  const r = await staySilent.execute("c", { reason: "算了" });
  assert.equal(r.details.ok, false);
});

test("正常回复流程不受影响", async () => {
  const { send, sent } = setup();
  const r = await send.execute("c", { pool: "p1", content: "在的" });
  assert.equal(r.details.ok, true);
  assert.equal(sent.length, 1);
});
