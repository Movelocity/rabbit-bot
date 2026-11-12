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
import { addMemory } from "../src/ops/memories.ts";
import { createTask, markPendingTick, updateTask } from "../src/core/tasks.ts";
import { appendTaskEvent } from "../src/core/task-events.ts";

async function setup(over: any = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-bot-test-"));
  const cfg = loadConfig({
    dataDir, logDir: path.join(dataDir, "logs"), runtimeDir: path.join(dataDir, "runtime"),
    exec: { dir: path.join(dataDir, "sandbox") },
    send: { confirmWaitMs: 30 }, llm: { provider: "faux", model: "faux-brain" },
    emoji: { map: { 微笑: { text: "🙂" } } }, ...over,
  });
  // 默认按「每条消息各自去抖唤醒」跑（老链路），要测 tick 批处理的那条自己打开
  if (over.batchToTick === undefined) cfg.scheduler.batchToTick = false;
  // 分条节奏默认关掉：这层测的是链路，不该每条之间都真等一秒
  if (cfg.send.pacing === undefined) cfg.send.pacing = { enabled: false };
  // 主动开口默认关掉：这层用例守的是「别把用户晾着」「别每 3 分钟叫一次」这类链路行为，
  // 不该被「她现在想不想说话」左右。专测主动的用例自己传 proactive 打开。
  if ((over as any).proactive === undefined) {
    cfg.proactive = { ...(cfg.proactive ?? {}), enabled: false };
  }
  const { model, modelRuntime } = await createFauxModel(dataDir);
  const clock = new FakeClock(Date.parse("2026-10-22T01:00:00Z"));
  // rb 工具在线上走容器里的客户端；这里注入进程内实现（mem-add），
  // 只测调度和 agent 流程，HTTP 传输由 test/rb-client.test.ts 单独锁。
  let appRef: App | undefined;
  const rbExec = async (argv: string[]): Promise<{ ok: boolean; code: number; output: string }> => {
    const pos: string[] = [];
    const flags: Record<string, string> = {};
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (!a.startsWith("--")) { pos.push(a); continue; }
      const k = a.slice(2);
      const v = argv[i + 1];
      if (v !== undefined && !v.startsWith("--")) { flags[k] = v; i++; } else flags[k] = "";
    }
    try {
      if (pos[0] === "mem-add") {
        const data = addMemory(appRef!.store, { user: flags.user, content: flags.content, pool: flags.pool, kind: flags.kind, scope: flags.scope as any, from: flags.from, until: flags.until, supersede: flags.supersede });
        return { ok: true, code: 0, output: JSON.stringify({ ok: true, data }) };
      }
      return { ok: false, code: 1, output: JSON.stringify({ ok: false, error: `测试未实现：${pos[0]}` }) };
    } catch (e) {
      return { ok: false, code: 1, output: JSON.stringify({ ok: false, error: (e as Error).message }) };
    }
  };
  const app = new App({ cfg, model, modelRuntime, clock, logger: new Logger(null, true), inMemorySessions: true, rbExec });
  appRef = app;
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
  t.clock.advance(2_000);
  t.dm("在吗 [emoji:微笑]");
  // 去抖窗口从配置里取，别在这里写死：它已经从 30s 降到 5s 过一次
  const debounce = (t.app as any).o.cfg.scheduler.debounceMs;
  await t.settle(debounce - 1_000);
  assert.equal(t.wakes.length, 0, "去抖未到不唤醒");
  await t.settle(1_500);
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

/** 塞一条「她想说话了」的自省结果，让门控有分可判 */
function seedReflection(t: any, poolId: string, over: Record<string, unknown> = {}) {
  const now = t.clock.now();
  t.app.store.saveReflection({
    user_id: "mia", pool_id: poolId, thought: "想问问他吃饭没", style_hint: "随口问一句",
    urgency: 0.9, topic_pick: "晚饭", topic_angle: "别像在检查", next_at: now + 3600_000, created_at: now,
    ...over,
  });
}

