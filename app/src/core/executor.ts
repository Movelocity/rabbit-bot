/** 任务执行器枚举：新增执行器时先改这里，dispatch / API / 管理台共用。 */
export type Executor = "opencode" | "mimo" | "codex" | "claude";

export const EXECUTORS: Executor[] = ["opencode", "mimo", "codex", "claude"];

export const DEFAULT_EXECUTOR: Executor = "opencode";

export function isExecutor(v: unknown): v is Executor {
  return typeof v === "string" && (EXECUTORS as string[]).includes(v);
}

/** 老数据 / 未知值统一回退到 opencode，和数据库默认值一致。 */
export function normalizeExecutor(v: unknown): Executor {
  return isExecutor(v) ? v : DEFAULT_EXECUTOR;
}

export function executorChoices(): string {
  return EXECUTORS.join(" / ");
}
