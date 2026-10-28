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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-bot-test-"));
  const cfg = loadConfig({
    dataDir, logDir: path.join(dataDir, "logs"),
    send: { confirmWaitMs: 30 }, llm: { provider: "faux", model: "faux-brain" },
    emoji: { map: { 微笑: { text: "🙂" } } }, ...over,
  });
  // 默认按「每条消息各自去抖唤醒」跑（老链路），要测 tick 批处理的那条自己打开
  if (over.batchToTick === undefined) cfg.scheduler.batchToTick = false;
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
  // 这条测的是「计划链路」，不是时机：关掉水位判定，否则刚聊完 30 秒的 L2 计划会被拦下
  const t = await setup({ tide: { wave: { enabled: false } } });
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

test("L2 计划到点但刚聊完：被水位拦下，记 skip（带水位），不弹计划", async () => {
  const t = await setup();
  t.dm("/plan 提醒我");
  await t.settle(30_000);
  await t.settle(120_000);
  assert.equal(t.wakes.some((w) => w.type === "plan"), false, "聊完 30 秒就弹计划，正是水位要挡的");
  const ev = t.app.store.recentTideEvents(5).find((e) => e.kind === "skip");
  assert.ok(ev, "该记一条 skip");
  assert.match(String(ev.reason), /水位/);
  assert.equal(typeof ev.wave_a, "number", "水位要落库，调参只看这列");
  await t.done();
});

test("tick：没有未读，但水位退到档 → 仍然给 agent 一次自己找话题的机会", async () => {
  const t = await setup();
  const now = t.clock.now();
  // 三轮对话，都直接入库（不进未读队列），模拟「聊完了、人没再说话」
  let lastMsg: any = null;
  for (const [i, min] of [40, 37, 34].entries()) {
    lastMsg = t.app.store.insertMessage({
      platform: "feishu", external_chat_id: "dm-mia", pool_kind: "private", msg_id: `w${i}`,
      sender_id: "mia", sender_name: "mia", ts: now - min * 60_000,
      text: ["今天加班到九点", "饭都没吃", "刚到家"][i],
      reply_to: null, mentions: [], is_mention_me: false, media_type: "text",
    });
  }
  // 这些消息「已经被读过了」：把游标推到最后，留出「没未读但水位还高」的局面
  t.app.store.setCursor(lastMsg.pool_id, lastMsg.seq);
  assert.equal(t.app.store.poolsWithUnread().length, 0, "前提：没有未读");
  const enqueued = t.app.scheduler.tick();
  assert.equal(enqueued, true, "水位到档时 tick 必须入队");
  await t.settle(0);
  const last = t.wakes[t.wakes.length - 1];
  assert.equal(last.type, "tick");
  assert.notEqual(last.outcome, "skipped:nothing-new", "不该被当成「没新东西」跳过");
  await t.done();
});

test("tick 主动：问过一档就不再重复问（不发也不该每 3 分钟叫一次）", async () => {
  const t = await setup();
  const now = t.clock.now();
  let lastMsg: any = null;
  for (const [i, min] of [40, 37, 34].entries()) {
    lastMsg = t.app.store.insertMessage({
      platform: "feishu", external_chat_id: "dm-mia", pool_kind: "private", msg_id: `r${i}`,
      sender_id: "mia", sender_name: "mia", ts: now - min * 60_000,
      text: ["今天加班到九点", "饭都没吃", "刚到家"][i],
      reply_to: null, mentions: [], is_mention_me: false, media_type: "text",
    });
  }
  t.app.store.setCursor(lastMsg.pool_id, lastMsg.seq);

  assert.equal(t.app.scheduler.tick(), true, "第一次该叫醒她");
  await t.settle(0);
  // 同一档：无论她发没发，都不该再叫
  t.clock.advance(3 * 60_000);
  assert.equal(t.app.scheduler.tick(), false, "同一档不能每 3 分钟重问一次");
  t.clock.advance(3 * 60_000);
  assert.equal(t.app.scheduler.tick(), false);
  await t.done();
});

