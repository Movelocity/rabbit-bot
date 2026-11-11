/** 审批闸门：同意 / 拒绝 / 超时 / 序号 / 非主人 / 串行 / 发不出去 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ApprovalGate, type ApprovalConfig } from "../src/core/approval.ts";
import { Store } from "../src/core/db.ts";
import { getApproval, listApprovals } from "../src/core/approvals.ts";
import { takePendingTick } from "../src/core/tasks.ts";
import type { InboundMessage } from "../src/types.ts";

const ROOM = "!approval:matrix.test";
const OWNER = ":matrix.test";

function cfg(over: Partial<ApprovalConfig> = {}): ApprovalConfig {
  return { enabled: true, platform: "matrix", roomId: ROOM, ownerIds: [OWNER], timeoutMs: 3000, ...over };
}

function msg(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: "matrix",
    external_chat_id: ROOM,
    pool_kind: "private",
    msg_id: `m${Math.random()}`,
    sender_id: OWNER,
    sender_name: "主人",
    ts: Date.now(),
    text: "y",
    reply_to: null,
    mentions: [],
    is_mention_me: false,
    media_type: "text",
    from_self: false,
    ...over,
  };
}

function fakeLog() {
  const lines: string[] = [];
  return { lines, log: { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m), error: (m: string) => lines.push(m) } as any };
}

function react(key: string, over: Partial<InboundMessage> = {}): InboundMessage {
  return msg({ text: key, media_type: "reaction", reaction_key: key, reaction_to: null, ...over });
}

function tmpLogFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-approval-"));
  return path.join(dir, "approval.jsonl");
}

test("关掉的时候不弹，返回 disabled（调用方按拒绝处理）", async () => {
  const { log } = fakeLog();
  const g = new ApprovalGate(cfg({ enabled: false }), log, async () => ({ ok: true }));
  assert.equal(g.enabled, false);
  assert.equal((await g.request({ cmd: "rm -rf build", cwd: "/x", why: "删" })).decision, "disabled");
});

test("同意：发出去、写账、resolve approved", async () => {
  const { log } = fakeLog();
  const file = tmpLogFile();
  const sent: string[] = [];
  const g = new ApprovalGate(cfg(), log, async (_c, t) => { sent.push(t); return { ok: true }; }, file);
  const p = g.request({ cmd: "npm run build", cwd: "/x", why: "执行体不可见" });
  await new Promise((r) => setTimeout(r, 10));           // 让消息发出去
  assert.equal(sent.filter((t) => t.includes("【要动本机】")).length, 1);
  assert.match(sent[0], /【要动本机】#1/);
  assert.match(sent[0], /命令：npm run build/);
  assert.match(sent[0], /同意：给这条消息贴 OK \/ 👍 表情/);
  assert.match(sent[0], /拒绝：贴 No \/ 👎 表情/);
  assert.match(sent[0], /超时 3 秒/);
  assert.equal(g.tryHandle(react("OK")), true);
  const r = await p;
  assert.equal(r.decision, "approved");
  assert.equal(r.by, OWNER);
  assert.equal(r.id, 1);
  // 裁决后要回一句状态，别让人对着按钮猜
  await new Promise((res) => setTimeout(res, 10));
  assert.ok(sent.some((t) => /#1 已批准/.test(t)), `没回状态：${JSON.stringify(sent)}`);
  const rec = JSON.parse(fs.readFileSync(file, "utf8").trim());
  assert.equal(rec.decision, "approved");
  assert.equal(rec.id, 1);
});

test("拒绝：贴 No 就是不跑", async () => {
  const { log } = fakeLog();
  const g = new ApprovalGate(cfg(), log, async () => ({ ok: true }));
  const p = g.request({ cmd: "rm -rf build", cwd: "/x", why: "删" });
  await new Promise((r) => setTimeout(r, 10));
  g.tryHandle(react("No"));
  assert.equal((await p).decision, "rejected");
});

test("超时＝拒绝，不是放行", async () => {
  const { log } = fakeLog();
  const g = new ApprovalGate(cfg({ timeoutMs: 500 }), log, async () => ({ ok: true }));
  const t0 = Date.now();
  const r = await g.request({ cmd: "rm -rf build", cwd: "/x", why: "删" });
  assert.equal(r.decision, "timeout");
  assert.ok(Date.now() - t0 >= 480);
  assert.equal(g.waiting, null);
});

test("文字回复不批，只有贴对表情才算数", async () => {
  const { log } = fakeLog();
  const g = new ApprovalGate(cfg(), log, async () => ({ ok: true }));
  const p = g.request({ cmd: "rm -rf build", cwd: "/x", why: "删" });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(g.tryHandle(msg({ text: "y 1" })), false);
  assert.equal(g.tryHandle(msg({ text: "no" })), false);
  assert.equal(g.waiting?.id, 1);
  g.tryHandle(react("OK"));
  assert.equal((await p).decision, "approved");
});

test("非主人贴表情不算同意，消息照常进池", async () => {
  const { log } = fakeLog();
  const g = new ApprovalGate(cfg({ timeoutMs: 800 }), log, async () => ({ ok: true }));
  const p = g.request({ cmd: "rm -rf build", cwd: "/x", why: "删" });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(g.tryHandle(react("OK", { sender_id: "@stranger:matrix.test" })), false);
  assert.equal(g.waiting?.id, 1);
  assert.equal((await p).decision, "timeout");
});

test("别的房间的消息不归闸门管", async () => {
  const { log } = fakeLog();
  const g = new ApprovalGate(cfg(), log, async () => ({ ok: true }));
  assert.equal(g.tryHandle(msg({ external_chat_id: "!闲聊:matrix.test" })), false);
});

test("审批房里的闲聊照常进池，不挡消息流", async () => {
  const { log } = fakeLog();
  const g = new ApprovalGate(cfg(), log, async () => ({ ok: true }));
  assert.equal(g.tryHandle(msg({ text: "今天天气不错" })), false);
});

test("有待审批时，文字聊天照常进池也不误触", async () => {
  const { log } = fakeLog();
  const g = new ApprovalGate(cfg(), log, async () => ({ ok: true }));
  const p = g.request({ cmd: "rm -rf build", cwd: "/x", why: "删" });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(g.tryHandle(msg({ text: "好 3 点见" })), false);
  assert.equal(g.tryHandle(msg({ text: "ok 这个先别跑" })), false);
  assert.equal(g.waiting?.id, 1);
  g.tryHandle(react("OK"));
  assert.equal((await p).decision, "approved");
});

test("发不出去 = 拒绝（不能悄悄放行）", async () => {
  const { log } = fakeLog();
  const g = new ApprovalGate(cfg(), log, async () => ({ ok: false, error: "no adapter" }));
  const r = await g.request({ cmd: "rm -rf build", cwd: "/x", why: "删" });
  assert.equal(r.decision, "rejected");
});

test("串行：第二条等第一条裁决完才发", async () => {
  const { log } = fakeLog();
  const sent: string[] = [];
  const g = new ApprovalGate(cfg(), log, async (_c, t) => { sent.push(t); return { ok: true }; });
  const p1 = g.request({ cmd: "cmd-one", cwd: "/x", why: "一" });
  const p2 = g.request({ cmd: "cmd-two", cwd: "/x", why: "二" });
  await new Promise((r) => setTimeout(r, 20));
  const asks = () => sent.filter((t) => t.includes("【要动本机】"));
  assert.equal(asks().length, 1);
  g.tryHandle(react("OK"));
  await p1;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(asks().length, 2);
  assert.match(asks()[1], /#2/);
  g.tryHandle(react("OK"));
  assert.equal((await p2).decision, "approved");
});

test("拒绝 / 超时也各回一句状态", async () => {
  const { log } = fakeLog();
  const sent: string[] = [];
  const g = new ApprovalGate(cfg({ timeoutMs: 600 }), log, async (_c, t) => { sent.push(t); return { ok: true }; });

  const p1 = g.request({ cmd: "rm -rf build", cwd: "/x", why: "删" });
  await new Promise((r) => setTimeout(r, 10));
  g.tryHandle(react("No"));
  await p1;

  const p2 = g.request({ cmd: "rm -rf build2", cwd: "/x", why: "删" });
  await p2;

  await new Promise((r) => setTimeout(r, 10));
  assert.ok(sent.some((t) => /#1 已拒绝/.test(t)), JSON.stringify(sent));
  assert.ok(sent.some((t) => /#2 超时.*按拒绝处理/.test(t)), JSON.stringify(sent));
});

test("执行完回一句结果（带上序号）", async () => {
  const { log } = fakeLog();
  const sent: string[] = [];
  const g = new ApprovalGate(cfg(), log, async (_c, t) => { sent.push(t); return { ok: true }; });
  g.reportDone(7, { ok: true, code: 0, ms: 1234 });
  g.reportDone(8, { ok: false, code: 127, ms: 50 });
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(sent.some((t) => /#7 执行完成（1\.2s）/.test(t)), JSON.stringify(sent));
  assert.ok(sent.some((t) => /#8 执行失败：退出码 127/.test(t)), JSON.stringify(sent));
});

test("没开审批时不发这些状态（别往房间里灌噪声）", async () => {
  const { log } = fakeLog();
  const sent: string[] = [];
  const g = new ApprovalGate(cfg({ enabled: false }), log, async (_c, t) => { sent.push(t); return { ok: true }; });
  g.reportDone(1, { ok: true, code: 0, ms: 1 });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sent.length, 0);
});

// ---------------------------------------------------------------- 表情审批
test("表情审批：OK = 批准", async () => {
  const { log } = fakeLog();
  const sent: string[] = [];
  const g = new ApprovalGate(cfg(), log, async (_c, t) => { sent.push(t); return { ok: true, msgId: "$prompt1" }; });
  const p = g.request({ cmd: "ls -la", cwd: "/x", why: "列目录" });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(g.waiting?.id, 1);
  // Element 发出来的实际是 "👍️"（U+1F44D + U+FE0F）
  assert.equal(g.tryHandle(react("OK", { reaction_to: "$prompt1" })), true);
  const r = await p;
  assert.equal(r.decision, "approved");
  assert.equal(r.by, OWNER);
});

test("表情审批：No = 拒绝", async () => {
  const { log } = fakeLog();
  const g = new ApprovalGate(cfg(), log, async () => ({ ok: true, msgId: "$prompt2" }));
  const p = g.request({ cmd: "rm -rf /tmp/x", cwd: "/x", why: "删缓存" });
  await new Promise((r) => setTimeout(r, 10));
  g.tryHandle(react("No", { reaction_to: "$prompt2" }));
  assert.equal((await p).decision, "rejected");
});

test("表情审批：贴在别的消息上不算数，照常进池", async () => {
  const { log } = fakeLog();
  const g = new ApprovalGate(cfg(), log, async () => ({ ok: true, msgId: "$prompt3" }));
  const p = g.request({ cmd: "whoami", cwd: "/x", why: "看看" });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(g.tryHandle(react("OK", { reaction_to: "$someOther" })), false);
  assert.equal(g.waiting?.id, 1, "贴错消息不该裁决");
  // 收尾：贴对的那条才生效
  g.tryHandle(react("OK", { reaction_to: "$prompt3" }));
  assert.equal((await p).decision, "approved");
});

test("表情审批：非主人贴表情不裁决，且不报错", async () => {
  const { log } = fakeLog();
  const g = new ApprovalGate(cfg(), log, async () => ({ ok: true, msgId: "$prompt4" }));
  const p = g.request({ cmd: "id", cwd: "/x", why: "看看" });
  await new Promise((r) => setTimeout(r, 10));
  g.tryHandle(react("OK", { reaction_to: "$prompt4", sender_id: "@stranger:matrix.test" }));
  assert.equal(g.waiting?.id, 1);
  g.tryHandle(react("OK", { reaction_to: "$prompt4" }));
  assert.equal((await p).decision, "approved");
});

test("表情审批：别的表情不算数，照常进池", async () => {
  const { log } = fakeLog();
  const g = new ApprovalGate(cfg(), log, async () => ({ ok: true, msgId: "$prompt5" }));
  const p = g.request({ cmd: "date", cwd: "/x", why: "看看" });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(g.tryHandle(react("THUMBSUP", { reaction_to: "$prompt5" })), false);
  assert.equal(g.waiting?.id, 1);
  g.tryHandle(react("No"));
  assert.equal((await p).decision, "rejected");
});

// ---------------------------------------------------------------- 落库
test("落库：ask 写 approvals，审批房批准后同一行改成 approved", async () => {
  const { log } = fakeLog();
  const store = new Store(":memory:");
  let enqueued = 0;
  const g = new ApprovalGate(
    cfg(), log, async () => ({ ok: true }), undefined,
    { store, enqueue: () => { enqueued++; } },
  );

  const p = g.request({ cmd: "npm publish", cwd: "/work", why: "发布包" });
  await new Promise((r) => setTimeout(r, 10));

  const pending = listApprovals(store, { status: "pending" });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].worker_id, "host");
  assert.equal(pending[0].task_id, 0);
  assert.match(pending[0].action, /npm publish/);
  assert.equal(pending[0].why, "发布包");
  assert.equal(enqueued, 1, "申请落库置了一次 pending tick");

  g.tryHandle(react("OK"));
  const r = await p;
  assert.equal(r.decision, "approved");

  const row = getApproval(store, pending[0].id)!;
  assert.equal(row.status, "approved");
  assert.equal(row.decided_by, OWNER);
  assert.ok(row.decided_at !== null);
  store.close();
});

test("落库：审批房拒绝也写同一张表，并置 pending tick", async () => {
  const { log } = fakeLog();
  const store = new Store(":memory:");
  let enqueued = 0;
  const g = new ApprovalGate(
    cfg(), log, async () => ({ ok: true }), undefined,
    { store, enqueue: () => { enqueued++; } },
  );

  const p = g.request({ cmd: "rm -rf build", cwd: "/work", why: "删目录" });
  await new Promise((r) => setTimeout(r, 10));
  const row = listApprovals(store, { status: "pending" })[0];
  takePendingTick(store);
  enqueued = 0;

  g.tryHandle(react("No"));
  assert.equal((await p).decision, "rejected");
  assert.equal(getApproval(store, row.id)?.status, "rejected");
  assert.equal(getApproval(store, row.id)?.decided_by, OWNER);
  assert.equal(enqueued, 1, "拒绝是终态，置一次 tick");
  store.close();
});
