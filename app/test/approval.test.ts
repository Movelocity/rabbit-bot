/** 审批闸门：同意 / 拒绝 / 超时 / 序号 / 非主人 / 串行 / 发不出去 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ApprovalGate, type ApprovalConfig } from "../src/core/approval.ts";
import type { InboundMessage } from "../src/types.ts";

const ROOM = "!approval:matrix.test";
const OWNER = "@weikang:matrix.test";

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
  assert.match(sent[0], /npm run build/);
  assert.match(sent[0], /y 1/);
  assert.equal(g.tryHandle(msg({ text: "y 1" })), true);
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

test("拒绝：n 就是不跑", async () => {
  const { log } = fakeLog();
  const g = new ApprovalGate(cfg(), log, async () => ({ ok: true }));
  const p = g.request({ cmd: "rm -rf build", cwd: "/x", why: "删" });
  await new Promise((r) => setTimeout(r, 10));
  g.tryHandle(msg({ text: "n" }));
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

test("序号对不上就不批：y 99 不动 #1", async () => {
  const { log } = fakeLog();
  const g = new ApprovalGate(cfg(), log, async () => ({ ok: true }));
  const p = g.request({ cmd: "rm -rf build", cwd: "/x", why: "删" });
  await new Promise((r) => setTimeout(r, 10));
  g.tryHandle(msg({ text: "y 99" }));
  assert.equal(g.waiting?.id, 1);
  g.tryHandle(msg({ text: "y 1" }));
  assert.equal((await p).decision, "approved");
});

test("非主人回 y 不算同意（但也不进她的上下文）", async () => {
  const { log } = fakeLog();
  const g = new ApprovalGate(cfg({ timeoutMs: 800 }), log, async () => ({ ok: true }));
  const p = g.request({ cmd: "rm -rf build", cwd: "/x", why: "删" });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(g.tryHandle(msg({ text: "y", sender_id: "@stranger:matrix.test" })), true);
  assert.equal(g.waiting?.id, 1);
  assert.equal((await p).decision, "timeout");
});

test("别的房间的消息不归闸门管", async () => {
  const { log } = fakeLog();
  const g = new ApprovalGate(cfg(), log, async () => ({ ok: true }));
  assert.equal(g.tryHandle(msg({ external_chat_id: "!闲聊:matrix.test" })), false);
});

test("审批房里的闲聊也吞掉，不给她看", async () => {
  const { log } = fakeLog();
  const g = new ApprovalGate(cfg(), log, async () => ({ ok: true }));
  assert.equal(g.tryHandle(msg({ text: "今天天气不错" })), true);
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
  g.tryHandle(msg({ text: "y 1" }));
  await p1;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(asks().length, 2);
  assert.match(asks()[1], /#2/);
  g.tryHandle(msg({ text: "y 2" }));
  assert.equal((await p2).decision, "approved");
});

test("拒绝 / 超时也各回一句状态", async () => {
  const { log } = fakeLog();
  const sent: string[] = [];
  const g = new ApprovalGate(cfg({ timeoutMs: 600 }), log, async (_c, t) => { sent.push(t); return { ok: true }; });

  const p1 = g.request({ cmd: "rm -rf build", cwd: "/x", why: "删" });
  await new Promise((r) => setTimeout(r, 10));
  g.tryHandle(msg({ text: "n 1" }));
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
