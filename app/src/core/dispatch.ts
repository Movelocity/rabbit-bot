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
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { APP_ROOT } from "../config.ts";
import type { Store } from "./db.ts";
import { getTask, updateTask, type Task } from "./tasks.ts";
import { appendTaskEvent } from "./task-events.ts";
import { parseRunnerUsage, runnerLogPath, taskUsagePatch } from "./task-usage.ts";
import { loadBusinessMap, renderTaskContext, renderTaskContextFromDir, type BusinessMap } from "../ops/business-map.ts";

// 不写死用户名：默认用当前用户 home；换机器或装在别处时用 MIMO_BIN 覆盖
export const MIMO_BIN = process.env.MIMO_BIN || path.join(os.homedir(), ".mimocode/bin/mimo");
export const DEFAULT_CAPTURE_MS = 3000;
export const DEFAULT_DATA_DIR = path.join(APP_ROOT, "data");

export type Executor = "opencode" | "mimo";

export interface DispatchDeps {
  apiBase: string;
  token: string;
  /** runner 日志根目录：<dataDir>/tasks/<id>/runner.jsonl。默认 app/data */
  dataDir?: string;
  /** worker 汇报文件落点（宿主绝对路径），作为 RB_SHARED_DIR 交给执行器 */
  sharedDir?: string;
  /** 业务地图目录；传了才会在任务文档里写“业务上下文” */
  businessDir?: string;
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
export function renderTaskDoc(task: Task, opts: { apiBase?: string; sharedDir?: string; businessDir?: string; map?: BusinessMap | null } = {}): string {
  const id = task.id;
  const executor = task.executor || "opencode";
  const workerId = `${executor}-${id}`;
  const apiBase = opts.apiBase || "http://127.0.0.1:3738";
  const shared = String(opts.sharedDir ?? "").trim();
  // 正式路径用 SQLite 里的地图；显式传 map=null 表示「确认没有地图」，
  // 不传才回退到按目录读文件（测试/旧调用）。
  const business = opts.map !== undefined
    ? (opts.map ? renderTaskContext(opts.map, task.context) : "")
    : renderTaskContextFromDir(opts.businessDir, task.context);
  const files = parseFiles(task.files);
  const field = (label: string, value: string) => `- ${label}：${value || "（未填写）"}`;
  const optional = (value?: string | null) =>
    String(value ?? "").trim() || "（未指定：按仓库约定和 WA 最佳实践处理）";

  return [
    `# 任务 #${id}`,
    "",
    "## 目标",
    task.goal || "（未填写）",
    "",
    "## 产出物",
    optional(task.deliverable),
    "",
    "## 约束",
    optional(task.constraints),
    "",
    "## 验收",
    optional(task.acceptance),
    "",
    "## 关联文件",
    ...(files.length ? files.map((f) => `- ${f}`) : ["- （没有指定）"]),
    "",
    "## 工作目录",
    `\`${task.work_dir}\``,
    "",
    ...(business ? [business, ""] : []),
    ...(shared ? [
      "## 开工前",
      "",
      `先读 WA 通用最佳实践：\`$RB_SHARED_DIR/WA-BEST-PRACTICES.md\`（宿主路径 \`${shared}/WA-BEST-PRACTICES.md\`）。`,
      `跨任务工作记忆：\`$RB_MEMORY_FILE\`（宿主路径 \`${path.join(path.dirname(shared), "memory.md")}\`）。开工前读一遍；有会跨任务复用的约定、坑、决策就追加一条。不要写密钥和隐私，不要重写别人的条目。`,
      `再到 shared 里搜同主题旧交接：\`rg -l "关键词" "$RB_SHARED_DIR" -g 'task-*.md'\`（同时覆盖 handoffs/ 和老位置）。`,
      "旧交接只当线索，先核实再复用；没有相关上下文就直接按任务做。",
      "",
      "## 交接文档",
      "",
      `本次任务的关键上下文写到 \`$RB_SHARED_DIR/handoffs/task-${id}.md\`（宿主路径 \`${shared}/handoffs/task-${id}.md\`，覆盖写）。`,
      "写清楚：做了什么、关键决定与原因、验证过什么、产出路径、遗留/风险、给下一个任务的线索；不要把 token 写进去。",
      "交接文件不是完成信号，完成/失败仍要调 complete / fail。",
      "",
      "## 产出落点",
      "",
      `最终交付物复制或导出到 \`$RB_SHARED_DIR/outputs/task-${id}/\`（宿主路径 \`${shared}/outputs/task-${id}/\`）。不要只留在工作目录里。`,
      "UFA 在沙盒里通过 `/work/shared/outputs/` 验收；`complete` 的 artifact 填这个 shared 路径，工作目录里的原始路径可以另外写在交接文档里。",
      "如果执行器被限制只能写工作目录，就先在工作目录生成，再复制到上面的 shared 产出目录。",
      "",
    ] : []),
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
    "### 4. 执行边界",
    "",
    "本任务审批通过后以无审批模式执行，执行阶段没有运行时审批，不要调用 approvals 接口等待批准。",
    "",
    "只能在上面「工作目录」指定的目录内读写和运行命令，不得越出工作目录；越界视为违规，任务会按失败处理。",
    "",
    "## 执行要求",
    "",
    "- 开始执行时先读 WA 最佳实践和 `handoffs/` 里的同主题旧交接，再调用一次 progress（`stage=working`）。",
    "- 每次被启动或恢复执行都重新 progress 一次；结束时重新回传本次结果（即使上一轮已经完成过）。",
    "- 完成或失败必须回传：调用 complete 或 fail，不要只写文件就结束。",
    "- 不要编结果：没验证过的不报成完成，没测过的不报指标。",
    "- 小改动自己做到底；只有要改对外接口、跨模块，或产品/设计方向没定，才停下来报 blocked。不要为常规实现选择停下来问「继续吗」。",
    "- 完成的标准是自检 + 相关验证通过；文件写了、代码改了、任务建了都不算完成。",
    "- 最终产出要复制到 shared/outputs/task-<id>/，只留在工作目录等于不可验收。",
    "- 报 blocked / fail 要带证据、已尝试过的方案、还缺什么；只说「做不了」不算。",
    "- 人给的后续线索、修正能解决阻塞时，直接继续，不用等人再说「继续」。",
    "- 不要改工作目录之外的文件。",
    "- 进度以任务池为准（`GET $RB_API_BASE/v1/tasks/<id>/events`），不要另外造一套进度。",
    "",
  ].join("\n");
}

/** 写任务文档并回填 doc_path；目录不存在就建。返回绝对路径。 */
export function writeTaskDoc(store: Store, task: Task, opts: { apiBase?: string; sharedDir?: string; businessDir?: string } = {}): string {
  const workDir = String(task.work_dir ?? "").trim();
  if (!workDir) throw new Error("任务没有 work_dir，不能写任务文档");
  if (!path.isAbsolute(workDir)) throw new Error(`work_dir 必须是绝对路径：${workDir}`);
  const docPath = taskDocPath(task);
  fs.mkdirSync(path.dirname(docPath), { recursive: true });
  const map = loadBusinessMap(store);
  fs.writeFileSync(docPath, renderTaskDoc(task, { ...opts, map: map ?? undefined }), "utf8");
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

export interface DeadRunnerSweepResult {
  /** 这轮扫了多少条 running 任务 */
  checked: number;
  /** 确认进程已退出、已清理的任务 id */
  dead: number[];
}

/**
 * 周期性批量巡检：所有 running 且带 runner_pid 的任务，一次全扫。
 *
 * `launch` 里的 exit 回调只在 rabbit-bot 进程还活着、且还持有 child 句柄时才会触发；
 * 进程重启、句柄丢失、或退出信号没被收到时，任务会永远停在 running。
 * 这里按 pid 探活兜底：死掉的就清 runner 状态，并在任务池里发一条调度器消息，
 * 让 UFA 通过任务事件醒来处理（重试 / 换执行器 / 标记失败）。
 *
 * 用 `UPDATE ... WHERE runner_pid=?` 原子认领，避免和 exit 回调重复处理同一条任务。
 */
export function sweepDeadRunners(store: Store, opts: { dataDir?: string; now?: number } = {}): DeadRunnerSweepResult {
  const running = store.db.prepare(
    "SELECT * FROM tasks WHERE status='running' AND runner_pid IS NOT NULL ORDER BY id ASC",
  ).all() as Task[];
  const dead: number[] = [];
  const dataDir = opts.dataDir ?? DEFAULT_DATA_DIR;
  for (const task of running) {
    const pid = task.runner_pid;
    if (pid === null || isRunnerAlive(pid)) continue;
    const now = opts.now ?? Date.now();
    const claimed = store.db.prepare(
      "UPDATE tasks SET runner_pid=NULL, runner_started_at=NULL, stage='exited', updated_at=? WHERE id=? AND status='running' AND runner_pid=?",
    ).run(now, task.id, pid);
    if (Number(claimed.changes) === 0) continue; // exit 回调/别的进程已经处理
    dead.push(task.id);
    appendTaskEvent(store, task.id, {
      text: `执行器进程已退出：巡检发现进程不存在（pid=${pid}，session=${task.session_id || "（未捕获）"}）`,
      sender: "dispatcher",
      senderName: "调度器",
    });
    // 进程已经没了，runner.jsonl 是完整的：顺手把用量落库
    updateTask(store, task.id, taskUsagePatch(parseRunnerUsage(path.join(dataDir, "tasks", String(task.id), "runner.jsonl"))));
  }
  return { checked: running.length, dead };
}

export interface LongRunningSweepResult {
  /** 这轮扫了多少条 running 任务 */
  checked: number;
  /** 首次超过阈值、刚写过提醒的任务 id */
  warned: number[];
}

/**
 * 长任务提醒：running 且超过阈值（默认 10 分钟）的任务，在任务池写一条 internal 提醒。
 *
 * 只提醒一次：用 `UPDATE ... WHERE long_run_notified_at IS NULL` 原子认领；
 * 每次启动/恢复任务时把这个字段清空，所以「同一轮执行」只提醒一次。
 * 消息标 internal 且不通知调度器：只留痕给任务面板/事件接口，不唤醒 UFA，也不进上下文。
 */
export function sweepLongRunningTasks(
  store: Store,
  opts: { now?: number; thresholdMs?: number } = {},
): LongRunningSweepResult {
  const thresholdMs = opts.thresholdMs ?? 10 * 60_000;
  const now = opts.now ?? Date.now();
  if (!(thresholdMs > 0)) return { checked: 0, warned: [] };
  const running = store.db.prepare(
    "SELECT * FROM tasks WHERE status='running' AND runner_pid IS NOT NULL ORDER BY id ASC",
  ).all() as Task[];
  const warned: number[] = [];
  for (const task of running) {
    const startedAt = task.runner_started_at ?? task.start_at;
    if (now - startedAt < thresholdMs) continue;
    const claimed = store.db.prepare(
      "UPDATE tasks SET long_run_notified_at=?, updated_at=? WHERE id=? AND long_run_notified_at IS NULL AND status='running'",
    ).run(now, now, task.id);
    if (Number(claimed.changes) === 0) continue;
    warned.push(task.id);
    const mins = Math.round((now - startedAt) / 60_000);
    appendTaskEvent(store, task.id, {
      text: `任务 #${task.id} 已持续 ${mins} 分钟，可能有异常。勿回复此消息。`,
      sender: "dispatcher",
      senderName: "调度器",
      internal: true,
      notify: false,
    });
  }
  return { checked: running.length, warned };
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
  args.push("--dangerously-skip-permissions");
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
  if (!docPath) docPath = writeTaskDoc(store, getTask(store, fresh.id)!, { apiBase: opts.apiBase, sharedDir: opts.sharedDir, businessDir: opts.businessDir });

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
      env: {
        ...process.env,
        RB_API_BASE: opts.apiBase,
        RB_API_TOKEN: opts.token,
        RB_APP_DIR: APP_ROOT,
        ...(opts.sharedDir ? {
          RB_SHARED_DIR: opts.sharedDir,
          RB_MEMORY_FILE: path.join(path.dirname(opts.sharedDir), "memory.md"),
        } : {}),
      },
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
    long_run_notified_at: null,
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
      // 进程退出后再算：这时 runner.jsonl 是完整的，token / 费用 / 耗时一次落库
      updateTask(store, fresh.id, taskUsagePatch(parseRunnerUsage(logFile)));
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
export async function stopTask(
  store: Store,
  task: Task,
  opts: { now?: number; graceMs?: number; dataDir?: string } = {},
): Promise<Task> {
  const fresh = getTask(store, task.id);
  if (!fresh) throw new Error(`没有任务 #${task.id}`);
  const pid = fresh.runner_pid;
  const wasAlive = !!pid && isRunnerAlive(pid);
  const startedAt = fresh.runner_started_at ?? fresh.claimed_at;
  if (pid && wasAlive) {
    killTree(pid, "SIGTERM");
    const deadline = Date.now() + (opts.graceMs ?? 5000);
    while (Date.now() < deadline && isRunnerAlive(pid)) await sleep(100);
    if (isRunnerAlive(pid)) killTree(pid, "SIGKILL");
  }
  const patch: Parameters<typeof updateTask>[2] = { runner_pid: null, runner_started_at: null };
  if (fresh.status === "running") patch.status = "pending";
  updateTask(store, fresh.id, patch);
  // 关闭也要落一次用量：进程被 SIGTERM/KILL 时不一定还能等到 exit 回调。
  // 已记录过的退出耗时之和 + 本轮实际跑的时长；token 从 runner.jsonl 重算，不会重复累加。
  if (pid !== null) {
    const usage = parseRunnerUsage(runnerLogPath(opts.dataDir ?? DEFAULT_DATA_DIR, fresh.id));
    if (wasAlive && startedAt) {
      usage.durationMs = usage.exitedMs + Math.max(0, (opts.now ?? Date.now()) - startedAt);
    }
    updateTask(store, fresh.id, taskUsagePatch(usage));
  }
  const updated = getTask(store, fresh.id)!;
  appendTaskEvent(store, fresh.id, {
    text: wasAlive ? `已停止执行（pid=${pid}）` : pid ? `runner 已退出（pid=${pid}），清理状态` : "没有在跑的进程，只清理 runner 状态",
    sender: "dispatcher",
    senderName: "调度器",
  });
  return updated;
}
