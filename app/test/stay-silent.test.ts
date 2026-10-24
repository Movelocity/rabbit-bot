import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTools } from "../src/agent/tools.ts";
import { Store } from "../src/core/db.ts";
import { loadConfig } from "../src/config.ts";

/** 最小环境：只验证 stay_silent 自身「不发消息、只记理由」 */
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
  });
  const get = (n: string) => (tools as any[]).find((t) => t.name === n);
  return { send: get("send"), staySilent: get("stay_silent"), sent, silent: () => silent };
}

test("stay_silent：存在，且不发送任何消息", async () => {
  const { staySilent, sent } = setup();
  assert.ok(staySilent, "工具必须存在——它是唯一能表达「不回」的方式");
  const r = await staySilent.execute("c", { reason: "他说了不用回" });
  assert.equal(r.details.ok, true);
  assert.equal(sent.length, 0, "沉默不该产生任何消息");
});

test("stay_silent：理由被记下来（日志里能看到它为什么沉默）", async () => {
  const { staySilent, silent } = setup();
  await staySilent.execute("c", { reason: "只是个表情" });
  assert.equal(silent(), "只是个表情");
});

test("正常回复流程不受影响", async () => {
  const { send, sent } = setup();
  const r = await send.execute("c", { pool: "p1", content: "在的" });
  assert.equal(r.details.ok, true);
  assert.equal(sent.length, 1);
});
