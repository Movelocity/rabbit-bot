/**
 * 任务派发：每条任务一个一次性进程，不常驻 worker。
 *
 * 流程：
 *   1. writeTaskDoc 把任务写进 <work_dir>/.ufa/tasks/task-<id>.md，文档里带更新契约；
 *   2. startTask 用 opencode/mimo run 拉起一次性进程，抓 session id 落库；
 *   3. resumeTask 用同一个 session id（-s <id>）再启动；
 *   4. stopTask 只负责杀进程树，cancel 时用。
 *
 * 回环 API 的地址和 token 只通过环境变量交给子进程（RB_API_BASE / RB_API_TOKEN），
 * 任务文档里也只写变量名，不落明文 token。
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { APP_ROOT } from "../config.ts";
import type { Store } from "./db.ts";
import { getTask, updateTask, type Task } from "./tasks.ts";
import { appendTaskEvent } from "./task-events.ts";

export const MIMO_BIN = "/Users/viking/.mimocode/bin/mimo";
export const DEFAULT_CAPTURE_MS = 3000;
export const DEFAULT_DATA_DIR = path.join(APP_ROOT, "data");

export type Executor = "opencode" | "mimo";

export interface DispatchDeps {
  apiBase: string;
  token: string;
  /** runner 日志根目录：<dataDir>/tasks/<id>/runner.jsonl。默认 app/data */
  dataDir?: string;
  /** 测试注入：替换 opencode/mimo 可执行文件 */
  executorBin?: string;
  /** 启动后多少毫秒内没抓到 sessionID 就放弃（默认 3000） */
  captureMs?: number;
  /** 测试注入时钟 */
  now?: number;
  /** stopTask 宽限期，默认 5000ms */
  graceMs?: number;
}

export interface LaunchResult {
  task: Task;
  pid: number | null;
  session_id: string;
  captured: boolean;
}

