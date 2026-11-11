/** 任务统计看板：聚合已完成任务的执行耗时、token 与费用。 */
import type { Store } from "../core/db.ts";
import { taskDisplayName, updateTask, type Task } from "../core/tasks.ts";
import { parseRunnerUsage, runnerLogPath, taskUsagePatch } from "../core/task-usage.ts";
import { fmtLocal } from "../core/time.ts";

export interface TaskStatsSummary {
  tasks: number;
  durationMs: number;
  avgDurationMs: number;
  steps: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export interface TaskStatsExecutor extends TaskStatsSummary {
  executor: string;
}

export interface TaskStatsRow {
  id: number;
  name: string;
  executor: string;
  model: string;
  end_at: number;
  end_at_local: string;
  duration_ms: number;
  steps: number;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
}

export interface TaskStats {
  from: number;
  to: number;
  summary: TaskStatsSummary;
  by_executor: TaskStatsExecutor[];
  tasks: TaskStatsRow[];
}

/** 老任务没有 exec_usage_at 时，从 runner.jsonl 回填一次。 */
export function ensureTaskUsage(store: Store, dataDir: string, task: Task, force = false): Task {
  if (!force && task.exec_usage_at) return task;
  return updateTask(store, task.id, taskUsagePatch(parseRunnerUsage(runnerLogPath(dataDir, task.id))));
}

function zeroSummary(): TaskStatsSummary {
  return {
    tasks: 0,
    durationMs: 0,
    avgDurationMs: 0,
    steps: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
  };
}

function addUsage(sum: TaskStatsSummary, t: Task): void {
  sum.tasks += 1;
  sum.durationMs += t.exec_duration_ms;
  sum.steps += t.exec_steps;
  sum.totalTokens += t.exec_total_tokens;
  sum.inputTokens += t.exec_input_tokens;
  sum.outputTokens += t.exec_output_tokens;
  sum.reasoningTokens += t.exec_reasoning_tokens;
  sum.cacheReadTokens += t.exec_cache_read_tokens;
  sum.cacheWriteTokens += t.exec_cache_write_tokens;
  sum.costUsd += t.exec_cost_usd;
}

export function taskStats(
  store: Store,
  dataDir: string,
  opts: { from?: number; to?: number; limit?: number } = {},
): TaskStats {
  const to = opts.to ?? Date.now();
  const from = opts.from ?? 0;
  const limit = Math.min(1000, Math.max(1, Math.round(opts.limit ?? 500)));
  const rows = store.db.prepare(`SELECT * FROM tasks
    WHERE status='done' AND end_at IS NOT NULL AND end_at>=? AND end_at<=?
    ORDER BY end_at DESC LIMIT ?`).all(from, to, limit) as Task[];

  const tasks = rows.map((t) => ensureTaskUsage(store, dataDir, t));
  const summary = zeroSummary();
  const byExecutor = new Map<string, TaskStatsExecutor>();

  for (const t of tasks) {
    addUsage(summary, t);
    const key = t.executor || "opencode";
    let e = byExecutor.get(key);
    if (!e) {
      e = { executor: key, ...zeroSummary() };
      byExecutor.set(key, e);
    }
    addUsage(e, t);
  }
  summary.avgDurationMs = summary.tasks > 0 ? Math.round(summary.durationMs / summary.tasks) : 0;

  return {
    from,
    to,
    summary,
    by_executor: [...byExecutor.values()].sort((a, b) => b.costUsd - a.costUsd),
    tasks: tasks.map((t) => ({
      id: t.id,
      name: taskDisplayName(t),
      executor: t.executor || "opencode",
      model: t.model,
      end_at: t.end_at ?? 0,
      end_at_local: fmtLocal(t.end_at ?? 0),
      duration_ms: t.exec_duration_ms,
      steps: t.exec_steps,
      total_tokens: t.exec_total_tokens,
      input_tokens: t.exec_input_tokens,
      output_tokens: t.exec_output_tokens,
      cache_read_tokens: t.exec_cache_read_tokens,
      cache_write_tokens: t.exec_cache_write_tokens,
      cost_usd: t.exec_cost_usd,
    })),
  };
}
