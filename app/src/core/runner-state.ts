/**
 * 执行器进程状态落盘：`<dataDir>/tasks/<id>/runner.state.json`。
 *
 * 为什么要单独落盘：任务表里的 runner_pid 只能证明「曾经起过一个 pid」，
 * 服务重启后既判断不了这个 pid 还是不是原来那个执行器（pid 会被系统复用），
 * 也拿不到退出码 / 耗时。状态文件由 detached 的 preaper 进程写，
 * 主服务重启、甚至主服务没起来时，它照样能把退出结果留在盘上，供 re-attach 时读。
 *
 * 字段只放排障需要的：pid、进程启动时间（区分 pid 复用）、命令行、日志路径、退出码。
 * 不落 token——凭据只通过环境变量交给执行器。
 */
import fs from "node:fs";
import path from "node:path";

export type RunnerStateStatus = "running" | "exited" | "failed" | "lost" | "stopped";

export interface RunnerState {
  v: 1;
  task_id: number;
  /** 本次启动的唯一标识：防止上一轮 reaper 的迟到写入被当成这次的结果 */
  run_id: string;
  /** 执行器进程 pid；启动失败时是 null */
  pid: number | null;
  executor: string;
  action: "start" | "resume";
  /** `ps -p <pid> -o lstart=` 的原样输出，用来区分 pid 复用；取不到是空串 */
  boot: string;
  started_at: number;
  cwd: string;
  argv: string[];
  log: string;
  status: RunnerStateStatus;
  error?: string;
  exit_code?: number | null;
  signal?: string | null;
  /** 进程实际存活时长（preaper wait 出来的） */
  ms?: number;
  exited_at?: number;
  updated_at: number;
}

export function runnerStatePath(dataDir: string, taskId: number): string {
  return path.join(dataDir, "tasks", String(taskId), "runner.state.json");
}

function normalize(raw: unknown): RunnerState | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, any>;
  if (typeof o.task_id !== "number") return null;
  const pid = typeof o.pid === "number" && o.pid > 0 ? o.pid : null;
  const status = String(o.status ?? "");
  if (!["running", "exited", "failed", "lost", "stopped"].includes(status)) return null;
  return {
    v: 1,
    task_id: o.task_id,
    run_id: String(o.run_id ?? ""),
    pid,
    executor: String(o.executor ?? ""),
    action: o.action === "resume" ? "resume" : "start",
    boot: String(o.boot ?? ""),
    started_at: Number(o.started_at) || 0,
    cwd: String(o.cwd ?? ""),
    argv: Array.isArray(o.argv) ? o.argv.map((x: unknown) => String(x)) : [],
    log: String(o.log ?? ""),
    status: status as RunnerStateStatus,
    ...(o.error !== undefined ? { error: String(o.error) } : {}),
    ...(o.exit_code !== undefined ? { exit_code: o.exit_code === null ? null : Number(o.exit_code) } : {}),
    ...(o.signal !== undefined ? { signal: o.signal === null ? null : String(o.signal) } : {}),
    ...(o.ms !== undefined && Number.isFinite(Number(o.ms)) ? { ms: Number(o.ms) } : {}),
    ...(o.exited_at !== undefined ? { exited_at: Number(o.exited_at) } : {}),
    updated_at: Number(o.updated_at) || 0,
  };
}

export function readRunnerState(dataDir: string, taskId: number): RunnerState | null {
  try {
    const raw = fs.readFileSync(runnerStatePath(dataDir, taskId), "utf8");
    return normalize(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** 原子写：先写 .tmp 再 rename，避免主服务读到半个 JSON。 */
export function writeRunnerState(dataDir: string, state: RunnerState): void {
  const file = runnerStatePath(dataDir, state.task_id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

/** 只改状态字段，保留原有 pid/argv 等；没有状态文件时什么都不做。 */
export function patchRunnerState(
  dataDir: string,
  taskId: number,
  patch: Partial<Pick<RunnerState, "boot" | "status" | "error" | "exit_code" | "signal" | "ms" | "exited_at">>,
): RunnerState | null {
  const current = readRunnerState(dataDir, taskId);
  if (!current) return null;
  const next: RunnerState = { ...current, ...patch, updated_at: Date.now() };
  writeRunnerState(dataDir, next);
  return next;
}
