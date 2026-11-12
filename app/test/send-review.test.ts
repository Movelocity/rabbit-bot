/** 出站审核闸门：同意 / 拒绝 / 超时 / 串行 / 去重 / 非主人 / Hub 接线 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SendReviewGate, resolveSendReviewConfig,
  type SendReviewConfig, type SendReviewRequest,
} from "../src/core/send-review.ts";
import {
  applySendReviewSettings, effectiveSendReviewSettings, loadSendReviewSettings, reviewRequiredFor,
  saveSendReviewSettings, validateSendReviewSettings,
} from "../src/ops/send-review-settings.ts";
import { Hub } from "../src/core/hub.ts";
import { Store } from "../src/core/db.ts";
import { loadConfig, validateConfig } from "../src/config.ts";
import type { InboundMessage } from "../src/types.ts";

const ROOM = "oc_review";
const OWNER = "u_owner";

const log: any = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function cfg(over: Partial<SendReviewConfig> = {}): SendReviewConfig {
  return { platform: "feishu", roomId: ROOM, ownerIds: [OWNER], timeoutMs: 3000, notify: false, ...over };
}

function react(key: string, over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: "feishu",
    external_chat_id: ROOM,
    pool_kind: "group",
    msg_id: `m${Math.random()}`,
    sender_id: OWNER,
    sender_name: "主人",
    ts: Date.now(),
    text: key,
    reply_to: null,
    mentions: [],
    is_mention_me: false,
    media_type: "reaction",
    from_self: false,
    reaction_key: key,
    reaction_to: null,
    ...over,
  };
}

function req(content: string, deliver = async () => ({ ok: true })): SendReviewRequest {
  return {
    platform: "feishu",
    chatId: "oc_group",
    poolRef: "feishu:oc_group",
    poolTitle: "测试群",
    kind: "group",
    content,
    deliver,
  };
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

test("没配好时不排队，直接返回错误（不会绕过审核发出去）", async () => {
  const g = new SendReviewGate(cfg({ roomId: "", ownerIds: [] }), log, async () => ({ ok: true }));
  assert.equal(g.enabled, false);
  const r = await g.propose(req("在吗"));
  assert.equal(r.queued, false);
  assert.match(r.error ?? "", /没配好/);
});

test("同意：先发预览，贴 OK 后才真正调 deliver；回一句状态", async () => {
  const outbox: string[] = [];
  let n = 0;
  let delivered = 0;
  const g = new SendReviewGate(cfg({ notify: true }), log, async (_t, text) => {
    outbox.push(text);
    return { ok: true, msgId: `r${++n}` };
  });
  const r = await g.propose(req("今晚吃火锅", async () => { delivered++; return { ok: true }; }));
  assert.equal(r.queued, true);
  assert.equal(r.id, 1);
  await tick();
  assert.equal(delivered, 0, "预览阶段不能发目标聊天");
  assert.match(outbox[0], /【发送审核】#1/);
  assert.match(outbox[0], /今晚吃火锅/);
  assert.match(outbox[0], /同意发送：给这条消息贴 OK \/ 👍 表情/);

  assert.equal(g.tryHandle(react("OK")), true);
  await tick();
  assert.equal(delivered, 1);
  assert.ok(outbox.some((t) => /#1 已批准并发送/.test(t)), `没回状态：${JSON.stringify(outbox)}`);
});

test("主对话：预览发到主对话池，表情也在主对话里裁决", async () => {
  const outbox: { chatId: string; text: string }[] = [];
  const g = new SendReviewGate(
    cfg({ roomId: "oc_room" }),
    log,
    async (target, text) => { outbox.push({ chatId: target.chatId, text }); return { ok: true, msgId: "r1" }; },
    () => ({ platform: "feishu", chatId: "oc_primary" }),
  );
  await g.propose(req("主对话也要收审批"));
  await tick();
  assert.equal(outbox[0].chatId, "oc_primary");

  // 贴错聊天不算数
  assert.equal(g.tryHandle(react("OK", { external_chat_id: "oc_room" })), false);
  assert.equal(g.tryHandle(react("OK", { external_chat_id: "oc_primary" })), true);
});

test("拒绝：贴 No 就不发送，deliver 不执行", async () => {
  const outbox: string[] = [];
  const g = new SendReviewGate(cfg({ notify: true }), log, async (_t, text) => { outbox.push(text); return { ok: true }; });
  await g.propose(req("这句别发", async () => { throw new Error("不该被调用"); }));
  await tick();
  assert.equal(g.tryHandle(react("No")), true);
  await tick();
  assert.equal(g.waiting.length, 0);
  assert.ok(outbox.some((t) => /#1 已驳回，不发送/.test(t)));
});

test("超时＝不发送，不是默认放行", async () => {
  const outbox: string[] = [];
  let delivered = 0;
  const g = new SendReviewGate(
    cfg({ timeoutMs: 1000, notify: true }),
    log,
    async (_t, text) => { outbox.push(text); return { ok: true }; },
  );
  await g.propose(req("超时测试", async () => { delivered++; return { ok: true }; }));
  await tick(1150);
  assert.equal(delivered, 0);
  assert.equal(g.waiting.length, 0);
  assert.ok(outbox.some((t) => /#1 超时未裁决，按不发送处理/.test(t)));
});

test("UDP：多条同时提交，各自发预览、各自裁决，不等前一条", async () => {
  const outbox: { text: string; msgId: string }[] = [];
  let n = 0;
  const g = new SendReviewGate(cfg(), log, async (_t, text) => {
    const msgId = `r${++n}`;
    outbox.push({ text, msgId });
    return { ok: true, msgId };
  });
  const delivered: string[] = [];
  const a = await g.propose(req("第一条", async () => { delivered.push("第一条"); return { ok: true }; }));
  const b = await g.propose(req("第二条", async () => { delivered.push("第二条"); return { ok: true }; }));
  await tick();
  assert.equal(a.id, 1);
  assert.equal(b.id, 2);
  assert.equal(outbox.filter((x) => x.text.includes("【发送审核】")).length, 2, "两条预览都应立即发出");
  assert.equal(g.waiting.length, 2);

  // 各贴各的：先批第二条，第一条不受影响
  assert.equal(g.tryHandle(react("OK", { reaction_to: "r2" })), true);
  await tick(20);
  assert.deepEqual(delivered, ["第二条"]);
  assert.equal(g.waiting.length, 1);

  assert.equal(g.tryHandle(react("No", { reaction_to: "r1" })), true);
  await tick();
  assert.equal(g.waiting.length, 0);
  assert.deepEqual(delivered, ["第二条"]);
});

test("同一条内容重复提交只保留一条（模型重试不会发双份）", async () => {
  const outbox: string[] = [];
  let n = 0;
  const g = new SendReviewGate(cfg(), log, async (_t, text) => { outbox.push(text); return { ok: true, msgId: `r${++n}` }; });
  const a = await g.propose(req("重复内容"));
  const b = await g.propose(req("重复内容"));
  assert.equal(a.id, b.id);
  await tick();
  assert.equal(outbox.filter((t) => t.includes("【发送审核】")).length, 1);
});

test("非主人 / 贴错消息 / 文字回复都不算裁决，消息照常放行", async () => {
  const g = new SendReviewGate(cfg(), log, async () => ({ ok: true, msgId: "r1" }));
  await g.propose(req("待审内容"));
  await tick();
  assert.equal(g.tryHandle(react("OK", { sender_id: "stranger" })), false);
  assert.equal(g.tryHandle(react("OK", { media_type: "text", text: "OK" })), false);
  assert.equal(g.tryHandle(react("OK", { reaction_to: "some-other-msg" })), false);
  assert.equal(g.waiting.length, 1);
  assert.equal(g.tryHandle(react("OK")), true);
});

test("Hub 接线：非系统消息先排队，审核通过后才落到目标聊天", async () => {
  const config = loadConfig();
  config.send.confirmWaitMs = 0;
  config.send.pacing.enabled = false;
  const store = new Store(":memory:");
  const hub = new Hub(store, config, log, {} as any);
  const sentToGroup: string[] = [];
  let n = 0;
  hub.addAdapter({
    platform: "feishu" as const,
    start: async () => {},
    stop: async () => {},
    sendText: async (_id: string, text: string) => { sentToGroup.push(text); return { msgId: `g${++n}` }; },
  } as any);

  const previews: string[] = [];
  let rn = 0;
  const gate = new SendReviewGate(cfg(), log, async (_t, text) => { previews.push(text); return { ok: true, msgId: `r${++rn}` }; });
  hub.review = { shouldReview: () => true, propose: (r) => gate.propose(r) };

  hub.ingest({
    platform: "feishu", external_chat_id: "oc_group", pool_kind: "group",
    msg_id: "u0", sender_id: "u1", sender_name: "他", ts: Date.now(), text: "聊点什么",
    reply_to: null, mentions: [], is_mention_me: false, media_type: "text",
  });
  hub.takeUnread();

  const r = await hub.send("feishu:oc_group", "今晚吃火锅");
  assert.equal(r.ok, true);
  assert.equal(r.queuedForReview, true);
  assert.equal(r.reviewId, 1);
  assert.deepEqual(sentToGroup, [], "审核没通过前目标群不能收到消息");
  assert.equal(store.unread("feishu:oc_group").length, 0);

  await tick();
  gate.tryHandle(react("OK"));
  await tick(20);
  assert.deepEqual(sentToGroup, ["今晚吃火锅"], "批准后才真正发出去");
  assert.ok(store.lastSelfMessageRow("feishu:oc_group")?.text.includes("火锅"));
});

test("审核未通过：在目标池写入调度器事件，让 agent 知道这条没发出去", async () => {
  const config = loadConfig();
  config.send.confirmWaitMs = 0;
  config.send.pacing.enabled = false;
  const store = new Store(":memory:");
  const hub = new Hub(store, config, log, {} as any);
  const sent: string[] = [];
  hub.addAdapter({
    platform: "feishu" as const,
    start: async () => {},
    stop: async () => {},
    sendText: async (_id: string, text: string) => { sent.push(text); return { msgId: `g${++sent.length}` }; },
  } as any);
  let rn = 0;
  const gate = new SendReviewGate(cfg(), log, async () => ({ ok: true, msgId: `r${++rn}` }));
  hub.review = { shouldReview: () => true, propose: (r) => gate.propose(r) };

  hub.ingest({
    platform: "feishu", external_chat_id: "oc_group", pool_kind: "group",
    msg_id: "u0", sender_id: "u1", sender_name: "他", ts: Date.now(), text: "聊点什么",
    reply_to: null, mentions: [], is_mention_me: false, media_type: "text",
  });
  hub.takeUnread();

  const r = await hub.send("feishu:oc_group", "这句会被驳回");
  assert.equal(r.queuedForReview, true);
  await tick();
  assert.equal(gate.tryHandle(react("No")), true);
  await tick();

  assert.deepEqual(sent, [], "驳回后目标群不能收到消息");
  const events = store.unread("feishu:oc_group").filter((m) => m.sender_name === "调度器");
  assert.equal(events.length, 1, "目标池应有一条调度器事件");
  assert.match(events[0].text, /没有发出/);
  assert.match(events[0].text, /这句会被驳回/);
  assert.equal(events[0].from_self, false);
});

test("Hub 接线：审核期间来的新消息不会被补发吃掉，留给下一次唤醒", async () => {
  const config = loadConfig();
  config.send.confirmWaitMs = 0;
  config.send.pacing.enabled = false;
  const store = new Store(":memory:");
  const hub = new Hub(store, config, log, {} as any);
  const sent: string[] = [];
  let n = 0;
  hub.addAdapter({
    platform: "feishu" as const,
    start: async () => {},
    stop: async () => {},
    sendText: async (_id: string, text: string) => { sent.push(text); return { msgId: `g${++n}` }; },
  } as any);
  let rn = 0;
  const gate = new SendReviewGate(cfg(), log, async () => ({ ok: true, msgId: `r${++rn}` }));
  hub.review = { shouldReview: () => true, propose: (r) => gate.propose(r) };

  hub.ingest({
    platform: "feishu", external_chat_id: "oc_group", pool_kind: "group",
    msg_id: "u0", sender_id: "u1", sender_name: "他", ts: Date.now(), text: "聊点什么",
    reply_to: null, mentions: [], is_mention_me: false, media_type: "text",
  });
  hub.takeUnread();

  const r = await hub.send("feishu:oc_group", "今晚吃火锅");
  assert.equal(r.queuedForReview, true);
  await tick();

  // 等审核期间他又说话了
  hub.ingest({
    platform: "feishu", external_chat_id: "oc_group", pool_kind: "group",
    msg_id: "u1", sender_id: "u1", sender_name: "他", ts: Date.now(), text: "真的吗",
    reply_to: null, mentions: [], is_mention_me: false, media_type: "text",
  });
  assert.equal(store.unread("feishu:oc_group").length, 1);

  gate.tryHandle(react("OK"));
  await tick(20);
  assert.deepEqual(sent, ["今晚吃火锅"]);
  // 补发不能把审核期间的新消息顺手标成已读，否则不会再触发唤醒
  assert.equal(store.unread("feishu:oc_group").length, 1, "新消息被吞了");
});

test("Hub 接线：审核钩子报错时 fail-closed，不发送", async () => {
  const config = loadConfig();
  config.send.confirmWaitMs = 0;
  config.send.pacing.enabled = false;
  const store = new Store(":memory:");
  const hub = new Hub(store, config, log, {} as any);
  const sent: string[] = [];
  hub.addAdapter({
    platform: "feishu" as const,
    start: async () => {},
    stop: async () => {},
    sendText: async (_id: string, text: string) => { sent.push(text); return { msgId: "m1" }; },
  } as any);
  hub.review = { shouldReview: () => true, propose: async () => ({ queued: false, error: "没配好" }) };

  hub.ingest({
    platform: "feishu", external_chat_id: "oc_group", pool_kind: "group",
    msg_id: "u0", sender_id: "u1", sender_name: "他", ts: Date.now(), text: "在吗",
    reply_to: null, mentions: [], is_mention_me: false, media_type: "text",
  });
  hub.takeUnread();
  const r = await hub.send("feishu:oc_group", "在");
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /没配好/);
  assert.deepEqual(sent, []);
});

test("配置校验：开了审核但没配审批房 / 主人就启动失败", () => {
  const config = loadConfig();
  config.approval = { ...config.approval, roomId: "", ownerIds: [] };
  config.sendReview = { enabled: true, roomId: "", ownerIds: [] };
  assert.throws(() => validateConfig(config), /sendReview\.(roomId|ownerIds)/);
});

test("按池策略：总开关、默认值、pool_id 覆盖、主对话免审", () => {
  const base = { enabled: true, defaultReview: true, primaryPoolId: null, overrides: {} };
  assert.equal(reviewRequiredFor(base, "feishu:g1"), true, "默认审");
  assert.equal(reviewRequiredFor({ ...base, overrides: { "feishu:g1": false } }, "feishu:g1"), false, "单独放行");
  assert.equal(reviewRequiredFor({ ...base, defaultReview: false }, "feishu:g1"), false, "默认直接发");
  assert.equal(
    reviewRequiredFor({ ...base, defaultReview: false, overrides: { "feishu:g2": true } }, "feishu:g2"),
    true,
    "默认直接发，但这个池要审",
  );
  assert.equal(reviewRequiredFor({ ...base, enabled: false }, "feishu:g1"), false, "总开关关掉一律直接发");
  assert.equal(
    reviewRequiredFor({ ...base, primaryPoolId: "feishu:g1", overrides: { "feishu:g1": true } }, "feishu:g1"),
    false,
    "主对话永远免审，即使单独设了需审批",
  );
  assert.equal(reviewRequiredFor({ ...base, primaryPoolId: "feishu:g1" }, "feishu:g2"), true, "其他池照旧");
});

test("Hub 接线：shouldReview=false 的池直接发，不弹审核", async () => {
  const config = loadConfig();
  config.send.confirmWaitMs = 0;
  config.send.pacing.enabled = false;
  const store = new Store(":memory:");
  const hub = new Hub(store, config, log, {} as any);
  const sent: string[] = [];
  hub.addAdapter({
    platform: "feishu" as const,
    start: async () => {},
    stop: async () => {},
    sendText: async (_id: string, text: string) => { sent.push(text); return { msgId: "m1" }; },
  } as any);
  let proposed = 0;
  hub.review = {
    shouldReview: () => false,
    propose: async () => { proposed++; return { queued: true, id: 1 }; },
  };
  hub.ingest({
    platform: "feishu", external_chat_id: "oc_direct", pool_kind: "group",
    msg_id: "u0", sender_id: "u1", sender_name: "他", ts: Date.now(), text: "在吗",
    reply_to: null, mentions: [], is_mention_me: false, media_type: "text",
  });
  hub.takeUnread();
  const r = await hub.send("feishu:oc_direct", "在");
  assert.equal(r.queuedForReview, undefined);
  assert.equal(r.ok, true);
  assert.deepEqual(sent, ["在"]);
  assert.equal(proposed, 0);
});

test("设置持久化：保存后重启能读回，坏值校验报错", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-send-review-"));
  const config = loadConfig({ dataDir: dir, logDir: path.join(dir, "logs") });
  applySendReviewSettings(config, {
    enabled: true,
    defaultReview: false,
    primaryPoolId: "feishu:g1",
    overrides: { "feishu:g1": true },
  });

  const bad = [
    { enabled: "yes", defaultReview: true, overrides: {} },
    { enabled: true, defaultReview: true, overrides: { "feishu:g1": "yes" } },
  ];
  for (const raw of bad) assert.throws(() => validateSendReviewSettings(raw));

  saveSendReviewSettings(config, effectiveSendReviewSettings(config));
  // 模拟重启：先把内存改回默认，再从文件读
  applySendReviewSettings(config, { enabled: false, defaultReview: true, primaryPoolId: null, overrides: {} });
  const loaded = loadSendReviewSettings(config, log);
  assert.deepEqual(loaded, {
    enabled: true,
    defaultReview: false,
    primaryPoolId: "feishu:g1",
    overrides: { "feishu:g1": true },
  });
  assert.deepEqual(effectiveSendReviewSettings(config), loaded);
});

test("resolveSendReviewConfig：没填的字段复用 approval", () => {
  const config = loadConfig();
  config.approval = { ...config.approval, platform: "matrix", roomId: "!room", ownerIds: ["@o"], timeoutMs: 1234 };
  config.sendReview = { enabled: true };
  const r = resolveSendReviewConfig(config);
  assert.deepEqual(
    { platform: r.platform, roomId: r.roomId, ownerIds: r.ownerIds, timeoutMs: r.timeoutMs },
    { platform: "matrix", roomId: "!room", ownerIds: ["@o"], timeoutMs: 1234 },
  );
});
