/** 任务发布审批走通：建任务 → 发原聊天 → 主人贴 OK → 写文档并启动执行器。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { App } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { MockAdapter } from "../src/adapters/mock.ts";
import { createTask, getTask } from "../src/core/tasks.ts";
import { taskDocPath } from "../src/core/dispatch.ts";

const ROOM = "oc_task_approval";
const ORIGIN = "dm-owner";
const MAIN = "dm-main";
const GROUP = "oc_project_group";
const OWNER = "ou_owner";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("任务审批：贴 OK 后真正启动执行器；审批消息不进池", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-bot-task-approval-"));
  const workDir = path.join(dir, "work");
  fs.mkdirSync(workDir, { recursive: true });
  const fakeBin = path.join(dir, "fake-exec.mjs");
  fs.writeFileSync(fakeBin, `#!/usr/bin/env node
console.log(JSON.stringify({ type: "step_start", sessionID: "ses_task_approval" }));
setTimeout(() => process.exit(0), 20);
`, "utf8");
  fs.chmodSync(fakeBin, 0o755);

  const cfg = loadConfig({
    dataDir: dir,
    logDir: path.join(dir, "logs"),
    runtimeDir: path.join(dir, "runtime"),
    exec: { dir: path.join(dir, "sandbox") },
    taskApproval: {
      enabled: true, target: "origin", platform: "mock", roomId: ROOM, ownerIds: [OWNER], timeoutMs: 60_000, notify: true,
    },
    sendReview: { primaryPoolId: `mock:${MAIN}` },
  });
  const log: any = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, wake: () => {} };
  const app = new App({
    cfg, model: { id: "fake/model" } as any, modelRuntime: {} as any,
    logger: log, dbFile: ":memory:", inMemorySessions: true, executorBin: fakeBin,
  });
  const mock = new MockAdapter();
  app.hub.addAdapter(mock);
  await app.start();

  try {
    app.store.upsertPool("mock", MAIN, "private", "主人");
    const origin = app.store.upsertPool("mock", GROUP, "group", "项目群");
    const task = createTask(app.store, {
      userId: "u1", poolId: origin.pool_id, name: "#修复登录", goal: "把登录页修好",
      work_dir: workDir, status: "pending_approval",
    });
    app.notifyTaskApproval(task);
    await wait(20);

    const prompt = mock.sent.find((s) => s.chat === MAIN && /【任务待审批】/.test(s.content));
    assert.ok(prompt, "群聊里建的任务，审批消息也应当发到主聊天");
    assert.equal(mock.sent.some((s) => s.chat === GROUP && /【任务待审批】/.test(s.content)), false);

    (mock as any).sink({
      platform: "mock",
      external_chat_id: MAIN,
      pool_kind: "private",
      msg_id: `reaction-${Date.now()}`,
      sender_id: OWNER,
      sender_name: "主人",
      ts: Date.now(),
      text: "OK",
      reply_to: prompt!.msgId,
      reaction_to: prompt!.msgId,
      mentions: [],
      is_mention_me: false,
      media_type: "reaction",
      reaction_key: "OK",
      from_self: false,
    });

    for (let i = 0; i < 100; i++) {
      const t = getTask(app.store, task.id);
      if (t?.status === "running" && t.session_id) break;
      await wait(20);
    }
    const fresh = getTask(app.store, task.id)!;
    assert.equal(fresh.status, "running");
    assert.equal(fresh.session_id, "ses_task_approval");
    assert.ok(fs.existsSync(taskDocPath(fresh)), "审批通过后要补写任务文档");
    assert.match(fresh.note, /飞书审批通过/);
    assert.ok(mock.sent.some((s) => /已批准，开始执行/.test(s.content)));
  } finally {
    await app.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("审批房只是消息来源：私聊/群审批房里的普通文字都必须入池", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-bot-approval-chat-"));
  const cfg = loadConfig({
    dataDir: dir,
    logDir: path.join(dir, "logs"),
    runtimeDir: path.join(dir, "runtime"),
    exec: { dir: path.join(dir, "sandbox") },
    scheduler: { privateWakeMs: 60_000, debounceMs: 60_000, debounceMaxWaitMs: 60_000 },
    approval: {
      enabled: true, platform: "mock", roomId: ORIGIN, ownerIds: [OWNER], timeoutMs: 60_000, notify: false,
    },
    taskApproval: {
      enabled: true, target: "room", platform: "mock", roomId: ROOM, ownerIds: [OWNER], timeoutMs: 60_000, notify: false,
    },
  });
  const log: any = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, wake: () => {} };
  const app = new App({
    cfg, model: { id: "fake/model" } as any, modelRuntime: {} as any,
    logger: log, dbFile: ":memory:", inMemorySessions: true,
  });
  const mock = new MockAdapter();
  app.hub.addAdapter(mock);
  await app.start();

  try {
    const origin = app.store.upsertPool("mock", ORIGIN, "private", "主人");
    const room = app.store.upsertPool("mock", ROOM, "group", "审批群");

    mock.inject({ chat: ORIGIN, kind: "private", from: OWNER, name: "主人", text: "今天吃什么" });
    mock.inject({ chat: ROOM, kind: "group", from: OWNER, name: "主人", text: "顺手聊两句" });

    const originUnread = app.store.unread(origin.pool_id);
    assert.equal(originUnread.length, 1, "私聊审批房里的正常文字必须入池");
    assert.equal(originUnread[0].text, "今天吃什么");

    const roomUnread = app.store.unread(room.pool_id);
    assert.equal(roomUnread.length, 1, "群审批房里的正常文字也必须入池");
    assert.equal(roomUnread[0].text, "顺手聊两句");
  } finally {
    await app.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("任务审批：贴 No 后取消任务，不启动执行器", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-bot-task-reject-"));
  const workDir = path.join(dir, "work");
  fs.mkdirSync(workDir, { recursive: true });
  const marker = path.join(dir, "started.txt");
  const fakeBin = path.join(dir, "fake-exec.mjs");
  fs.writeFileSync(fakeBin, `#!/usr/bin/env node
import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(marker)}, "started");
`, "utf8");
  fs.chmodSync(fakeBin, 0o755);

  const cfg = loadConfig({
    dataDir: dir,
    logDir: path.join(dir, "logs"),
    runtimeDir: path.join(dir, "runtime"),
    exec: { dir: path.join(dir, "sandbox") },
    taskApproval: {
      enabled: true, target: "origin", platform: "mock", roomId: ROOM, ownerIds: [OWNER], timeoutMs: 60_000, notify: true,
    },
    sendReview: { primaryPoolId: `mock:${ORIGIN}` },
  });
  const log: any = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, wake: () => {} };
  const app = new App({
    cfg, model: { id: "fake/model" } as any, modelRuntime: {} as any,
    logger: log, dbFile: ":memory:", inMemorySessions: true, executorBin: fakeBin,
  });
  const mock = new MockAdapter();
  app.hub.addAdapter(mock);
  await app.start();

  try {
    const origin = app.store.upsertPool("mock", ORIGIN, "private", "主人");
    const task = createTask(app.store, {
      userId: "u1", poolId: origin.pool_id, name: "#别跑", goal: "不应该启动",
      work_dir: workDir, status: "pending_approval",
    });
    app.notifyTaskApproval(task);
    await wait(20);
    const prompt = mock.sent.find((s) => s.chat === ORIGIN && /【任务待审批】/.test(s.content));
    assert.ok(prompt);

    (mock as any).sink({
      platform: "mock",
      external_chat_id: ORIGIN,
      pool_kind: "group",
      msg_id: `reaction-${Date.now()}`,
      sender_id: OWNER,
      sender_name: "主人",
      ts: Date.now(),
      text: "No",
      reply_to: prompt!.msgId,
      reaction_to: prompt!.msgId,
      mentions: [],
      is_mention_me: false,
      media_type: "reaction",
      reaction_key: "No",
      from_self: false,
    });
    await wait(50);

    const fresh = getTask(app.store, task.id)!;
    assert.equal(fresh.status, "cancelled");
    assert.equal(fs.existsSync(marker), false, "被拒绝的任务不能启动执行器");
    assert.match(fresh.note, /飞书审批拒绝/);
  } finally {
    await app.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