test("tick：没有未读，但自省说她想说 → 仍然给一次自己找话题的机会", async () => {
  const t = await setup({ proactive: { enabled: true } });
  const now = t.clock.now();
  // 三轮对话，都直接入库（不进未读队列），模拟「聊完了、人没再说话」
  let lastMsg: any = null;
  for (const [i, min] of [40, 37, 34].entries()) {
    lastMsg = t.app.store.insertMessage({
      platform: "mock", external_chat_id: "dm-mia", pool_kind: "private", msg_id: `w${i}`,
      sender_id: "mia", sender_name: "mia", ts: now - min * 60_000,
      text: ["今天加班到九点", "饭都没吃", "刚到家"][i],
      reply_to: null, mentions: [], is_mention_me: false, media_type: "text",
    });
  }
  t.app.store.setCursor(lastMsg.pool_id, lastMsg.seq);
  assert.equal(t.app.store.poolsWithUnread().length, 0, "前提：没有未读");
  seedReflection(t, lastMsg.pool_id);

  assert.equal(t.app.scheduler.tick(), true, "自省过了门控，tick 必须入队");
  await t.settle(0);
  const last = t.wakes[t.wakes.length - 1];
  assert.equal(last.type, "tick");
  assert.notEqual(last.outcome, "skipped:nothing-new", "不该被当成「没新东西」跳过");
  await t.done();
});

test("平台关掉后，不再为它的历史池自省（飞书腾出去后别白烧 token）", async () => {
  // 2026-11-09：飞书适配器关掉后，库里的 feishu 池还在，自省照样每小时为它跑一次，
  // 白白烧 token，还把「那个频道永远没人回」当成她自己的问题。
  const t = await setup({ proactive: { enabled: true }, adapters: { mock: { enabled: false } } });
  const now = t.clock.now();
  const last = t.app.store.insertMessage({
    platform: "mock", external_chat_id: "dm-mia", pool_kind: "private", msg_id: "dead1",
    sender_id: "mia", sender_name: "mia", ts: now - 20 * 60_000, text: "先这样，我忙",
    reply_to: null, mentions: [], is_mention_me: false, media_type: "text",
  });
  t.app.store.setCursor(last.pool_id, last.seq);
  seedReflection(t, last.pool_id);
  assert.equal(t.app.scheduler.tick(), false, "平台已关，不该再为它的池自省");
  await t.done();
});

test("任务池不产生主动唤醒（进度事件不是「她想说话了」）", async () => {
  const t = await setup({ proactive: { enabled: true } });
  const now = t.clock.now();
  // 有个正常的私聊池垫底，确保全局沉默时间是算得出来的
  const dm = t.app.store.insertMessage({
    platform: "mock", external_chat_id: "dm-mia", pool_kind: "private", msg_id: "dm-old",
    sender_id: "mia", sender_name: "mia", ts: now - 40 * 60_000, text: "先忙了",
    reply_to: null, mentions: [], is_mention_me: false, media_type: "text",
  })!;
  t.app.store.setCursor(dm.pool_id, dm.seq);
  const task = t.app.store.insertMessage({
    platform: "task", external_chat_id: "task:7", pool_kind: "task", msg_id: "task-e1",
    sender_id: "task", sender_name: "任务", ts: now - 40 * 60_000, text: "任务 #7 进度 50%",
    reply_to: null, mentions: [], is_mention_me: false, media_type: "text",
  })!;
  t.app.store.setCursor(task.pool_id, task.seq);
  seedReflection(t, task.pool_id);
  assert.equal(t.app.scheduler.tick(), false, "任务池不该进主动候选");
  await t.done();
});