function parseFiles(files: string): string[] {
  try {
    const v = JSON.parse(files || "[]");
    return Array.isArray(v) ? v.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}

export function taskDocPath(task: Pick<Task, "id" | "work_dir">): string {
  return path.join(String(task.work_dir ?? ""), ".ufa", "tasks", `task-${task.id}.md`);
}

/** 任务文档：人/执行器都能直接照着做，更新方式用 curl 写死，token 只引用环境变量。 */
export function renderTaskDoc(task: Task, opts: { apiBase?: string } = {}): string {
  const id = task.id;
  const executor = task.executor || "opencode";
  const workerId = `${executor}-${id}`;
  const apiBase = opts.apiBase || "http://127.0.0.1:3738";
  const files = parseFiles(task.files);
  const field = (label: string, value: string) => `- ${label}：${value || "（未填写）"}`;

  return [
    `# 任务 #${id}`,
    "",
    "## 目标",
    task.goal || "（未填写）",
    "",
    "## 产出物",
    task.deliverable || "（未填写）",
    "",
    "## 约束",
    task.constraints || "（未填写）",
    "",
    "## 验收",
    task.acceptance || "（未填写）",
    "",
    "## 关联文件",
    ...(files.length ? files.map((f) => `- ${f}`) : ["- （没有指定）"]),
    "",
    "## 工作目录",
    `\`${task.work_dir}\``,
    "",
    "## 任务 id",
    String(id),
    "",
    field("执行器", executor),
    field("会话 id", task.session_id),
    "",
    "## 如何更新任务",
    "",
    `所有请求都带 \`Authorization: Bearer $RB_API_TOKEN\`，接口根地址用 \`$RB_API_BASE\`（例如 ${apiBase}）。`,
    "不要把 token 明文写进任务文档、日志或任何工作文件。",
    "",
    "### 1. 先报一次进度（开始执行时）",
    "",
    "```bash",
    `curl -s -X POST "$RB_API_BASE/v1/tasks/${id}/progress" \\`,
    '  -H "Authorization: Bearer $RB_API_TOKEN" \\',
    '  -H "Content-Type: application/json" \\',
    `  -d '{"worker_id":"${workerId}","stage":"working","note":"开始执行"}'`,
    "```",
    "",
    "### 2. 完成",
    "",
    "```bash",
    `curl -s -X POST "$RB_API_BASE/v1/tasks/${id}/complete" \\`,
    '  -H "Authorization: Bearer $RB_API_TOKEN" \\',
    '  -H "Content-Type: application/json" \\',
    `  -d '{"worker_id":"${workerId}","result":"写清楚做了什么、结果如何","artifact":"产出物路径或链接"}'`,
    "```",
    "",
    "### 3. 失败",
    "",
    "```bash",
    `curl -s -X POST "$RB_API_BASE/v1/tasks/${id}/fail" \\`,
    '  -H "Authorization: Bearer $RB_API_TOKEN" \\',
    '  -H "Content-Type: application/json" \\',
    `  -d '{"worker_id":"${workerId}","error":"失败原因","retryable":false}'`,
    "```",
    "",
    "### 4. 权限申请",
    "",
    "需要越权或动工作目录之外的东西时，先申请，再轮询结果：",
    "",
    "```bash",
    'curl -s -X POST "$RB_API_BASE/v1/approvals" \\',
    '  -H "Authorization: Bearer $RB_API_TOKEN" \\',
    '  -H "Content-Type: application/json" \\',
    `  -d '{"task_id":${id},"worker_id":"${workerId}","action":"要做的事","detail":"路径或参数","why":"为什么需要"}'`,
    "",
    'curl -s "$RB_API_BASE/v1/approvals/<审批id>" \\',
    '  -H "Authorization: Bearer $RB_API_TOKEN"',
    "```",
    "",
    "`status=approved` 才继续；`rejected` / `timeout` 立即停下，用 fail 回传。",
    "",
    "## 执行要求",
    "",
    "- 开始执行时先调用一次 progress，`stage=working`。",
    "- 每次被启动或恢复执行都重新 progress 一次；结束时重新回传本次结果（即使上一轮已经完成过）。",
    "- 完成或失败必须回传：调用 complete 或 fail，不要只写文件就结束。",
    "- 不要编结果：没验证过的不报成完成，没测过的不报指标。",
    "- 不要改工作目录之外的文件。",
    "- 进度以任务池为准（`GET $RB_API_BASE/v1/tasks/<id>/events`），不要另外造一套进度。",
    "",
  ].join("\n");
}

/** 写任务文档并回填 doc_path；目录不存在就建。返回绝对路径。 */
export function writeTaskDoc(store: Store, task: Task, opts: { apiBase?: string } = {}): string {
  const workDir = String(task.work_dir ?? "").trim();
  if (!workDir) throw new Error("任务没有 work_dir，不能写任务文档");
  if (!path.isAbsolute(workDir)) throw new Error(`work_dir 必须是绝对路径：${workDir}`);
  const docPath = taskDocPath(task);
  fs.mkdirSync(path.dirname(docPath), { recursive: true });
  fs.writeFileSync(docPath, renderTaskDoc(task, opts), "utf8");
  updateTask(store, task.id, { doc_path: docPath });
  return docPath;
}

function pickSessionId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, any>;
  const candidates = [
    o.sessionID, o.session_id, o.sessionId,
    o.part?.sessionID, o.part?.session_id,
    o.session?.id,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return null;
}

function extractSessionId(line: string): string | null {
  const text = line.trim();
  if (!text.startsWith("{")) return null;
  try {
    return pickSessionId(JSON.parse(text));
  } catch {
    return null;
  }
}

export function isRunnerAlive(pid: number | null | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killTree(pid: number, signal: NodeJS.Signals): void {
  // detached 子进程是进程组组长：先杀整组，失败再退回到单 pid
  try {
    process.kill(-pid, signal);
    return;
  } catch { /* 不是组长或已经没了 */ }
  try { process.kill(pid, signal); } catch { /* 已经没了 */ }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 会话标题：任务号 + 短名（老任务没名字就用目标），让人一眼看出这条会话在干什么。 */
export function sessionTitle(task: Task): string {
  const name = String(task.name ?? "").replace(/^#+\s*/, "").trim();
  const goal = String(task.goal ?? "").replace(/\s+/g, " ").trim();
  const label = name || goal;
  return `#${task.id} ${label.length > 48 ? label.slice(0, 47) + "…" : label || "任务"}`;
}

function executorArgs(task: Task, prompt: string, resume: boolean): { bin: string; args: string[] } {
  const executor: Executor = task.executor === "mimo" ? "mimo" : "opencode";
  const args = ["run", prompt, ...(resume ? ["-s", task.session_id] : []), "--dir", task.work_dir,
    "--title", sessionTitle(task), "--format", "json"];
  const model = String(task.model ?? "").trim();
  if (model) args.push(executor === "mimo" ? "--model" : "-m", model);
  return { bin: executor === "mimo" ? MIMO_BIN : "opencode", args };
}

interface LaunchOptions extends DispatchDeps {
  resume: boolean;
}

async function launch(store: Store, task: Task, opts: LaunchOptions): Promise<LaunchResult> {
  const fresh = getTask(store, task.id);
  if (!fresh) throw new Error(`没有任务 #${task.id}`);
  const workDir = String(fresh.work_dir ?? "").trim();
  if (!path.isAbsolute(workDir)) throw new Error(`工作目录必须是绝对路径：${workDir || "（空）"}`);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(workDir);
  } catch {
    throw new Error(`工作目录不存在：${workDir}`);
  }
  if (!stat.isDirectory()) throw new Error(`工作目录不是目录：${workDir}`);
  if (opts.resume && !fresh.session_id.trim()) {
    throw new Error(`任务 #${fresh.id} 没有 session_id，不能恢复`);
  }

  // 文档缺失就补一份（dispatch 正常路径会先写，这里兜底显式 start/resume）
  let docPath = fresh.doc_path && fs.existsSync(fresh.doc_path) ? fresh.doc_path : "";
  if (!docPath) docPath = writeTaskDoc(store, getTask(store, fresh.id)!, { apiBase: opts.apiBase });

  const prompt = opts.resume ? `继续任务，先读 ${docPath}` : `读 ${docPath} 并执行`;
  const { bin, args } = executorArgs({ ...fresh, doc_path: docPath }, prompt, opts.resume);
  const executor: Executor = fresh.executor === "mimo" ? "mimo" : "opencode";
  const workerId = `${executor}-${fresh.id}`;
  const dataDir = opts.dataDir ?? DEFAULT_DATA_DIR;
  const logDir = path.join(dataDir, "tasks", String(fresh.id));
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, "runner.jsonl");
  const out = fs.createWriteStream(logFile, { flags: "a" });
  const startedAt = opts.now ?? Date.now();

  let child: ChildProcess;
  try {
    child = spawn(opts.executorBin ?? bin, args, {
      cwd: workDir,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, RB_API_BASE: opts.apiBase, RB_API_TOKEN: opts.token },
    });
  } catch (e) {
    out.end();
    throw new Error(`启动 ${executor} 失败：${(e as Error).message}`);
  }

  let sessionId = fresh.session_id;
  let captured = opts.resume;
  let buffer = "";
  let done = false;
  let timer: NodeJS.Timeout | null = null;

  const captureDone = new Promise<void>((resolve) => {
    const finish = () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve();
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      out.write(chunk);
      if (captured) return;
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const sid = extractSessionId(line);
        if (sid) {
          sessionId = sid;
          captured = true;
          finish();
          break;
        }
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => out.write(chunk));
    child.once("error", () => finish());
    child.once("close", () => {
      out.end();
      finish();
    });
    // 恢复不需要抓 session：立刻返回，别把 API 请求拖到任务结束
    if (opts.resume) finish();
    else timer = setTimeout(finish, opts.captureMs ?? DEFAULT_CAPTURE_MS);
  });

  try {
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", reject);
    });
  } catch (e) {
    if (timer) clearTimeout(timer);
    out.end();
    updateTask(store, fresh.id, { runner_pid: null, status: "pending" });
    throw new Error(`启动 ${executor} 失败：${(e as Error).message}`);
  }

  const pid = child.pid ?? null;
  // 记下实际命令（只有参数，token 在 env 里），e2e / 排查时能确认有没有带 -s
  fs.appendFileSync(logFile, `${JSON.stringify({
    type: "ufa-dispatch",
    action: opts.resume ? "resume" : "start",
    executor,
    pid,
    cwd: workDir,
    argv: [opts.executorBin ?? bin, ...args],
    at: startedAt,
  })}\n`);
  updateTask(store, fresh.id, {
    status: "running",
    worker_id: workerId,
    claimed_at: startedAt,
    lease_until: null,
    stage: "starting",
    session_id: opts.resume ? fresh.session_id : "",
    runner_pid: pid,
    runner_started_at: startedAt,
    doc_path: docPath,
  });

  await captureDone;

  if (!captured) {
    fs.appendFileSync(logFile, `${JSON.stringify({
      type: "ufa-dispatch",
      note: `${opts.captureMs ?? DEFAULT_CAPTURE_MS}ms 内未从事件流抓到 sessionID（pid=${pid ?? "?"}），恢复任务前需要手动补 session_id`,
      at: Date.now(),
    })}\n`);
  }

  const updated = updateTask(store, fresh.id, {
    session_id: sessionId,
    runner_pid: pid,
    runner_started_at: startedAt,
    doc_path: docPath,
  });

  appendTaskEvent(store, fresh.id, {
    text: opts.resume
      ? `恢复执行，session=${sessionId || "（未捕获）"}，工作目录=${workDir}`
      : `已启动 ${executor}，session=${sessionId || "（未捕获）"}，工作目录=${workDir}`,
    sender: "dispatcher",
    senderName: "调度器",
  });

  // 自然退出也要留痕：退出码、信号、耗时，别让任务永远停在 running 还没人知道
  const recordExit = (code: number | null, signal: NodeJS.Signals | null) => {
    try {
      const ms = Date.now() - startedAt;
      const secs = (ms / 1000).toFixed(1);
      const how = code === 0 ? "正常退出" : signal ? `被信号 ${signal} 终止` : `退出码 ${code ?? "?"}`;
      appendTaskEvent(store, fresh.id, {
        text: `执行器进程已退出：${how}（pid=${pid ?? "?"}，session=${sessionId || "（未捕获）"}，${secs}s）`,
        sender: "dispatcher",
        senderName: "调度器",
      });
      const now = getTask(store, fresh.id);
      if (pid !== null && now?.runner_pid === pid) {
        const patch: Parameters<typeof updateTask>[2] = { runner_pid: null, runner_started_at: null };
        if (now.status === "running") patch.stage = "exited";
        updateTask(store, fresh.id, patch);
      }
      fs.appendFileSync(logFile, `${JSON.stringify({
        type: "ufa-dispatch", note: "process exited", code, signal, ms, at: Date.now(),
      })}\n`);
    } catch (e) {
      process.stderr.write(`记录执行器退出失败：${(e as Error).message}\n`);
    }
  };
  child.once("exit", recordExit);
  if (child.exitCode !== null || child.signalCode !== null) recordExit(child.exitCode, child.signalCode);

  child.unref();
  return { task: updated, pid, session_id: sessionId, captured };
}

