import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTools } from "../src/agent/tools.ts";
import { Store } from "../src/core/db.ts";
import { loadConfig } from "../src/config.ts";

/** 假 Hub：记下每次 send 的内容，永远成功。 */
function setup(opts: {
  wake?: string;
  reasons?: string[];
  primaryPoolId?: string | null;
  pools?: { externalId: string; kind: "private" | "group"; title?: string }[];
} = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-bot-send-"));
  const cfg = { ...loadConfig(), dataDir };
  if (opts.primaryPoolId !== undefined) {
    cfg.sendReview = { ...(cfg.sendReview ?? {}), primaryPoolId: opts.primaryPoolId } as any;
  }
  const store = new Store(":memory:");
  for (const p of opts.pools ?? []) store.upsertPool("feishu", p.externalId, p.kind, p.title ?? "");
  const sent: string[] = [];
  const hub = {
    send: async (_pool: string, content: string) => {
      sent.push(content);
      return { ok: true, sentParts: [{ confirmed: true }], newMessages: [] };
    },
  };
  const tools = createTools({
    store,
    hub: hub as any,
    cfg,
    now: () => Date.now(),
    profile: "ufa",
    currentWake: () => (opts.wake ? { type: opts.wake, reasons: opts.reasons } : null),
  });
  const send = (tools as any[]).find((t) => t.name === "chat");
  return { send, sent, store };
}

test("send：条数不设代码上限（交给提示词），连发 5 条都放行", async () => {
  const { send, sent } = setup();
  for (const t of ["一", "二", "三", "四", "五"]) {
    const r = await send.execute("c", { action: "send", pool: "p1", content: t });
    assert.equal(r.details.ok, true, `第 ${sent.length} 条不该被代码拦`);
  }
  assert.equal(sent.length, 5);
});

test("send：plan 主动消息命中情感绑架时被拦，不调 hub", async () => {
  const { send, sent } = setup({ wake: "plan" });
  const r = await send.execute("c", { action: "send", pool: "p1", content: "我一直在等你回消息" });
  assert.equal(r.details.ok, false);
  assert.equal(r.details.blocked, "coercive");
  assert.equal(sent.length, 0);
});

test("send：日常对话（message 唤醒）不过情感绑架护栏", async () => {
  const { send, sent } = setup({ wake: "message" });
  const r = await send.execute("c", { action: "send", pool: "p1", content: "你怎么还不回来，饭都凉了" });
  assert.equal(r.details.ok, true, "日常里这种话可能是玩笑，不该拦");
  assert.equal(sent.length, 1);
});

test("send：正常的主动消息照发", async () => {
  const { send, sent } = setup({ wake: "plan" });
  const r = await send.execute("c", { action: "send", pool: "p1", content: "刚吃完饭，想起你昨天说的那家店" });
  assert.equal(r.details.ok, true);
  assert.equal(sent.length, 1);
});

test("send：看门狗放行的那一轮不许往聊天池发消息", async () => {
  const { send, sent } = setup({ wake: "message", reasons: ["看门狗：放行项目内动作"] });
  const r = await send.execute("c", { action: "send", pool: "p1", content: "已建好 #12" });
  assert.equal(r.details.ok, false);
  assert.equal(r.details.blocked, "watchdog");
  assert.equal(sent.length, 0);
});

test("send：任务汇报只能发主聊天，发群聊被拦", async () => {
  const { send, sent } = setup({
    wake: "tick",
    reasons: ["任务事件 batch: 有未读"],
    primaryPoolId: "feishu:main",
    pools: [
      { externalId: "main", kind: "private", title: "主对话" },
      { externalId: "proj", kind: "group", title: "项目组" },
    ],
  });
  const bad = await send.execute("c", { action: "send", pool: "p2", content: "#80 完成了" });
  assert.equal(bad.details.ok, false);
  assert.equal(bad.details.blocked, "main-pool-only");
  assert.equal(sent.length, 0);

  const ok = await send.execute("c", { action: "send", pool: "p1", content: "#80 完成了" });
  assert.equal(ok.details.ok, true, JSON.stringify(ok.details));
  assert.equal(sent.length, 1);
});

test("send：任务汇报没设主聊天时 fail-closed，不往群聊发", async () => {
  const { send, sent } = setup({
    wake: "tick",
    reasons: ["任务事件 batch: 有未读"],
    pools: [{ externalId: "proj", kind: "group", title: "项目组" }],
  });
  const r = await send.execute("c", { action: "send", pool: "p1", content: "#80 完成了" });
  assert.equal(r.details.ok, false);
  assert.equal(r.details.blocked, "main-pool-unset");
  assert.equal(sent.length, 0);
});

test("send：普通群聊消息（非任务汇报）仍可直接发群", async () => {
  const { send, sent } = setup({
    wake: "message",
    primaryPoolId: "feishu:main",
    pools: [
      { externalId: "main", kind: "private", title: "主对话" },
      { externalId: "proj", kind: "group", title: "项目组" },
    ],
  });
  const r = await send.execute("c", { action: "send", pool: "p2", content: "收到，我看一下" });
  assert.equal(r.details.ok, true, JSON.stringify(r.details));
  assert.equal(sent.length, 1);
});