test("任务池不跑自省（别对任务进度做内省）", async () => {
  const t = await setup({ proactive: { enabled: true } });
  const now = t.clock.now();
  const task = t.app.store.insertMessage({
    platform: "task", external_chat_id: "task:8", pool_kind: "task", msg_id: "task-e2",
    sender_id: "task", sender_name: "任务", ts: now - 40 * 60_000, text: "任务 #8 失败",
    reply_to: null, mentions: [], is_mention_me: false, media_type: "text",
  })!;
  t.app.store.setCursor(task.pool_id, task.seq);
  // 到期且没有后续自省：不跳过的话这一轮就会真的调模型写一条
  seedReflection(t, task.pool_id, { created_at: now - 1000, next_at: now - 1 });
  const before = t.app.store.latestReflection(task.pool_id)!.created_at;
  await (t.app as any).reflectDue();
  assert.equal(t.app.store.latestReflection(task.pool_id)!.created_at, before, "任务池不该被自省");
  await t.done();
});

test("tick 主动：说过一次之后，冷却期内不再问（也别每 3 分钟问一次）", async () => {
  const t = await setup({ proactive: { enabled: true } });
  const now = t.clock.now();
  let lastMsg: any = null;
  for (const [i, min] of [40, 37, 34].entries()) {
    lastMsg = t.app.store.insertMessage({
      platform: "mock", external_chat_id: "dm-mia", pool_kind: "private", msg_id: `r${i}`,
      sender_id: "mia", sender_name: "mia", ts: now - min * 60_000,
      text: ["今天加班到九点", "饭都没吃", "刚到家"][i],
      reply_to: null, mentions: [], is_mention_me: false, media_type: "text",
    });
  }
  t.app.store.setCursor(lastMsg.pool_id, lastMsg.seq);
  seedReflection(t, lastMsg.pool_id, { urgency: 0.4 });

  assert.equal(t.app.scheduler.tick(), true, "第一次该叫醒她");
  await t.settle(0);
  // 真的说出去了：冷却从这一刻开始算
  t.app.store.logProactive({
    user_id: "mia", pool_id: lastMsg.pool_id, ts: t.clock.now(), decision: "speak", reason: "ok", urgency: 0.4,
  });
  t.clock.advance(3 * 60_000);
  assert.equal(t.app.scheduler.tick(), false, "urgency 0.4 要等约 6.6 分钟，3 分钟不该重问");
  await t.done();
});

