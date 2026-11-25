/** task-audit：写内部指令、不计未读、meta 标记、与执行器日志摘要联动。 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/core/db.ts";
import { createTask, updateTask } from "../src/core/tasks.ts";
import { listTaskEvents } from "../src/core/task-events.ts";
import { appendTaskAudit, buildAuditLine } from "../src/core/task-audit.ts";
import { logTask } from "../src/core/task-controls.ts";
import { sweepStuckTasks } from "../src/core/dispatch.ts";

function setup() {
  const store = new Store(":memory:");
  const task = createTask(store, {
    userId: "u1",
    poolId: "p1",
    name: "#审计",
    goal: "验证任务审计",
    work_dir: process.cwd(),
    executor: "opencode",
  });
  return { store, task };
}

test("appendTaskAudit：写 internal 指令，不计未读，meta 标 audit_only", () => {
  const { store, task } = setup();
  try {
    const ok = appendTaskAudit(store, {
      taskId: task.id,
      action: "resume",
      text: buildAuditLine("resume", task.id, '"先补测试"'),
      source: "tool",
      args: { instruction: "先补测试", password: "hunter2" },
      ok: true,
    });
    assert.equal(ok, true);
    assert.equal(store.unread(task.task_pool_id).length, 0, "审计不该计入未读");
    const events = listTaskEvents(store, task.id);
    assert.equal(events.length, 1);
    assert.match(events[0].text, new RegExp(`/resume #${task.id}`));
    assert.equal(events[0].meta?.kind, "task_command");
    assert.equal(events[0].meta?.audit_only, true);
    assert.equal(events[0].meta?.source, "tool");
    assert.equal(JSON.stringify(events[0].meta).includes("hunter2"), false, "参数要脱敏");
  } finally {
    store.close();
  }
});

test("appendTaskAudit：空文本不写、任务不存在不抛错", () => {
  const { store, task } = setup();
  try {
    assert.equal(appendTaskAudit(store, { taskId: task.id, action: "log", text: "   ", source: "tool" }), false);
    assert.equal(appendTaskAudit(store, { taskId: 999999, action: "log", text: "/log #999999", source: "tool" }), false);
    assert.equal(listTaskEvents(store, task.id).length, 0);
  } finally {
    store.close();
  }
});

test("logTask：读 runner 尾部并写审计，不计未读", () => {
  const { store, task } = setup();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rb-task-audit-"));
  const dir = path.join(root, "tasks", String(task.id));
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  fs.writeFileSync(path.join(dir, "runner.jsonl"), [
    { type: "text", timestamp: now - 1000, part: { type: "text", text: "正在检查 data_scope" } },
    { type: "tool_use", timestamp: now, part: {
      type: "tool", tool: "bash",
      state: { status: "completed", input: { command: "go test ./service/rs/" }, output: "ok" },
    } },
  ].map((l) => JSON.stringify(l)).join("\n") + "\n");
  try {
    const r = logTask(store, task, { dataDir: root }, { now, lines: 5, source: "tool" });
    assert.match(r.text, /任务 #\d+ 最近活动/);
    assert.match(r.text, /go test/);
    assert.equal(store.unread(task.task_pool_id).length, 0);
    const audit = listTaskEvents(store, task.id).find((e) => e.meta?.kind === "task_command");
    assert.ok(audit);
    assert.match(audit!.text, /\/log #/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    store.close();
  }
});

test("sweepStuckTasks：进程活着但静默超阈值，自动上报一次并写审计", () => {
  const { store, task } = setup();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rb-stuck-"));
  const dir = path.join(root, "tasks", String(task.id));
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const started = now - 10 * 60_000;
  updateTask(store, task.id, {
    status: "running",
    runner_pid: process.pid,
    runner_started_at: started,
  });
  fs.writeFileSync(path.join(dir, "runner.jsonl"), JSON.stringify({
    type: "tool_use", timestamp: started + 1000, part: {
      type: "tool", tool: "bash",
      state: { status: "completed", input: { command: "go test ./..." }, output: "ok" },
    },
  }) + "\n");
  try {
    const first = sweepStuckTasks(store, { now, stuckMs: 5 * 60_000, dataDir: root });
    assert.deepEqual(first.warned, [task.id]);
    const events = listTaskEvents(store, task.id);
    const audit = events.find((e) => e.meta?.kind === "task_command" && /auto-stuck/.test(e.text));
    assert.ok(audit, "要写一条 auto-stuck 审计");
    const alert = events.find((e) => /已静默/.test(e.text) && e.meta?.kind !== "task_command");
    assert.ok(alert, "要写一条普通提醒事件");
    assert.equal(store.unread(task.task_pool_id).length, 1, "只有普通提醒计入未读");

    const second = sweepStuckTasks(store, { now: now + 1000, stuckMs: 5 * 60_000, dataDir: root });
    assert.deepEqual(second.warned, [], "同一轮执行只报一次");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    store.close();
  }
});
