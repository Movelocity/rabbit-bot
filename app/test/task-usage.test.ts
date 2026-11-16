/** 任务执行耗费：从 runner.jsonl 聚合 token / 费用 / 耗时，并在看板查询时回填老任务。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/core/db.ts";
import { createTask, getTask, updateTask } from "../src/core/tasks.ts";
import { parseRunnerUsage, runnerLogPath } from "../src/core/task-usage.ts";
import { taskStats } from "../src/ops/task-stats.ts";

function writeRunner(dataDir: string, taskId: number): void {
  const file = runnerLogPath(dataDir, taskId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = [
    {
      type: "step_finish", timestamp: 1000,
      part: { tokens: { total: 120, input: 20, output: 10, reasoning: 5, cache: { read: 85, write: 0 } }, cost: 0.001 },
    },
    {
      type: "step_finish", timestamp: 4000,
      part: { tokens: { total: 90, input: 5, output: 20, reasoning: 0, cache: { read: 60, write: 5 } }, cost: 0.002 },
    },
    { type: "ufa-dispatch", note: "process exited", code: 0, signal: null, ms: 5000, at: 6000 },
  ];
  fs.writeFileSync(file, lines.map((x) => JSON.stringify(x)).join("\n") + "\n", "utf8");
}

test("runner 日志：token 分段累加，耗时取进程退出 ms", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-task-usage-"));
  writeRunner(dir, 7);
  const u = parseRunnerUsage(runnerLogPath(dir, 7));
  assert.equal(u.steps, 2);
  assert.equal(u.totalTokens, 210);
  assert.equal(u.inputTokens, 25);
  assert.equal(u.outputTokens, 30);
  assert.equal(u.reasoningTokens, 5);
  assert.equal(u.cacheReadTokens, 145);
  assert.equal(u.cacheWriteTokens, 5);
  assert.equal(u.costUsd, 0.003);
  assert.equal(u.durationMs, 5000);
});

test("codex runner 日志：turn.completed usage 累加，缓存 token 只展示不重复计入 total", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-task-usage-codex-"));
  const file = runnerLogPath(dir, 8);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = [
    { type: "thread.started", thread_id: "thread-1" },
    { type: "turn.completed", usage: {
      input_tokens: 100, cached_input_tokens: 80, cache_write_input_tokens: 10,
      output_tokens: 20, reasoning_output_tokens: 5,
    } },
    { type: "turn.completed", usage: {
      input_tokens: 50, cached_input_tokens: 40, cache_write_input_tokens: 0,
      output_tokens: 10, reasoning_output_tokens: 0,
    } },
    { type: "ufa-dispatch", note: "process exited", code: 0, signal: null, ms: 3000, at: 4000 },
  ];
  fs.writeFileSync(file, lines.map((x) => JSON.stringify(x)).join("\n") + "\n", "utf8");
  const u = parseRunnerUsage(file);
  assert.equal(u.steps, 2);
  assert.equal(u.inputTokens, 150);
  assert.equal(u.outputTokens, 30);
  assert.equal(u.reasoningTokens, 5);
  assert.equal(u.cacheReadTokens, 120);
  assert.equal(u.cacheWriteTokens, 10);
  assert.equal(u.totalTokens, 185);
  assert.equal(u.costUsd, 0);
  assert.equal(u.durationMs, 3000);
});

test("claude runner 日志：resume 后 result 是累计值，取最后一条而不是相加", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-task-usage-claude-"));
  const file = runnerLogPath(dir, 9);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = [
    { type: "system", subtype: "init", session_id: "sess-1" },
    { type: "assistant", message: { id: "msg-1", usage: { input_tokens: 100, output_tokens: 20 } } },
    { type: "result", subtype: "success", session_id: "sess-1", num_turns: 1, duration_ms: 2000, total_cost_usd: 0.01, usage: {
      input_tokens: 100, cache_read_input_tokens: 80, cache_creation_input_tokens: 10, output_tokens: 20,
    } },
    { type: "ufa-dispatch", note: "process exited", code: 0, signal: null, ms: 2500, at: 3000 },
    { type: "system", subtype: "init", session_id: "sess-1" },
    { type: "assistant", message: { id: "msg-2", usage: { input_tokens: 150, output_tokens: 35 } } },
    { type: "result", subtype: "success", session_id: "sess-1", num_turns: 2, duration_ms: 3000, total_cost_usd: 0.03, usage: {
      input_tokens: 150, cache_read_input_tokens: 120, cache_creation_input_tokens: 15, output_tokens: 35,
    } },
    { type: "ufa-dispatch", note: "process exited", code: 0, signal: null, ms: 3500, at: 7000 },
  ];
  fs.writeFileSync(file, lines.map((x) => JSON.stringify(x)).join("\n") + "\n", "utf8");
  const u = parseRunnerUsage(file);
  assert.equal(u.inputTokens, 150, "累计口径不能把两轮相加");
  assert.equal(u.outputTokens, 35);
  assert.equal(u.cacheReadTokens, 120);
  assert.equal(u.cacheWriteTokens, 15);
  assert.equal(u.totalTokens, 185);
  assert.equal(u.steps, 2);
  assert.equal(u.costUsd, 0.03);
  assert.equal(u.durationMs, 6000);
});

test("claude 2.1.x runner 日志：result.usage 是每轮、total_cost_usd 是累计，按 since 取增量", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-task-usage-claude-delta-"));
  const file = runnerLogPath(dir, 11);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const since = (cost: number) => ({ "claude-sonnet-4-5": {
    inputTokens: 12, outputTokens: 6, cacheReadInputTokens: 4, cacheCreationInputTokens: 3, costUSD: cost,
  } });
  const lines = [
    { type: "assistant", message: { id: "m1", usage: { input_tokens: 12, output_tokens: 6 } } },
    { type: "result", subtype: "success", num_turns: 1, duration_ms: 79, total_cost_usd: 0.00013845,
      usage: { input_tokens: 12, output_tokens: 6, cache_read_input_tokens: 4, cache_creation_input_tokens: 3 },
      model_usage_since_last_result: since(0.00013845) },
    { type: "ufa-dispatch", note: "process exited", code: 0, signal: null, ms: 500, at: 600 },
    { type: "assistant", message: { id: "m2", usage: { input_tokens: 12, output_tokens: 6 } } },
    { type: "result", subtype: "success", num_turns: 1, duration_ms: 120, total_cost_usd: 0.0002769,
      usage: { input_tokens: 12, output_tokens: 6, cache_read_input_tokens: 4, cache_creation_input_tokens: 3 },
      model_usage_since_last_result: since(0.00013845) },
    { type: "ufa-dispatch", note: "process exited", code: 0, signal: null, ms: 700, at: 1400 },
  ];
  fs.writeFileSync(file, lines.map((x) => JSON.stringify(x)).join("\n") + "\n", "utf8");
  const u = parseRunnerUsage(file);
  assert.equal(u.inputTokens, 24, "两轮各 12，按 since 累加");
  assert.equal(u.outputTokens, 12);
  assert.equal(u.cacheReadTokens, 8);
  assert.equal(u.cacheWriteTokens, 6);
  assert.equal(u.totalTokens, 36);
  assert.equal(u.steps, 2);
  assert.equal(u.costUsd, 0.0002769, "费用按 since.costUSD 累加，不能把累计的 total_cost_usd 相加");
  assert.equal(u.durationMs, 1200);
});

test("claude runner 日志：没有 result 时退回 assistant 事件，同一 message id 不重复计", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-task-usage-claude-fallback-"));
  const file = runnerLogPath(dir, 10);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const usage = { input_tokens: 12, cache_read_input_tokens: 3, cache_creation_input_tokens: 1, output_tokens: 4 };
  fs.writeFileSync(file, [
    { type: "assistant", message: { id: "msg-1", usage } },
    { type: "assistant", message: { id: "msg-1", usage } },
    { type: "assistant", message: { id: "msg-2", usage } },
  ].map((x) => JSON.stringify(x)).join("\n") + "\n", "utf8");
  const u = parseRunnerUsage(file);
  assert.equal(u.steps, 2);
  assert.equal(u.inputTokens, 24);
  assert.equal(u.outputTokens, 8);
  assert.equal(u.cacheReadTokens, 6);
  assert.equal(u.totalTokens, 32);
});

test("任务统计：老任务查询时回填 exec_*，并按执行器汇总", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-task-stats-"));
  const store = new Store(":memory:");
  const now = Date.now();
  const task = createTask(store, {
    userId: "u1", poolId: "p1", name: "#统计", goal: "跑完",
    work_dir: dataDir, executor: "mimo", status: "done",
  });
  updateTask(store, task.id, { status: "done", end_at: now });
  writeRunner(dataDir, task.id);

  const stats = taskStats(store, dataDir, { to: now + 1 });
  assert.equal(stats.summary.tasks, 1);
  assert.equal(stats.summary.totalTokens, 210);
  assert.equal(stats.summary.costUsd, 0.003);
  assert.equal(stats.summary.durationMs, 5000);
  assert.equal(stats.by_executor[0].executor, "mimo");
  assert.equal(stats.tasks[0].name, "#统计");

  const fresh = getTask(store, task.id)!;
  assert.equal(fresh.exec_total_tokens, 210);
  assert.ok(fresh.exec_usage_at);
  store.close();
});
