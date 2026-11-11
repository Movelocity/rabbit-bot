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