/** 新起一个会话执行任务（会清掉旧 session_id）。 */
export async function startTask(store: Store, task: Task, deps: DispatchDeps): Promise<LaunchResult> {
  return launch(store, task, { ...deps, resume: false });
}

/** 用已有 session_id 恢复任务：同一会话继续，不重新开始。 */
export async function resumeTask(store: Store, task: Task, deps: DispatchDeps): Promise<LaunchResult> {
  const fresh = getTask(store, task.id);
  if (!fresh) throw new Error(`没有任务 #${task.id}`);
  if (!String(fresh.session_id ?? "").trim()) {
    throw new Error(`任务 #${fresh.id} 没有 session_id，不能恢复；请先 start 或重新创建`);
  }
  return launch(store, fresh, { ...deps, resume: true });
}

/** 杀进程树：TERM → graceMs → KILL；清 runner 字段，running 的任务回到 pending。 */
export async function stopTask(store: Store, task: Task, opts: { now?: number; graceMs?: number } = {}): Promise<Task> {
  const fresh = getTask(store, task.id);
  if (!fresh) throw new Error(`没有任务 #${task.id}`);
  const pid = fresh.runner_pid;
  const wasAlive = !!pid && isRunnerAlive(pid);
  if (pid && wasAlive) {
    killTree(pid, "SIGTERM");
    const deadline = Date.now() + (opts.graceMs ?? 5000);
    while (Date.now() < deadline && isRunnerAlive(pid)) await sleep(100);
    if (isRunnerAlive(pid)) killTree(pid, "SIGKILL");
  }
  const patch: Parameters<typeof updateTask>[2] = { runner_pid: null, runner_started_at: null };
  if (fresh.status === "running") patch.status = "pending";
  const updated = updateTask(store, fresh.id, patch);
  appendTaskEvent(store, fresh.id, {
    text: wasAlive ? `已停止执行（pid=${pid}）` : pid ? `runner 已退出（pid=${pid}），清理状态` : "没有在跑的进程，只清理 runner 状态",
    sender: "dispatcher",
    senderName: "调度器",
  });
  return updated;
}
