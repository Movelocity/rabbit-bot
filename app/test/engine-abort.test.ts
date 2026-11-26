/** 引擎收尾：硬超时、中止不写交接、交接只看新文本、写文件失败也要释放会话、溢出换会话。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import "../src/env-defaults.ts";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/core/db.ts";
import { Logger } from "../src/core/logger.ts";
import { PiEngine } from "../src/agent/engine.ts";

function setup(over: any = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-engine-"));
  const cfg = loadConfig({
    dataDir, logDir: path.join(dataDir, "logs"), runtimeDir: path.join(dataDir, "runtime"),
    exec: { dir: path.join(dataDir, "sandbox") },
    llm: { provider: "faux", model: "faux-brain" },
    ...over,
  });
  cfg.limits.turnTimeoutMs = over.turnTimeoutMs ?? 10_000;
  cfg.limits.turnTimeoutGraceMs = over.turnTimeoutGraceMs ?? 0;
  cfg.handoff.contextTokenLimit = over.contextTokenLimit ?? 100_000;
  cfg.handoff.timeoutMs = over.handoffTimeoutMs ?? 5_000;
  const store = new Store(":memory:");
  const engine = new PiEngine({
    cfg, store, log: new Logger(null, true), tools: [], systemPrompt: "test",
    model: {} as any, modelRuntime: {} as any, inMemorySessions: true,
  });
  const done = () => fs.rmSync(dataDir, { recursive: true, force: true });
  return { cfg, store, engine, dataDir, done };
}

interface FakeOpts {
  tokens?: number;
  messages?: any[];
  prompt: (call: number) => Promise<void>;
}

function fakeSession(opts: FakeOpts) {
  const messages: any[] = opts.messages ?? [];
  let aborted = false;
  let call = 0;
  const s: any = {
    messages,
    disposed: false,
    subscribe() { return () => undefined; },
    async prompt() { call++; await opts.prompt(call); },
    async abort() { aborted = true; },
    getContextUsage() { return { tokens: opts.tokens ?? 100 }; },
    setActiveToolsByName() { /* no tools in unit test */ },
    dispose() { s.disposed = true; },
  };
  Object.defineProperty(s, "aborted", { get: () => aborted });
  return s;
}

const limits = { tokensLeft: Number.POSITIVE_INFINITY, callsLeft: Number.POSITIVE_INFINITY };

test("工具卡死：timeout+grace 内强制返回，不等 prompt 自己结束", async () => {
  const t = setup({ turnTimeoutMs: 40, turnTimeoutGraceMs: 30 });
  const sess = fakeSession({ prompt: () => new Promise<void>(() => undefined) });
  (t.engine as any).session = sess;
  const t0 = Date.now();
  const res = await t.engine.run("hi", limits);
  const elapsed = Date.now() - t0;
  assert.equal(res.aborted, true);
  assert.equal(res.abortReason, "turn-timeout");
  assert.ok(elapsed < 1000, `应在硬超时后返回，实际 ${elapsed}ms`);
  assert.equal(sess.disposed, true, "中止后旧会话要释放");
  assert.equal((t.engine as any).session, null, "下一轮必须新建会话");
  t.done();
});

test("中止不写交接：即使上下文已超限，也不能把半句话当交接", async () => {
  const t = setup({ contextTokenLimit: 1000 });
  const sess = fakeSession({
    tokens: 50_000,
    prompt: async () => { sessPush(sess, { role: "assistant", content: [], stopReason: "aborted" }); },
  });
  (t.engine as any).session = sess;
  const res = await t.engine.run("hi", limits);
  assert.equal(res.aborted, true);
  assert.equal(t.store.listHandoffs().length, 0, "中止轮不该生成交接");
  assert.equal(sess.disposed, true);
  t.done();
});

test("交接只取本轮新文本：上一轮回复不能被当成交接文档", async () => {
  const t = setup({ contextTokenLimit: 1000 });
  const sess = fakeSession({
    tokens: 50_000,
    messages: [{ role: "assistant", content: [{ type: "text", text: "上一轮的回复" }], stopReason: "stop" }],
    prompt: async (call) => {
      if (call === 1) sessPush(sess, { role: "assistant", content: [{ type: "text", text: "正常回复" }], stopReason: "stop" });
      else sessPush(sess, { role: "assistant", content: [], stopReason: "aborted" });
    },
  });
  (t.engine as any).session = sess;
  const res = await t.engine.run("hi", limits);
  assert.equal(res.aborted, false);
  assert.equal(t.store.listHandoffs().length, 0, "交接 prompt 没产出新文本就不写交接");
  t.done();
});

test("交接写文件抛错：会话仍然释放，下一轮能新建", async () => {
  const t = setup({ contextTokenLimit: 1000 });
  const sess = fakeSession({
    tokens: 50_000,
    prompt: async (call) => {
      sessPush(sess, { role: "assistant", content: [{ type: "text", text: call === 1 ? "正常回复" : "交接内容" }], stopReason: "stop" });
    },
  });
  (t.engine as any).session = sess;
  const orig = fs.writeFileSync;
  (fs as any).writeFileSync = (p: any, ...rest: any[]) => {
    if (String(p).includes(`${path.sep}handoffs${path.sep}`)) throw new Error("磁盘满");
    return (orig as any)(p, ...rest);
  };
  try {
    await assert.rejects(t.engine.run("hi", limits), /磁盘满/);
  } finally {
    (fs as any).writeFileSync = orig;
  }
  assert.equal(sess.disposed, true, "写交接失败也必须 dispose");
  assert.equal((t.engine as any).session, null);
  t.done();
});

test("上下文溢出报错：直接丢弃会话，不写交接", async () => {
  const t = setup({ contextTokenLimit: 1000 });
  const sess = fakeSession({
    tokens: 200_000,
    prompt: async () => { throw new Error("maximum context length is 128000 tokens"); },
  });
  (t.engine as any).session = sess;
  const res = await t.engine.run("hi", limits);
  assert.match(String(res.error), /maximum context length/);
  assert.equal(t.store.listHandoffs().length, 0);
  assert.equal(sess.disposed, true);
  assert.equal((t.engine as any).session, null);
  t.done();
});

test("中止后交接还原为未消费，下一轮还能带上", async () => {
  const t = setup({ contextTokenLimit: 1000 });
  const id = t.store.addHandoff("旧交接", null, null);
  (t.engine as any).pendingHandoff = "旧交接";
  (t.engine as any).pendingHandoffId = id;
  assert.equal(t.engine.takePendingHandoff(), "旧交接");
  const sess = fakeSession({
    tokens: 50_000,
    prompt: async () => { sessPush(sess, { role: "assistant", content: [], stopReason: "aborted" }); },
  });
  (t.engine as any).session = sess;
  await t.engine.run("hi", limits);
  assert.equal(t.store.latestUnconsumedHandoff()?.id, id, "中止轮不能把交接标成已消费");
  t.done();
});

function sessPush(sess: any, message: any) { sess.messages.push(message); }