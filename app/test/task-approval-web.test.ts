/** 任务审批在网页直聊可用：提示同步进 web 池、带 task_id、主聊天是 web 时不重复发。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { App } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { MockAdapter } from "../src/adapters/mock.ts";
import { WebAdapter } from "../src/adapters/web.ts";
import { createTask } from "../src/core/tasks.ts";
import { readPool } from "../src/ops/pools.ts";

const MAIN = "dm-main";
const OWNER = "ou_owner";
const WEB_POOL = "web:web-chat";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeApp(dir: string, primaryPoolId: string, taskApprovalRoom: string) {
  const cfg = loadConfig({
    dataDir: dir,
    logDir: path.join(dir, "logs"),
    runtimeDir: path.join(dir, "runtime"),
    exec: { dir: path.join(dir, "sandbox") },
    taskApproval: {
      enabled: true, target: "room", platform: "mock", roomId: taskApprovalRoom,
      ownerIds: [OWNER], timeoutMs: 60_000, notify: true,
    },
    sendReview: { primaryPoolId },
    webChat: { enabled: true, username: "rabbit-bot", pool: "web-chat", title: "网页直聊" },
  });
  const log: any = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, wake: () => {} };
  const app = new App({
    cfg, model: { id: "fake/model" } as any, modelRuntime: {} as any,
    logger: log, dbFile: ":memory:", inMemorySessions: true,
  });
  const mock = new MockAdapter();
  app.hub.addAdapter(mock);
  app.hub.addAdapter(new WebAdapter());
  return { app, mock };
}

test("主聊天在 IM：审批提示同步进网页直聊池，并带 task_id 供前端渲染按钮", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-approval-web-"));
  const { app, mock } = makeApp(dir, `mock:${MAIN}`, "oc_approval_room");
  await app.start();

  try {
    app.store.upsertPool("mock", MAIN, "private", "主人");
    const task = createTask(app.store, {
      userId: "u1", poolId: `mock:${MAIN}`, name: "#网页也能批", goal: "验证网页直聊审批",
      work_dir: dir, status: "pending_approval",
    });
    app.notifyTaskApproval(task);
    await wait(50);

    const webRows = app.store.recentMessages(WEB_POOL, 20);
    const row = webRows.find((m) => /【任务待审批】/.test(m.text));
    assert.ok(row, "IM 主聊天之外，网页直聊池也应收到审批提示");
    assert.deepEqual(row!.meta, { kind: "task_approval", task_id: task.id });
    assert.equal(row!.from_self, true);
    assert.match(row!.text, /超时 .*不回＝拒绝/);
    assert.doesNotMatch(row!.text, /贴 OK|贴 No|表情/, "网页版提示不要求贴表情");

    const view = readPool(app.store, "web:web-chat");
    const viewRow = view.messages.find((m: any) => /【任务待审批】/.test(m.text)) as any;
    assert.ok(viewRow, "会话消息接口要能读到这条提示");
    assert.deepEqual(viewRow.meta, { kind: "task_approval", task_id: task.id });

    assert.ok(mock.sent.some((s) => s.chat === MAIN && /【任务待审批】/.test(s.content)), "IM 主聊天照常收到");
  } finally {
    await app.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("主聊天设为网页直聊：审批提示只发 web 池，不重复写 IM", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-approval-web-main-"));
  const { app, mock } = makeApp(dir, WEB_POOL, "oc_approval_room");
  await app.start();

  try {
    const task = createTask(app.store, {
      userId: "u1", poolId: `mock:${MAIN}`, name: "#网页主聊天", goal: "验证 web 主聊天",
      work_dir: dir, status: "pending_approval",
    });
    app.notifyTaskApproval(task);
    await wait(50);

    const prompts = app.store.recentMessages(WEB_POOL, 20).filter((m) => /【任务待审批】/.test(m.text));
    assert.equal(prompts.length, 1, "web 主聊天只应有一条审批提示");
    assert.deepEqual(prompts[0].meta, { kind: "task_approval", task_id: task.id });
    assert.equal(mock.sent.some((s) => /【任务待审批】/.test(s.content)), false, "主聊天是 web 时不要再往 IM 发");
  } finally {
    await app.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