test("额度用尽：发一条提示给等着的人，不走模型，也不进上下文", async () => {
  const t = await setup({ limits: { dailyLlmCalls: 0, dailyTokens: 0 } });
  t.dm("在吗");
  await t.settle(35_000);
  const hits = () => t.mock.sent.filter((x: any) => String(x.content).includes("额度用完"));
  assert.equal(hits().length, 1, `该发一条提示，实际发出：${JSON.stringify(t.mock.sent)}`);
  assert.match(String(hits()[0].content), /^〔系统〕/, "要带标记，让人看得出不是她说的话");
  // 不进上下文：任何池的库里都不该有这条
  for (const pool of t.app.store.listPools()) {
    const rows = t.app.store.recentMessages(pool.pool_id, 100) as any[];
    assert.equal(rows.filter((r: any) => String(r.text ?? "").includes("额度用完")).length, 0, "提示不能入库");
  }
  // 每天只发一次
  t.dm("还在吗");
  await t.settle(35_000);
  assert.equal(hits().length, 1, "一天只发一次");
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

test("模型报错：程序自己发一条系统提示（不走模型、不进上下文、不刷屏）", async () => {
  const t = await setup();
  // 让引擎这一轮直接失败，模拟接口 500 / 超时
  (t.app as any).engine.run = async () => ({
    llmCalls: 1, tokens: 0, toolCalls: [], assistantText: "", error: "上游接口 500",
  });
  t.dm("在吗");
  await t.settle(30_000);

  const hits = () => t.mock.sent.filter((x: any) => String(x.content).includes("〔系统〕"));
  assert.equal(hits().length, 1, `该发一条系统提示，实际发出：${JSON.stringify(t.mock.sent)}`);
  assert.match(String(hits()[0].content), /上游接口 500/, "要说清是什么故障，不能只发「出错了」");
  assert.match(String(hits()[0].content), /不是她说的/, "得让人看出这不是她的回复");

  // 不进上下文：库里不该有这条
  for (const pool of t.app.store.listPools()) {
    const rows = t.app.store.recentMessages(pool.pool_id, 100) as any[];
    assert.equal(rows.filter((r: any) => String(r.text ?? "").includes("〔系统〕")).length, 0, "系统提示不能入库");
  }
  // 游标没被消费：他这句话还等着，恢复后能接着回
  assert.equal(t.app.store.poolsWithUnread().length, 1, "报错不能让他的消息被吃掉");

  // 同一个故障在一小时内不重复发（报错往往连续触发）
  t.dm("还在吗");
  await t.settle(30_000);
  assert.equal(hits().length, 1, "一小时内只发一次，不能刷屏");
  await t.done();
});

test("没人等着的时候报错：不发系统提示，避免打扰", async () => {
  const t = await setup();
  (t.app as any).engine.run = async () => ({
    llmCalls: 1, tokens: 0, toolCalls: [], assistantText: "", error: "上游接口 500",
  });
  // 直接给一次 tick 唤醒：没有未读
  await (t.app as any).handleWake({
    id: "w1", type: "tick", reasons: ["定时检查"], pools: [], planFires: [], wakeAt: t.clock.now(),
  });
  assert.equal(t.mock.sent.length, 0, "没人在等就别发");
  await t.done();
});

test("谈资：只在水位 tick 时注入，有人说话时不给（她该接那句话，不是另起话题）", async () => {
  const t = await setup();
  const pool = t.app.store.listPools()[0]?.pool_id ?? null;
  const id = t.app.store.addTopic({ content: "冰箱里的钱拿去充原神", kind: "meme", pool_id: pool, source: "他发的视频", now: t.clock.now() });

  // 有人说话 → 不注入
  const seen: string[] = [];
  const orig = (t.app as any).engine.run.bind((t.app as any).engine);
  (t.app as any).engine.run = async (prompt: string, ...rest: any[]) => { seen.push(prompt); return orig(prompt, ...rest); };
  t.dm("在吗");
  await t.settle(30_000);
  assert.equal(seen.some((p) => p.includes("可以拿来聊的")), false, "有人说话时不该给谈资");

  // 水位 tick → 注入
  await (t.app as any).handleWake({
    id: "w2", type: "tick", reasons: ["定时检查"], pools: new Set([pool].filter(Boolean)), planFires: [], wakeAt: t.clock.now(),
    proactive: [{ pool, stage: 1, a: 1.2, peak: 2.4, sessionTs: t.clock.now() - 3600e3, detail: "退潮第 1 档" }],
  });
  const tickPrompt = seen[seen.length - 1] ?? "";
  assert.match(tickPrompt, /可以拿来聊的/, `tick 该给谈资，实际 prompt：${tickPrompt.slice(0, 200)}`);
  assert.match(tickPrompt, new RegExp(`#${id}`), "要带 id，不然她没法记账");
  assert.match(tickPrompt, /冰箱里的钱拿去充原神/);
  await t.done();
});

test("谈资：用过进冷却，冷却期内不再推；每天新增有上限", async () => {
  const t = await setup();
  const s = t.app.store;
  const now = t.clock.now();
  const a = s.addTopic({ content: "他上次说的冷笑话", kind: "joke", pool_id: null, source: "", now });
  const b = s.addTopic({ content: "另一个梗", kind: "meme", pool_id: null, source: "", now });

  assert.deepEqual(s.pickTopics(null, 5, now).map((x: any) => x.id), [b, a], "都没用过时按 id 倒序（新的先出）");
  s.markTopicUsed(a, now, 7);
  assert.deepEqual(s.pickTopics(null, 5, now).map((x: any) => x.id), [b], "用过的进冷却，不该再推");
  assert.deepEqual(s.pickTopics(null, 5, now + 8 * 86400e3).map((x: any) => x.id).sort(), [a, b].sort(), "冷却过了可以再用");
  assert.equal(s.countTopicsAddedSince(now - 1000), 2);
  await t.done();
});

test("消息攒给 tick：不单独唤醒，tick 一次把这一分钟的消息全读走", async () => {
  const t = await setup({ batchToTick: true });
  t.dm("在吗");
  await t.settle(30_000);
  assert.equal(t.wakes.length, 0, "开了 batchToTick 消息不该自己叫醒");
  // tick 活跃期 60s：到点后 tick 读到未读 → 唤醒
  await t.settle(30_000);
  await t.settle(1_000);
  assert.ok(t.wakes.length >= 1, "tick 应该把未读捡起来");
  assert.equal(t.wakes[0].type, "tick");
  const read = t.wakes[0].read ?? [];
  assert.ok(read.some((m: any) => m.text.includes("在吗")), "tick 唤醒要把消息读进去");
  await t.done();
});
