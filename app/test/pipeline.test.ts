/** 端到端：mock 适配器 → 池 → 调度/队列 → 真实 pi 会话（faux 桩模型）→ send → mock 适配器 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import "../src/env-defaults.ts";
import { loadConfig } from "../src/config.ts";
import { App } from "../src/app.ts";
import { MockAdapter } from "../src/adapters/mock.ts";
import { createFauxModel } from "../src/agent/faux.ts";
import { FakeClock } from "../src/core/clock.ts";
import { Logger } from "../src/core/logger.ts";

async function setup(over: any = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "poolchat-test-"));
  const cfg = loadConfig({
    dataDir, logDir: path.join(dataDir, "logs"),
    send: { confirmWaitMs: 30 }, llm: { provider: "faux", model: "faux-brain" },
    emoji: { map: { 微笑: { text: "🙂" } } }, ...over,
  });
  const { model, modelRuntime } = await createFauxModel(dataDir);
  const clock = new FakeClock(Date.parse("2026-10-22T01:00:00Z"));
  const app = new App({ cfg, model, modelRuntime, clock, logger: new Logger(null, true), inMemorySessions: true });
  const mock = new MockAdapter();
  app.hub.addAdapter(mock);
  const wakes: any[] = [];
  app.onWakeDone = (e) => wakes.push(e);
  await app.start();
  const dm = (text: string, from = "alice") => mock.inject({ chat: "dm-" + from, kind: "private", from, text, ts: clock.now() });
  const grp = (text: string, mention = false, from = "bob") => mock.inject({ chat: "grp", kind: "group", from, text, mentionMe: mention, ts: clock.now() });
  const settle = async (ms = 0) => { clock.advance(ms); await new Promise((r) => setTimeout(r, 5)); await app.queue.idle(); };
  const done = async () => { await app.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); };
  return { app, mock, wakes, clock, cfg, dm, grp, settle, done };
}

test("私聊连发 → 去抖合并为一次唤醒 → send 发出（含 [emoji:中文id] 解析）", async () => {
  const t = await setup();
  t.dm("你好");
  t.clock.advance(5_000);
  t.dm("在吗 [emoji:微笑]");
  await t.settle(29_000);
  assert.equal(t.wakes.length, 0, "去抖未到不唤醒");
  await t.settle(1_000);
  assert.equal(t.wakes.length, 1);
  assert.equal(t.wakes[0].outcome, "ok");
  assert.equal(t.wakes[0].read.length, 2);
  assert.deepEqual(t.mock.sent.map((s) => s.content), ["收到：在吗 🙂"]);
  assert.deepEqual(t.app.store.poolsWithUnread(), []);
  await t.done();
});

test("send 后等待确认并把期间的新消息作为返回值交给 Agent", async () => {
  const t = await setup();
  let once = false;
  t.mock.onSent = () => { if (!once) { once = true; t.dm("对了还有件事"); } };
  t.dm("hi");
  await t.settle(30_000);
  assert.deepEqual(t.mock.sent.map((s) => s.content), ["收到：hi", "又收到：对了还有件事"]);
  const sendResult = t.wakes[0].tools[0].result as string;
  assert.match(sendResult, /已发送并确认/);
  assert.match(sendResult, /期间新消息/);
  // 插话触发的去抖唤醒到点后：消息已读，不调用 LLM
  await t.settle(30_000);
  assert.equal(t.wakes[1].outcome, "skipped:nothing-new");
  assert.equal(t.wakes[1].llmCalls, undefined);
  await t.done();
});

test("群聊：未@ 只在 tick 读到、可不说话；被@ 立即走去抖唤醒", async () => {
  const t = await setup();
  t.grp("大家好");
  await t.settle(30_000);
  assert.equal(t.wakes.length, 0, "未@ 不走去抖");
  await t.settle(30_000); // 活跃期 tick = 60s
  assert.equal(t.wakes.length, 1);
  assert.equal(t.wakes[0].type, "tick");
  assert.equal(t.mock.sent.length, 0);
  t.grp("@小池 在吗", true);
  await t.settle(30_000);
  assert.equal(t.wakes[1].type, "message");
  assert.equal(t.mock.sent.length, 1);
  await t.done();
});

for (const impl of ["pi-death-loop-guard", "builtin"] as const) {
  test(`防死循环（${impl}）：连续 10 次相同调用 → 第 10 次拦截并结束本轮`, async () => {
    const t = await setup({ loopGuard: { impl } });
    t.dm("/loop");
    await t.settle(30_000);
    const w = t.wakes[0];
    assert.equal(w.outcome, "aborted:loop-guard");
    assert.equal(w.tools.length, 10);
    assert.equal(w.tools.filter((x: any) => !x.isError).length, 9);
    assert.equal(w.tools[9].isError, true);
    assert.equal((t.app.engine as any).loopGuard, impl);
    await t.done();
  });
}

test("上下文达到上限 → 写交接文档存档 → 新会话带交接继续", async () => {
  const t = await setup({ handoff: { contextTokenLimit: 300 } });
  t.dm("第一句");
  await t.settle(30_000);
  assert.ok(t.wakes[0].handoffId, "应触发交接");
  const hs = t.app.store.listHandoffs();
  assert.equal(hs.length, 1);
  assert.ok(fs.existsSync(hs[0].file));
  assert.match(fs.readFileSync(hs[0].file, "utf8"), /交接文档/);
  t.dm("第二句");
  await t.settle(30_000);
  assert.equal(t.wakes[1].handoffIncluded, true);
  assert.deepEqual(t.mock.sent.map((s) => s.content), ["收到：第一句", "收到：第二句"]);
  await t.done();
});

test("每日 LLM 调用上限：超过后跳过唤醒（不调用 LLM），消息保留未读", async () => {
  const t = await setup({ limits: { dailyLlmCalls: 2 } });
  t.dm("a");
  await t.settle(30_000);
  assert.equal(t.wakes[0].llmCalls, 2);
  t.dm("b");
  await t.settle(30_000);
  assert.equal(t.wakes[1].outcome, "skipped:daily-cap");
  assert.equal(t.app.store.poolsWithUnread().length, 1);
  await t.done();
});

test("暂停开关：暂停时不唤醒，恢复后 tick 处理积压", async () => {
  const t = await setup();
  t.app.store.setPaused(true);
  t.dm("暂停中");
  await t.settle(200_000);
  assert.equal(t.wakes.length, 0);
  t.app.store.setPaused(false);
  await t.settle(180_000);
  assert.equal(t.wakes.length, 1);
  assert.deepEqual(t.mock.sent.map((s) => s.content), ["收到：暂停中"]);
  await t.done();
});

test("计划：Agent 用 plan_add 写计划 → 到点 tick 命中 → 走队列唤醒并提醒", async () => {
  const t = await setup();
  t.dm("/plan 提醒我");
  await t.settle(30_000);
  const plans = t.app.store.listPlans();
  assert.equal(plans.length, 1);
  assert.equal(plans[0].schedule_kind, "once");
  await t.settle(120_000);
  const pw = t.wakes.find((w) => w.type === "plan");
  assert.ok(pw, "应有计划唤醒");
  assert.ok(t.mock.sent.some((s) => s.content.startsWith("⏰ 提醒")));
  assert.equal(t.app.store.getPlan(plans[0].id)!.status, "done");
  await t.done();
});

test("记忆按 user_id 存，来源与可见范围默认按池类型", async () => {
  const t = await setup();
  t.dm("记住我喜欢喝茶");
  await t.settle(30_000);
  const row: any = t.app.store.db.prepare("SELECT * FROM memories").get();
  assert.equal(row.scope, "private");
  assert.match(row.user_id, /^u_/);
  await t.done();
});

test("飞书内置表情：[emoji:捂脸] 走富文本（文字+表情合成一条），覆盖表仍优先", async () => {
  const t = await setup();
  t.dm("笑死[emoji:捂脸][emoji:微笑]");
  await t.settle(30_000);
  assert.equal(t.mock.sent.length, 1);
  assert.equal(t.mock.sent[0].kind, "rich");
  assert.equal(t.mock.sent[0].content, "收到：笑死<FACEPALM>🙂");
  await t.done();
});

test("事故复现（端到端）：入池后 VM 冻结 221s → 恢复后看门狗立即唤醒并经 HTTP 发送；重复投递不产生第二次唤醒、不占 seq", async () => {
  const t = await setup();
  const m = t.dm("你会做什么");
  await t.settle(6_000);
  t.clock.freeze(221_000);
  // 平台在重连后重投同一条
  t.mock.inject({ chat: "dm-alice", kind: "private", from: "alice", text: "你会做什么", ts: t.clock.now(), msgId: m.msg_id });
  await t.settle(5_000);
  assert.equal(t.wakes.length, 1);
  assert.equal(t.wakes[0].outcome, "ok");
  assert.deepEqual(t.mock.sent.map((s) => s.content), ["收到：你会做什么"]);
  await t.settle(120_000);
  assert.equal(t.wakes.filter((w) => w.outcome === "ok").length, 1);
  const pool = t.app.store.poolsWithUnread().length === 0 ? t.app.store.resolvePool("mock:dm-alice")! : null;
  const seqs = t.app.store.messagesAfter(pool!.pool_id, 0).map((x) => x.seq);
  assert.deepEqual(seqs, seqs.map((_, i) => seqs[0] + i), "重复投递不占 seq");
  await t.done();
});
