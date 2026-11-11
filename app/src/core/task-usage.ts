/** 从执行器 runner.jsonl 聚合任务的 token / 费用 / 实际运行耗时。 */
import fs from "node:fs";
import path from "node:path";

export interface TaskRunUsage {
  steps: number;
  durationMs: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  /** runner 里已记录的进程退出耗时之和（不含当前正在跑的这段） */
  exitedMs: number;
}

export const EMPTY_TASK_USAGE: TaskRunUsage = {
  steps: 0,
  durationMs: 0,
  totalTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
  exitedMs: 0,
};

export function runnerLogPath(dataDir: string, taskId: number): string {
  return path.join(dataDir, "tasks", String(taskId), "runner.jsonl");
}

/** step_finish 的 tokens 是「这一次模型调用」的用量，多次调用直接累加；cost 同理。 */
export function parseRunnerUsage(file: string): TaskRunUsage {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { ...EMPTY_TASK_USAGE };
  }

  const usage: TaskRunUsage = { ...EMPTY_TASK_USAGE };
  let firstStep = 0;
  let lastStep = 0;
  let exitedMs = 0;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }

    if (e.type === "ufa-dispatch" && e.note === "process exited" && Number.isFinite(e.ms)) {
      exitedMs += Number(e.ms);
      continue;
    }
    if (e.type !== "step_finish") continue;

    const ts = Number(e.timestamp);
    if (Number.isFinite(ts)) {
      if (!firstStep) firstStep = ts;
      lastStep = ts;
    }

    const t = e.part?.tokens;
    if (!t) continue;
    usage.steps += 1;
    usage.inputTokens += Number(t.input) || 0;
    usage.outputTokens += Number(t.output) || 0;
    usage.reasoningTokens += Number(t.reasoning) || 0;
    usage.cacheReadTokens += Number(t.cache?.read) || 0;
    usage.cacheWriteTokens += Number(t.cache?.write) || 0;
    const total = Number(t.total);
    usage.totalTokens += Number.isFinite(total)
      ? total
      : (Number(t.input) || 0) + (Number(t.output) || 0)
        + (Number(t.reasoning) || 0) + (Number(t.cache?.read) || 0) + (Number(t.cache?.write) || 0);
    usage.costUsd += Number(e.part?.cost) || 0;
  }

  usage.exitedMs = exitedMs;
  usage.durationMs = exitedMs || (lastStep > firstStep ? lastStep - firstStep : 0);
  return usage;
}

/** 统一成 tasks 表的 exec_* 字段，退出事件和按需回填共用。 */
export function taskUsagePatch(usage: TaskRunUsage, at = Date.now()) {
  return {
    exec_usage_at: at,
    exec_steps: usage.steps,
    exec_duration_ms: usage.durationMs,
    exec_total_tokens: usage.totalTokens,
    exec_input_tokens: usage.inputTokens,
    exec_output_tokens: usage.outputTokens,
    exec_reasoning_tokens: usage.reasoningTokens,
    exec_cache_read_tokens: usage.cacheReadTokens,
    exec_cache_write_tokens: usage.cacheWriteTokens,
    exec_cost_usd: usage.costUsd,
  };
}