test("tick 主动：她想了但决定不说，也会留一行账（agent_silent）", async () => {
  const t = await setup({ proactive: { enabled: true } });
  const now = t.clock.now();
  const m = t.app.store.insertMessage({
    platform: "mock", external_chat_id: "dm-mia", pool_kind: "private", msg_id: "s1",
    sender_id: "mia", sender_name: "mia", ts: now - 40 * 60_000, text: "睡了",
    reply_to: null, mentions: [], is_mention_me: false, media_type: "text",
  })!;
  t.app.store.setCursor(m.pool_id, m.seq);
  seedReflection(t, m.pool_id);
  assert.equal(t.app.scheduler.tick(), true);
  await t.settle(0);
  const rows = t.app.store.recentProactive(10);
  assert.ok(rows.length > 0, "开口与否都要记账，否则查不出「她今天为什么没说话」");
  assert.ok(rows.every((r: any) => typeof r.reason === "string" && r.reason.length > 0));
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

test("谈资：工作场景不再翻话题库，条目也不进提示词", async () => {
  const t = await setup();
  const pool = t.app.store.listPools()[0]?.pool_id ?? null;
  // 库里有一条，但不该出现在提示词里——话题不再由服务端挑
  const id = t.app.store.addTopic({ content: "冰箱里的钱拿去充原神", kind: "meme", pool_id: pool, source: "他发的视频", now: t.clock.now() });

  const seen: string[] = [];
  const orig = (t.app as any).engine.run.bind((t.app as any).engine);
  (t.app as any).engine.run = async (prompt: string, ...rest: any[]) => { seen.push(prompt); return orig(prompt, ...rest); };
  t.dm("在吗");
  await t.settle(30_000);
  const msgPrompt = seen[seen.length - 1] ?? "";
  // 话题库已从工作场景提示词里移除：不翻谈资，只报正事
  const fs = await import("node:fs");
  const sys = fs.readFileSync(new URL("../prompts/system.md", import.meta.url), "utf8");
  assert.doesNotMatch(sys, /\/work\/topics/, "工作场景不再告诉她话题库在哪");
  assert.doesNotMatch(sys, /part-topics\.md/, "不再给话题库指针");
  assert.match(sys, /scene-X\.md|scene-\{\{/, "主提示词要写清「读 scene-X.md」这条路由");
  assert.doesNotMatch(msgPrompt, /冰箱里的钱拿去充原神/, "话题条目不该被塞进提示词");

  await (t.app as any).handleWake({
    id: "w2", type: "tick", reasons: ["定时检查"], pools: new Set([pool].filter(Boolean)), planFires: [], wakeAt: t.clock.now(),
    proactive: [{ pool, stage: 1, a: 1.2, peak: 2.4, sessionTs: t.clock.now() - 3600e3, detail: "退潮第 1 档" }],
  });
  const tickPrompt = seen[seen.length - 1] ?? "";
  // 唤醒消息这层：只有信号和数据，不再重复贴话题库说明
  assert.match(tickPrompt, /【这一轮：tick】/);
  assert.match(tickPrompt, /scene-tick\.md/, "要指路");
  assert.doesNotMatch(tickPrompt, /冰箱里的钱拿去充原神/);
  assert.doesNotMatch(tickPrompt, new RegExp(`#${id}`), "不再有 id，也不再有 rb topic-used 记账");
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

test("群里未@：攒给 tick，tick 一次把这一分钟的消息全读走", async () => {
  const t = await setup({ batchToTick: true });
  t.grp("大家看这个", false);
  await t.settle(30_000);
  assert.equal(t.wakes.length, 0, "开了 batchToTick 群消息不该自己叫醒");
  // tick 活跃期 60s：到点后 tick 读到未读 → 唤醒
  await t.settle(30_000);
  await t.settle(1_000);
  assert.ok(t.wakes.length >= 1, "tick 应该把未读捡起来");
  assert.equal(t.wakes[0].type, "tick");
  const read = t.wakes[0].read ?? [];
  assert.ok(read.some((m: any) => m.text.includes("大家看这个")), "tick 唤醒要把消息读进去");
  await t.done();
});

test("私聊不等 tick：batchToTick 开着也走快路（他盯着屏幕等）", async () => {
  const t = await setup({ batchToTick: true });
  t.dm("在吗");
  const debounce = (t.app as any).o.cfg.scheduler.debounceMs;
  assert.ok(debounce <= 10_000, `私聊的去抖窗口该是几秒级，实际 ${debounce}ms`);
  await t.settle(debounce + 1_000);
  assert.equal(t.wakes.length, 1, "私聊该在去抖结束后立刻唤醒，而不是等 60s 的 tick");
  assert.equal(t.wakes[0].type, "message", "私聊走的是消息唤醒，不是 tick");
  await t.done();
});

test("记忆不主动注入：不灌正文/别名，只给 user_id 让她自己查", async () => {
  const t = await setup();
  t.dm("在吗");
  await t.settle(6_000);
  const pool = t.app.store.listPools()[0].pool_id;
  // user_id 是 users 表里映射出来的，不是 sender_id 原文
  const uid = t.app.store.lastUserId(pool)!;
  addMemory(t.app.store, { user: uid, content: "那个项目 → 电商 AI Agent", pool, kind: "alias" });
  addMemory(t.app.store, { user: uid, content: "他对花生过敏", pool });

  const seen: string[] = [];
  const orig = (t.app as any).engine.run.bind((t.app as any).engine);
  (t.app as any).engine.run = async (prompt: string, ...rest: any[]) => { seen.push(prompt); return orig(prompt, ...rest); };

  t.dm("那个项目进展怎么样");
  await t.settle(6_000);
  const p = seen[seen.length - 1] ?? "";
  assert.doesNotMatch(p, /说法对照/, "别名不再自动注入");
  assert.doesNotMatch(p, /他对花生过敏/, "记忆正文不再自动注入");
  assert.ok(p.includes(`user_id=${uid}`), "仍要告诉她 user_id，方便自己用 memory search");
  await t.done();
});

// ---------- 任务汇报：批量、合并、幂等 ----------

test("任务完成 → 任务 tick 只转述一次，多任务合并成一条", async () => {
  const t = await setup();
  const at = t.clock.now();
  const saved = t.app.store.insertMessage({
    platform: "mock", external_chat_id: "dm-relay", pool_kind: "private", msg_id: "m_relay",
    sender_id: "ou_1", sender_name: "他", ts: at, text: "帮我干活",
    reply_to: null, mentions: [], is_mention_me: false, media_type: "text",
  })!;
  const poolId = saved.pool_id;
  t.cfg.sendReview = { ...(t.cfg.sendReview ?? {}), primaryPoolId: poolId } as any;
  t.app.hub.takeUnread([poolId]);

  fs.mkdirSync(path.join(t.cfg.runtimeDir, "shared", "handoffs"), { recursive: true });
  for (let i = 0; i < 3; i++) {
    const task = createTask(t.app.store, { userId: "u1", poolId, name: `#活${i}`, goal: `目标${i}`, work_dir: process.cwd() });
    fs.writeFileSync(path.join(t.cfg.runtimeDir, "shared", "handoffs", `task-${task.id}.md`), `汇报正文 ${i}`, "utf8");
    updateTask(t.app.store, task.id, { status: "done", result: `结果${i}` });
    appendTaskEvent(t.app.store, task.id, { text: "任务完成", sender: "wa-1", senderName: "WA", ts: at });
  }
  markPendingTick(t.app.store, at);

  await t.settle(t.cfg.scheduler.taskTickMs + 100);
    const relayed = t.wakes.filter((w) => w.outcome === "task-updated:relayed");
  assert.equal(relayed.length, 1, "一次任务 tick 只转述一轮");
  assert.equal(relayed[0].relayed, true);
  assert.equal(relayed[0].tasks.length, 3, "三条任务合进同一轮");
  const digest = t.mock.sent.filter((s) => s.content.includes("任务结束：3 个"));
  assert.equal(digest.length, 1, `三个任务该合并成一条：${JSON.stringify(t.mock.sent)}`);

  const before = t.mock.sent.length;
  await t.settle(t.cfg.scheduler.taskTickMs + 100);
  assert.equal(t.mock.sent.length, before, "同一批任务不该重复转述");
  await t.done();
});

test("任务汇报冷却：5 分钟内不重复打扰，游标保留到下一轮", async () => {
  const t = await setup();
  const at = t.clock.now();
  const saved = t.app.store.insertMessage({
    platform: "mock", external_chat_id: "dm-relay2", pool_kind: "private", msg_id: "m_relay2",
    sender_id: "ou_1", sender_name: "他", ts: at, text: "继续干活",
    reply_to: null, mentions: [], is_mention_me: false, media_type: "text",
  })!;
  const poolId = saved.pool_id;
  t.cfg.sendReview = { ...(t.cfg.sendReview ?? {}), primaryPoolId: poolId } as any;
  t.app.hub.takeUnread([poolId]);

  const mk = (i: number) => {
    const task = createTask(t.app.store, { userId: "u1", poolId, name: `#批${i}`, goal: `目标${i}`, work_dir: process.cwd() });
    updateTask(t.app.store, task.id, { status: "done", result: `结果${i}` });
    appendTaskEvent(t.app.store, task.id, { text: "任务完成", sender: "wa-1", senderName: "WA", ts: t.clock.now() });
    return task;
  };

  mk(0);
  markPendingTick(t.app.store, t.clock.now());
  await t.settle(t.cfg.scheduler.taskTickMs + 100);
  const first = t.mock.sent.length;
  assert.ok(first > 0, "第一批应该已经转述");

  mk(1);
  markPendingTick(t.app.store, t.clock.now());
  await t.settle(t.cfg.scheduler.taskTickMs + 100);
  assert.equal(t.mock.sent.length, first, "冷却期内不重复转述");
  assert.ok(t.wakes.some((w) => w.outcome === "skipped:task-relay-cooldown"), "应记录冷却跳过");

  await t.done();
});
