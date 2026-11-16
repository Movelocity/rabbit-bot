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
  // claude 的 usage 挂在 result 事件上。不同 CLI 版本口径不一样：
  // 2.1.x 的 result.usage 是「本轮」用量、total_cost_usd 却是「整个会话」的累计；
  // 更早的版本里 result.usage 也可能是累计值。有 model_usage_since_last_result 时
  // 一律按它取每轮增量；没有时才用单调性判断是不是累计（累计取最后一条，否则各轮相加）。
  const claudeResults: Array<{
    input: number; output: number; cacheRead: number; cacheWrite: number;
    cost: number; durationMs: number; turns: number; delta: boolean;
  }> = [];
  const claudeAssistants = new Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>();
  let claudeAssistantSeq = 0;

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
    // claude stream-json：assistant 是每轮模型调用；result 是本轮结束的汇总。
    if (e.type === "assistant") {
      const u = e.message?.usage ?? e.usage;
      if (u) {
        const id = String(e.message?.id ?? e.uuid ?? `assistant-${++claudeAssistantSeq}`);
        claudeAssistants.set(id, {
          input: Number(u.input_tokens) || 0,
          output: Number(u.output_tokens) || 0,
          cacheRead: Number(u.cache_read_input_tokens) || 0,
          cacheWrite: Number(u.cache_creation_input_tokens) || 0,
        });
      }
      continue;
    }
    if (e.type === "result" && (e.usage || Number.isFinite(Number(e.total_cost_usd)))) {
      const since = e.model_usage_since_last_result;
      const models = since && typeof since === "object" ? Object.values(since as Record<string, any>) : [];
      if (models.length) {
        claudeResults.push(models.reduce((acc: any, m: any) => ({
          input: acc.input + (Number(m?.inputTokens) || 0),
          output: acc.output + (Number(m?.outputTokens) || 0),
          cacheRead: acc.cacheRead + (Number(m?.cacheReadInputTokens) || 0),
          cacheWrite: acc.cacheWrite + (Number(m?.cacheCreationInputTokens) || 0),
          cost: acc.cost + (Number(m?.costUSD) || 0),
          durationMs: acc.durationMs,
          turns: (Number(e.num_turns) || 0) + acc.turns,
          delta: true,
        }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, durationMs: Number(e.duration_ms) || 0, turns: 0 }));
      } else {
        const u = e.usage ?? {};
        claudeResults.push({
          input: Number(u.input_tokens) || 0,
          output: Number(u.output_tokens) || 0,
          cacheRead: Number(u.cache_read_input_tokens) || 0,
          cacheWrite: Number(u.cache_creation_input_tokens) || 0,
          cost: Number(e.total_cost_usd) || 0,
          durationMs: Number(e.duration_ms) || 0,
          turns: Number(e.num_turns) || 0,
          delta: false,
        });
      }
      continue;
    }
    // codex exec --json：每次模型回合结束给一条 turn.completed，usage 是这一回合的用量。
    // cached_input_tokens / cache_write_input_tokens 已包含在 input_tokens 口径里，只做展示，不重复加进 total。
    if (e.type === "turn.completed" && e.usage) {
      const t = e.usage;
      const input = Number(t.input_tokens) || 0;
      const output = Number(t.output_tokens) || 0;
      const reasoning = Number(t.reasoning_output_tokens) || 0;
      usage.steps += 1;
      usage.inputTokens += input;
      usage.outputTokens += output;
      usage.reasoningTokens += reasoning;
      usage.cacheReadTokens += Number(t.cached_input_tokens) || 0;
      usage.cacheWriteTokens += Number(t.cache_write_input_tokens) || 0;
      usage.totalTokens += input + output + reasoning;
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

  // claude：有 result 汇总就用 result；进程被中断、没等到 result 时退回 assistant 事件去重累加。
  let claudeDurationMs = 0;
  if (claudeResults.length) {
    // 只有全都没有 model_usage_since_last_result 时才需要判断是不是累计口径。
    const cumulative = claudeResults.every((r) => !r.delta) && claudeResults.every((r, i) => {
      if (i === 0) return true;
      const p = claudeResults[i - 1];
      return r.input >= p.input && r.output >= p.output
        && r.cacheRead >= p.cacheRead && r.cacheWrite >= p.cacheWrite;
    });
    const picked = cumulative
      ? claudeResults[claudeResults.length - 1]
      : claudeResults.reduce((acc, r) => ({
        input: acc.input + r.input,
        output: acc.output + r.output,
        cacheRead: acc.cacheRead + r.cacheRead,
        cacheWrite: acc.cacheWrite + r.cacheWrite,
        cost: acc.cost + r.cost,
        durationMs: acc.durationMs + r.durationMs,
        turns: acc.turns + r.turns,
      }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, durationMs: 0, turns: 0 });
    usage.inputTokens += picked.input;
    usage.outputTokens += picked.output;
    usage.cacheReadTokens += picked.cacheRead;
    usage.cacheWriteTokens += picked.cacheWrite;
    usage.costUsd += picked.cost;
    // 有每轮增量时 num_turns 是每轮口径，直接相加；老口径下 num_turns 可能是累计值，用去重后的 assistant 数。
    const turns = claudeResults.some((r) => r.delta)
      ? claudeResults.reduce((sum, r) => sum + r.turns, 0)
      : 0;
    usage.steps += turns || claudeAssistants.size;
    usage.totalTokens += picked.input + picked.output;
    claudeDurationMs = claudeResults.reduce((sum, r) => sum + r.durationMs, 0);
  } else if (claudeAssistants.size) {
    for (const u of claudeAssistants.values()) {
      usage.steps += 1;
      usage.inputTokens += u.input;
      usage.outputTokens += u.output;
      usage.cacheReadTokens += u.cacheRead;
      usage.cacheWriteTokens += u.cacheWrite;
      usage.totalTokens += u.input + u.output;
    }
  }

  usage.exitedMs = exitedMs;
  usage.durationMs = exitedMs || (lastStep > firstStep ? lastStep - firstStep : claudeDurationMs);
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
