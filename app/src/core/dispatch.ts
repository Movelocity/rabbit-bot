/**
 * 任务派发：每条任务一个一次性进程，不常驻 worker。
 *
 * 流程：
 *   1. writeTaskDoc 把任务写进 <runtimeDir>/.ufa/tasks/task-<id>.md，文档里带更新契约；
 *   2. startTask 拉起的其实是两级「脱管」进程，不是执行器本身：
 *        rabbit-bot ──spawn──> launcher（立刻退出，把孩子甩给 launchd）
 *                                └─spawn──> reaper（detached，等执行器退出）
 *                                             └─spawn──> opencode/mimo/codex/claude run
 *      launcher 一退出，reaper 就被 launchd 收养，不再是 rabbit-bot 的后代；
 *      pm2 restart 的 treekill 按 ppid 找子孙，找不到它，所以执行器能活过重启。
 *      reaper 只干三件事：spawn、把 pid/命令行写进 runner.state.json、wait 退出码写回同一文件。
 *   3. resumeTask 用同一个 session id（-s/--session <id>）再启动；
 *   4. stopTask 杀执行器进程组（执行器自己是组长），cancel 时用；
 *   5. sweepDeadRunners 负责「重启后接管」：pid 还活着就重新挂上 1s 探活 watcher，
 *      死了就用状态文件里的退出码补事件和用量，进程没了但没留下退出信息就记「巡检发现进程不存在」。
 *
 * 执行器 stdout/stderr 直接重定向到 data/tasks/<id>/runner.jsonl（不走管道）：
 * 主进程退出/重启时管道会断，执行器写 stdout 收到 EPIPE 会把自己弄死；写文件没有这个问题，
 * session id 也从同一个文件里 tail 出来。
 *
 * 回环 API 的地址和 token 只通过环境变量交给子进程（RB_API_BASE / RB_API_TOKEN），
 * 任务文档里也只写变量名，不落明文 token。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { APP_ROOT } from "../config.ts";
import type { Store } from "./db.ts";
import { getTask, taskProjectSlugs, updateTask, type Task } from "./tasks.ts";
import { appendTaskEvent } from "./task-events.ts";
import { parseRunnerUsage, runnerLogPath, taskUsagePatch } from "./task-usage.ts";
import { procStartTime } from "./lockfile.ts";
import { killTree, resolveExecutable, spawnPlan } from "./platform.ts";
import {
  patchRunnerState, readRunnerState, runnerStatePath, writeRunnerState, type RunnerState,
} from "./runner-state.ts";
import { loadBusinessMap, renderTaskContext, renderTaskContextFromDir, type BusinessMap } from "../ops/business-map.ts";
import { normalizeExecutor, type Executor } from "./executor.ts";

export type { Executor } from "./executor.ts";

// 不写死用户名：默认用当前用户 home；换机器或装在别处时用 MIMO_BIN 覆盖
export const MIMO_BIN = process.env.MIMO_BIN || resolveExecutable(path.join(os.homedir(), ".mimocode/bin/mimo"));
// codex 一般装在 PATH（~/.local/bin 等）；装在别处时用 CODEX_BIN 覆盖
export const CODEX_BIN = process.env.CODEX_BIN || "codex";
// claude 走宿主全局安装（PATH 上的 claude）；装在别处时用 CLAUDE_BIN 覆盖
export const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
export const DEFAULT_CAPTURE_MS = 15000;  // opencode 冷启动首个事件实测 ~3.4s，3s 窗口实测漏抓（任务 #2）
export const DEFAULT_DATA_DIR = path.join(APP_ROOT, "data");


/** 接管执行器后的探活间隔（ms）；执行器退出后要尽快把事件和退出码写回任务池。 */
export const DEFAULT_RUNNER_POLL_MS = 1000;

/**
 * 第一级 launcher：只负责把 reaper 甩出去然后立刻退出。
 * 它是 rabbit-bot 的直接子进程，退出后 reaper 被 launchd 收养，脱离 pm2 的进程树。
 * 用 `node -e` 内联而不是额外文件：tsx / dist 两种启动方式都不用管脚本路径。
 */
const RUNNER_LAUNCHER_JS = `
const { spawn } = require("node:child_process");
const reaper = spawn(process.execPath, ["-e", process.env.RB_REAPER_JS || ""], {
  detached: true,
  stdio: "ignore",
  env: process.env,
});
reaper.unref();
process.exit(0);
`;

/**
 * 第二级 reaper：spawn 执行器（自己当组长，便于 stopTask 杀整组）、写状态文件、wait 退出。
 * 它已经不是 rabbit-bot 的子孙，不能被主进程的句柄/管道绑住，所以状态与退出信息只走文件。
 * 这里的代码是纯 JS 字符串，不能写 TS 语法；带 \\n 的是要写进日志文件的换行。
 */
const RUNNER_REAPER_JS = `
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const spec = JSON.parse(process.env.RB_RUNNER_SPEC || "{}");
const write = (state) => {
  try {
    fs.mkdirSync(spec.dir, { recursive: true });
    // 主服务会在拿到 pid 后补 boot（ps 启动时间）；这里写 running/exited 时不能把它覆盖掉
    try {
      const prev = JSON.parse(fs.readFileSync(spec.state, "utf8"));
      if (prev && prev.run_id === state.run_id && prev.pid === state.pid && prev.boot && !state.boot) {
        state = Object.assign({}, state, { boot: prev.boot });
      }
    } catch (e) {}
    const tmp = spec.state + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\\n");
    fs.renameSync(tmp, spec.state);
  } catch (e) {}
};
const base = {
  v: 1,
  run_id: spec.run_id || "",
  task_id: spec.task_id,
  executor: spec.executor,
  action: spec.action,
  boot: "",
  started_at: Date.now(),
  cwd: spec.cwd,
  argv: [spec.bin].concat(spec.args || []),
  log: spec.log,
  updated_at: Date.now(),
};
let out;
try {
  out = fs.openSync(spec.log, "a");
} catch (e) {
  write(Object.assign({}, base, {
    pid: null, status: "failed",
    error: "打不开执行器日志：" + String((e && e.message) || e),
  }));
  process.exit(1);
}
let child;
try {
  child = spawn(spec.bin, spec.args, {
    cwd: spec.cwd,
    detached: true,
    shell: !!spec.shell,
    stdio: ["ignore", out, out],
    // Node spawn 只改真实 cwd，不会同步 PWD。opencode（Bun）用 $PWD 认项目目录，
    // 不覆盖就会跑回 rabbit-bot 自己的目录（任务 #71/#72/#74 都是这么挂的）。
    env: Object.assign({}, process.env, { PWD: spec.cwd }),
  });
} catch (e) {
  fs.closeSync(out);
  write(Object.assign({}, base, {
    pid: null, status: "failed",
    error: "启动执行器失败：" + String((e && e.message) || e),
  }));
  process.exit(1);
}
fs.closeSync(out);
const pid = child.pid || null;
const running = Object.assign({}, base, { pid: pid, status: "running" });
write(running);
try {
  fs.appendFileSync(spec.log, JSON.stringify({
    type: "ufa-dispatch",
    action: spec.action,
    executor: spec.executor,
    pid: pid,
    cwd: spec.cwd,
    argv: [spec.bin].concat(spec.args || []),
    at: base.started_at,
  }) + "\\n");
} catch (e) {}
child.once("error", (e) => {
  write(Object.assign({}, running, {
    status: "failed",
    error: String((e && e.message) || e),
    updated_at: Date.now(),
  }));
  process.exit(1);
});
child.once("exit", (code, signal) => {
  const ms = Date.now() - base.started_at;
  try {
    fs.appendFileSync(spec.log, JSON.stringify({
      type: "ufa-dispatch", note: "process exited", code: code, signal: signal, ms: ms, at: Date.now(),
    }) + "\\n");
  } catch (e) {}
  write(Object.assign({}, running, {
    status: "exited",
    exit_code: code,
    signal: signal,
    ms: ms,
    exited_at: Date.now(),
    updated_at: Date.now(),
  }));
  process.exit(0);
});
`;


export interface DispatchDeps {
  apiBase: string;
  token: string;
  /** runner 日志根目录：<dataDir>/tasks/<id>/runner.jsonl。默认 app/data */
  dataDir?: string;
  /** 运行时目录：任务文档和临时文件放这儿，不写进 work_dir。默认从 sharedDir 推 */
  runtimeDir?: string;
  /** worker 汇报文件落点（宿主绝对路径），作为 RB_SHARED_DIR 交给执行器 */
  sharedDir?: string;
  /** 业务地图目录；传了才会在任务文档里写“业务上下文” */
  businessDir?: string;
  /** 测试注入：替换执行器可执行文件（opencode / mimo / codex / claude） */
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

/**
 * 运行时目录：优先取显式 runtimeDir；否则从 sharedDir 推（<runtimeDir>/shared）。
 * 拿不到时返回空串，调用方退回旧位置（只用于测试/旧调用，生产路径一定会传）。
 */
function resolveRuntimeDir(opts: { runtimeDir?: string; sharedDir?: string }): string {
  const explicit = String(opts.runtimeDir ?? "").trim();
  if (explicit) return path.resolve(explicit);
  const shared = String(opts.sharedDir ?? "").trim();
  return shared ? path.dirname(path.resolve(shared)) : "";
}

/**
 * 任务文档路径：统一放运行时目录，避免在 work_dir 里留 .ufa。
 * 没给运行时目录时保留旧路径兜底（测试直接调用 writeTaskDoc 的场景）。
 */
export function taskDocPath(task: Pick<Task, "id" | "work_dir">, runtimeDir?: string): string {
  const runtime = String(runtimeDir ?? "").trim();
  if (runtime) return path.join(path.resolve(runtime), ".ufa", "tasks", `task-${task.id}.md`);
  return path.join(String(task.work_dir ?? ""), ".ufa", "tasks", `task-${task.id}.md`);
}

/** 新文档写好后清掉旧位置：work_dir/.ufa/tasks/task-<id>.md，空目录顺手收走。 */
function cleanupLegacyTaskDoc(task: Pick<Task, "id" | "work_dir">, docPath: string): void {
  const workDir = String(task.work_dir ?? "").trim();
  if (!workDir) return;
  const legacyDoc = path.join(workDir, ".ufa", "tasks", `task-${task.id}.md`);
  if (path.resolve(legacyDoc) === path.resolve(docPath)) return;
  try { fs.rmSync(legacyDoc, { force: true }); } catch { /* 清不掉不影响新文档 */ }
  for (const dir of [path.dirname(legacyDoc), path.join(workDir, ".ufa")]) {
    try {
      if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    } catch { /* 目录非空/无权限都跳过 */ }
  }
}

/** 任务关联项目时，把 shared/projects/<slug>/ 的文档路径写进任务文档，WA 开工前直接读。 */
function renderProjectDocs(task: Task, shared: string): string[] {
  const projects = taskProjectSlugs(task);
  if (!projects.length || !shared) return [];
  const exists = (file: string) => { try { return fs.existsSync(file); } catch { return false; } };
  const mark = (file: string) => exists(file) ? "" : "（未找到，按约定创建）";
  const lines = ["## 项目文档", ""];
  for (const slug of projects) {
    const dir = path.join(shared, "projects", slug);
    const contextFile = path.join(dir, "context.md");
    const planFile = path.join(dir, "plan.md");
    lines.push(`- 项目 \`${slug}\``);
    lines.push(`  - 上下文（宿主）：\`${contextFile}\`${mark(contextFile)}`);
    lines.push(`  - 计划（宿主）：\`${planFile}\`${mark(planFile)}`);
    lines.push(`  - 沙盒：\`$RB_SHARED_DIR/projects/${slug}/context.md\`、\`$RB_SHARED_DIR/projects/${slug}/plan.md\``);
  }
  lines.push("", "开工前先读项目上下文和计划；任务文档只引用路径，不要把文档整段复制进交接。", "");
  return lines;
}

/** 任务文档：人/执行器都能直接照着做，更新方式用 curl 写死，token 只引用环境变量。 */
export function renderTaskDoc(task: Task, opts: { apiBase?: string; runtimeDir?: string; sharedDir?: string; businessDir?: string; map?: BusinessMap | null } = {}): string {
  const id = task.id;
  const executor = normalizeExecutor(task.executor);
  const workerId = `${executor}-${id}`;
  const apiBase = opts.apiBase || "http://127.0.0.1:3738";
  const shared = String(opts.sharedDir ?? "").trim();
  const runtime = resolveRuntimeDir(opts);
  const scratch = runtime ? path.join(runtime, ".ufa", "work", `task-${id}`) : "";
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
    `开工前先核对：\`pwd -P\` 必须等于 \`realpath '${task.work_dir}'\`。当前目录不是这个路径时，直接调用 fail 结束任务（error 写实际目录），不要换目录继续；工作目录下的子目录仍算在工作目录内。`,
    "",
    ...(business ? [business, ""] : []),
    ...(shared ? renderProjectDocs(task, shared) : []),
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
    ...(scratch ? [
      "## 临时文件",
      "",
      `临时脚本、中间产物、截图放 \`$RB_TASK_DIR\`（宿主路径 \`${scratch}\`），不要在工作目录里建 \`.ufa\`。`,
      "任务文档用 `$RB_TASK_DOC` 指路，避免把仓库根目录当草稿纸。",
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
    ...(process.platform === "win32" ? [
      "### 原生 Windows（PowerShell；推荐优先用 WSL2）",
      "",
      "```powershell",
      '$headers = @{ Authorization = "Bearer $env:RB_API_TOKEN" }',
      `Invoke-RestMethod -Method Post -Uri "$env:RB_API_BASE/v1/tasks/${id}/progress" -Headers $headers -ContentType "application/json" -Body '{"worker_id":"${workerId}","stage":"working","note":"开始执行"}'`,
      `Invoke-RestMethod -Method Post -Uri "$env:RB_API_BASE/v1/tasks/${id}/complete" -Headers $headers -ContentType "application/json" -Body '{"worker_id":"${workerId}","result":"写清楚做了什么、结果如何","artifact":"产出物路径或链接"}'`,
      `Invoke-RestMethod -Method Post -Uri "$env:RB_API_BASE/v1/tasks/${id}/fail" -Headers $headers -ContentType "application/json" -Body '{"worker_id":"${workerId}","error":"失败原因","retryable":false}'`,
      "```",
      "",
    ] : []),
    "### 4. 执行边界",
    "",
    "本任务审批通过后以无审批模式执行，执行阶段没有运行时审批，不要调用 approvals 接口等待批准。",
    "",
    "只能在上面「工作目录」指定的目录内读写和运行命令，不得越出工作目录；任务文档、`$RB_TASK_DIR`、`$RB_SHARED_DIR` 是明确的例外。越界视为违规，任务会按失败处理。",
    "",
    "## 执行要求",
    "",
    `- 开工先核对当前目录：\`pwd -P\` 要与 \`realpath '${task.work_dir}'\` 一致；不一致立即 \`fail\` 结束任务并写实际目录，不要自行切换目录继续。`,
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
export function writeTaskDoc(store: Store, task: Task, opts: { apiBase?: string; runtimeDir?: string; sharedDir?: string; businessDir?: string } = {}): string {
  const workDir = String(task.work_dir ?? "").trim();
  if (!workDir) throw new Error("任务没有 work_dir，不能写任务文档");
  if (!path.isAbsolute(workDir)) throw new Error(`work_dir 必须是绝对路径：${workDir}`);
  const runtimeDir = resolveRuntimeDir(opts);
  const docPath = taskDocPath(task, runtimeDir);
  fs.mkdirSync(path.dirname(docPath), { recursive: true });
  const map = loadBusinessMap(store);
  fs.writeFileSync(docPath, renderTaskDoc(task, { ...opts, runtimeDir, map: map ?? undefined }), "utf8");
  cleanupLegacyTaskDoc(task, docPath);
  updateTask(store, task.id, { doc_path: docPath });
  return docPath;
}

function pickSessionId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, any>;
  const candidates = [
    o.sessionID, o.session_id, o.sessionId,
    o.thread_id, o.threadId,
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

/** pid 活着、且启动时间和状态文件里记的一致，才算「还是那个执行器」（防 pid 复用）。 */
export function runnerProcessAlive(pid: number | null | undefined, boot: string): boolean {
  if (!isRunnerAlive(pid)) return false;
  const expected = String(boot ?? "").trim();
  if (!expected) return true;
  const current = procStartTime(pid!);
  // 刚 spawn 的进程 ps 可能还没准备好：拿不到就按活着算，别误杀
  if (!current) return true;
  return current === expected;
}

/** 任务上的 runner 是否还活着；有状态文件时用 boot 字段防 pid 复用。 */
export function runnerAlive(task: Pick<Task, "id" | "runner_pid">, dataDir?: string): boolean {
  if (!task.runner_pid) return false;
  const state = readRunnerState(dataDir ?? DEFAULT_DATA_DIR, task.id);
  const boot = state && state.pid === task.runner_pid ? state.boot : "";
  return runnerProcessAlive(task.runner_pid, boot);
}

/** 读文件 [offset, EOF]；读不到返回空串，offset 原样带回。 */
function readLogChunk(file: string, offset: number): { text: string; next: number } {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    if (size <= offset) return { text: "", next: offset };
    const len = Math.min(size - offset, 1_000_000);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, offset);
    return { text: buf.toString("utf8"), next: offset + len };
  } catch {
    return { text: "", next: offset };
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/** 从日志文件 [offset, 现在] 里 tail 出 sessionID；到期没抓到返回空串。 */
async function captureSessionFromLog(file: string, offset: number, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let next = offset;
  let buffer = "";
  for (;;) {
    const chunk = readLogChunk(file, next);
    if (chunk.text) {
      next = chunk.next;
      buffer += chunk.text;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const sid = extractSessionId(line);
        if (sid) return sid;
      }
    }
    if (Date.now() >= deadline) return "";
    await sleep(chunk.text ? 0 : 50);
  }
}

/** 扫日志尾部找 sessionID（服务重启接管老任务时补齐用）。 */
function scanSessionFromLog(file: string, maxBytes = 2_000_000): string {
  let size = 0;
  try { size = fs.statSync(file).size; } catch { return ""; }
  const { text } = readLogChunk(file, Math.max(0, size - maxBytes));
  for (const line of text.split("\n")) {
    const sid = extractSessionId(line);
    if (sid) return sid;
  }
  return "";
}

/** reaper 落盘状态可能要几十毫秒：启动时轮询等它写出 pid。 */
async function waitForRunnerState(
  dataDir: string,
  taskId: number,
  runId: string,
  timeoutMs: number,
): Promise<RunnerState | null> {
  const deadline = Date.now() + Math.max(100, timeoutMs);
  for (;;) {
    const state = readRunnerState(dataDir, taskId);
    // 只认这一轮的 run_id：上一轮 reaper 退出时可能迟到写同一个状态文件
    if (state && state.run_id === runId && (state.status !== "running" || state.pid)) return state;
    if (Date.now() >= deadline) return null;
    await sleep(25);
  }
}

function seedRunnerState(task: Task, dataDir: string, pid: number): RunnerState {
  const now = Date.now();
  return {
    v: 1,
    run_id: "",
    task_id: task.id,
    pid,
    executor: normalizeExecutor(task.executor),
    action: "start",
    boot: procStartTime(pid) ?? "",
    started_at: task.runner_started_at ?? task.claimed_at ?? now,
    cwd: task.work_dir,
    argv: [],
    log: runnerLogPath(dataDir, task.id),
    status: "running",
    updated_at: now,
  };
}

interface AttachedRunner {
  pid: number;
  timer: NodeJS.Timeout;
}

/** 本进程正在盯的执行器（task id → watcher）。重启后为空，正好用来判断「这是不是新接管」。 */
const runnerWatchers = new Map<number, AttachedRunner>();

export function detachRunnerWatch(taskId: number): void {
  const current = runnerWatchers.get(taskId);
  if (!current) return;
  clearInterval(current.timer);
  runnerWatchers.delete(taskId);
}

function exitDescription(state: RunnerState | null, via: "watch" | "sweep" | undefined): string {
  if (state?.status === "exited") {
    if (state.signal) return `被信号 ${state.signal} 终止`;
    if (state.exit_code === 0) return "正常退出";
    return `退出码 ${state.exit_code ?? "?"}`;
  }
  if (state?.status === "stopped") return "已停止执行";
  if (state?.status === "failed") return `启动失败${state.error ? `：${state.error}` : ""}`;
  return via === "watch" ? "进程已退出（未捕获退出码）" : "巡检发现进程不存在";
}

/**
 * 记一次执行器退出：原子认领 → 写任务池事件 → 落用量 → 状态文件补 lost。
 * 认领用 `UPDATE ... WHERE runner_pid=?`，watcher 和巡检同时看到同一个死 pid 时只会有一个写。
 */
function recordRunnerExit(
  store: Store,
  task: Task,
  opts: { dataDir?: string; now?: number; via?: "watch" | "sweep" } = {},
): boolean {
  const pid = task.runner_pid;
  if (!pid) return false;
  const dataDir = opts.dataDir ?? DEFAULT_DATA_DIR;
  const now = opts.now ?? Date.now();
  // 不限定 status=running：任务可能已经 complete，但执行器进程还在收尾，退出时仍要清 pid、落用量
  const claimed = store.db.prepare(
    "UPDATE tasks SET runner_pid=NULL, runner_started_at=NULL, stage=CASE WHEN status='running' THEN 'exited' ELSE stage END, updated_at=? WHERE id=? AND runner_pid=?",
  ).run(now, task.id, pid);
  if (Number(claimed.changes) === 0) return false;
  const state = readRunnerState(dataDir, task.id);
  const own = state && state.pid === pid ? state : null;
  const startedAt = own?.started_at || task.runner_started_at || task.claimed_at;
  const ms = own && Number.isFinite(own.ms) ? Number(own.ms) : startedAt ? Math.max(0, now - startedAt) : 0;
  const secs = (ms / 1000).toFixed(1);
  appendTaskEvent(store, task.id, {
    text: `执行器进程已退出：${exitDescription(own, opts.via)}（pid=${pid}，session=${task.session_id || "（未捕获）"}，${secs}s）`,
    sender: "dispatcher",
    senderName: "调度器",
  });
  // 进程已经没了，runner.jsonl 是完整的：顺手把用量落库
  updateTask(store, task.id, taskUsagePatch(parseRunnerUsage(runnerLogPath(dataDir, task.id))));
  if (own && own.status === "running") {
    patchRunnerState(dataDir, task.id, { status: "lost", exited_at: now });
  }
  return true;
}

/** 进程刚没时 reaper 可能还没写完退出码：最多等 500ms，再按「未捕获」记。 */
async function settleRunnerExit(store: Store, task: Task, dataDir: string): Promise<void> {
  const deadline = Date.now() + 500;
  for (;;) {
    const state = readRunnerState(dataDir, task.id);
    if (state && state.pid === task.runner_pid && state.status !== "running") break;
    if (Date.now() >= deadline) break;
    await sleep(50);
  }
  recordRunnerExit(store, task, { dataDir, via: "watch" });
}

/**
 * 挂一个 1s 探活 watcher：执行器退出后尽快写事件（巡检是 30s 一次，太慢）。
 * 只认「pid 活 + boot 一致」；任务被停/被取消/pid 换了就自己摘掉。
 */
function ensureRunnerWatch(store: Store, task: Task, opts: { dataDir?: string; pollMs?: number } = {}): void {
  const pid = task.runner_pid;
  if (!pid) return;
  const current = runnerWatchers.get(task.id);
  if (current && current.pid === pid) return;
  detachRunnerWatch(task.id);
  const dataDir = opts.dataDir ?? DEFAULT_DATA_DIR;
  const every = Math.max(100, opts.pollMs ?? DEFAULT_RUNNER_POLL_MS);
  const timer = setInterval(() => {
    try {
      const fresh = getTask(store, task.id);
      // 任务已经 complete 时也要继续盯到进程退出：用量要在这时落库、pid 要清掉
      if (!fresh || fresh.runner_pid !== pid) {
        detachRunnerWatch(task.id);
        return;
      }
      const state = readRunnerState(dataDir, task.id);
      const own = state && state.pid === pid ? state : null;
      if (own && (own.status === "exited" || own.status === "failed" || own.status === "stopped")) {
        detachRunnerWatch(task.id);
        recordRunnerExit(store, fresh, { dataDir, via: "watch" });
        return;
      }
      if (runnerProcessAlive(pid, own?.boot ?? "")) return;
      detachRunnerWatch(task.id);
      void settleRunnerExit(store, fresh, dataDir);
    } catch {
      // store 已关闭 / 临时读失败：摘掉 watcher，下一次巡检会重挂
      detachRunnerWatch(task.id);
    }
  }, every);
  (timer as any).unref?.();
  runnerWatchers.set(task.id, { pid, timer });
}

export interface RunnerSweepResult {
  /** 这轮扫了多少条 running 任务 */
  checked: number;
  /** 确认进程已退出、已清理的任务 id */
  dead: number[];
  /** 服务重启后重新接管（pid 还活着）的任务 id */
  attached: number[];
}

/**
 * 周期性批量巡检 + 重启接管：所有 running 且带 runner_pid 的任务，一次全扫。
 *
 * 执行器现在脱离 rabbit-bot 进程树（见文件头），主进程重启后拿不到 child 句柄和 exit 事件，
 * 所以这里负责两件事：
 *   1. pid 还活着且确实是启动时那个进程（boot 一致）→ 重新挂 watcher，这就是「re-attach」；
 *      老任务没抓到 session 的，从 runner.jsonl 里补；
 *   2. pid 没了（或已被复用）→ 按状态文件里的退出码补事件 + 用量，清 runner 字段。
 *
 * 死掉的那条用 `UPDATE ... WHERE runner_pid=?` 原子认领，避免和 watcher 重复处理。
 */
export function sweepDeadRunners(
  store: Store,
  opts: { dataDir?: string; now?: number; pollMs?: number } = {},
): RunnerSweepResult {
  const running = store.db.prepare(
    "SELECT * FROM tasks WHERE status='running' AND runner_pid IS NOT NULL ORDER BY id ASC",
  ).all() as Task[];
  const dead: number[] = [];
  const attached: number[] = [];
  const dataDir = opts.dataDir ?? DEFAULT_DATA_DIR;
  for (const task of running) {
    const pid = task.runner_pid;
    if (pid === null) continue;
    const state = readRunnerState(dataDir, task.id);
    const own = state && state.pid === pid ? state : null;
    if (runnerProcessAlive(pid, own?.boot ?? "")) {
      const already = runnerWatchers.get(task.id)?.pid === pid;
      if (!own) {
        const seeded = seedRunnerState(task, dataDir, pid);
        if (seeded.boot) writeRunnerState(dataDir, seeded);
      }
      ensureRunnerWatch(store, task, { dataDir, pollMs: opts.pollMs });
      if (already) continue;
      // 这次是本进程第一次看到这个 pid：服务重启后的接管，留一条痕迹给任务池
      let session = task.session_id;
      if (!String(session ?? "").trim()) {
        session = scanSessionFromLog(runnerLogPath(dataDir, task.id));
        if (session) updateTask(store, task.id, { session_id: session });
      }
      appendTaskEvent(store, task.id, {
        text: `已接回执行器进程（pid=${pid}，session=${session || "（未捕获）"}），不再重启`,
        sender: "dispatcher",
        senderName: "调度器",
      });
      attached.push(task.id);
      continue;
    }
    if (recordRunnerExit(store, task, { dataDir, now: opts.now, via: "sweep" })) dead.push(task.id);
  }
  // 已经 complete/cancelled、但执行器还在收尾的任务：接管/清理 pid，退出时把用量补齐。
  // 不算 attached/dead，也不改任务状态——它们已经不是 running 了。
  const settled = store.db.prepare(
    "SELECT * FROM tasks WHERE status!='running' AND runner_pid IS NOT NULL ORDER BY id ASC",
  ).all() as Task[];
  for (const task of settled) {
    const pid = task.runner_pid;
    if (pid === null) continue;
    const state = readRunnerState(dataDir, task.id);
    const own = state && state.pid === pid ? state : null;
    if (runnerProcessAlive(pid, own?.boot ?? "")) {
      ensureRunnerWatch(store, task, { dataDir, pollMs: opts.pollMs });
      continue;
    }
    recordRunnerExit(store, task, { dataDir, now: opts.now, via: "sweep" });
  }
  return { checked: running.length, dead, attached };
}


export interface LongRunningSweepResult {
  /** 这轮扫了多少条 running 任务 */
  checked: number;
  /** 首次超过阈值、刚写过提醒的任务 id */
  warned: number[];
}

/**
 * 长任务提醒：running 且超过阈值（默认 10 分钟）的任务，在任务池写一条普通事件。
 *
 * 只提醒一次：用 `UPDATE ... WHERE long_run_notified_at IS NULL` 原子认领；
 * 每次启动/恢复任务时把这个字段清空，所以「同一轮执行」只提醒一次。
 * 不标 internal、不关 notify：事件算任务池未读，会触发任务 tick 并让 UFA 在上下文里看到。
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
    });
  }
  return { checked: running.length, warned };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 会话标题：任务号 + 短名（老任务没名字就用目标），让人一眼看出这条会话在干什么。 */
export function sessionTitle(task: Task): string {
  const name = String(task.name ?? "").replace(/^#+\s*/, "").trim();
  const goal = String(task.goal ?? "").replace(/\s+/g, " ").trim();
  const label = name || goal;
  return `#${task.id} ${label.length > 48 ? label.slice(0, 47) + "…" : label || "任务"}`;
}

/**
 * opencode / mimo 的 argv 能力，按安装版本探测。
 *
 * 不同版本的 run 子命令参数并不一致：例如某个 v2 版本不认 `--dir`，带上就 81ms
 * 退出 code=1；又比如无审批开关从 `--dangerously-skip-permissions` 改成了 `--auto`。
 * 所以不写死整套参数：先读一次 `run --help` / `--help`，只带当前版本认识的 flag。
 * 探测失败（自定义包装器、测试假执行器）就退回旧参数，保证行为不变。
 */
export interface OpencodeCaps {
  /** `run --help` 里能看到 `--dir` */
  dir: boolean;
  /** 全局 help 里能看到 `--directory`（旧版在子命令前传） */
  directory: boolean;
  session: "long" | "short" | null;
  model: "long" | "short" | null;
  title: boolean;
  formatJson: boolean;
  permission: "--auto" | "--dangerously-skip-permissions" | "--yolo" | null;
  /** 2.0.32 起目录改成 run 子命令的位置参数 `<opencode> <subcommand> [flags] [<directory>]`，两个 flag 都不存在 */
  positionalDir?: boolean;
  /** run --help 里有 --standalone：起私有 server，会话目录跟随进程 cwd，且不受共享 serve 的 provider 热更新波及 */
  standalone?: boolean;
}

const opencodeCapsCache = new Map<string, OpencodeCaps | null>();

function helpText(bin: string, args: string[]): string {
  const plan = spawnPlan(bin, args);
  try {
    const r = spawnSync(plan.file, plan.args, {
      encoding: "utf8", timeout: 2000, shell: plan.shell, windowsHide: true,
    });
    if (r.status !== 0) return "";
    return `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  } catch {
    return "";
  }
}

/** 精确匹配 `--flag` / `-f`，避免 `--dir` 命中 `--directory` 之类的子串。 */
function listsFlag(help: string, long: string, short?: string): boolean {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const longRe = new RegExp(`(^|[\\s,])${esc(long)}(?=[\\s,=]|$)`, "m");
  if (longRe.test(help)) return true;
  if (!short) return false;
  return new RegExp(`(^|[\\s,])${esc(short)}(?=[\\s,]|$)`, "m").test(help);
}

function probeOpencodeCaps(bin: string): OpencodeCaps | null {
  let key = bin;
  try {
    const st = fs.statSync(bin);
    key = `${bin}|${st.mtimeMs}|${st.size}`;
  } catch { /* 拿不到 stat 就按路径缓存 */ }
  if (opencodeCapsCache.has(key)) return opencodeCapsCache.get(key)!;

  const runHelp = helpText(bin, ["run", "--help"]);
  const globalHelp = helpText(bin, ["--help"]);
  let caps: OpencodeCaps | null = null;
  if (runHelp || globalHelp) {
    const all = `${globalHelp}\n${runHelp}`;
    caps = {
      dir: listsFlag(runHelp, "--dir"),
      directory: listsFlag(globalHelp, "--directory") || listsFlag(runHelp, "--directory"),
      positionalDir: /\[<directory>\]/.test(globalHelp) || /\[<directory>\]/.test(runHelp),
      standalone: listsFlag(runHelp, "--standalone"),
      session: listsFlag(runHelp, "--session") ? "long"
        : listsFlag(runHelp, "-s") ? "short"
          : listsFlag(globalHelp, "--session") ? "long"
            : listsFlag(globalHelp, "-s") ? "short" : null,
      model: listsFlag(runHelp, "--model") ? "long"
        : listsFlag(runHelp, "-m") ? "short"
          : listsFlag(globalHelp, "--model") ? "long"
            : listsFlag(globalHelp, "-m") ? "short" : null,
      title: listsFlag(runHelp, "--title") || listsFlag(globalHelp, "--title"),
      formatJson: listsFlag(runHelp, "--format") || listsFlag(globalHelp, "--format"),
      permission: listsFlag(all, "--auto") ? "--auto"
        : listsFlag(all, "--dangerously-skip-permissions") ? "--dangerously-skip-permissions"
          : listsFlag(all, "--yolo") ? "--yolo" : null,
    };
  }
  opencodeCapsCache.set(key, caps);
  return caps;
}

/** 按探测结果拼 opencode/mimo 参数；caps=null 表示没探测到，按旧版参数兜底。 */
export function buildOpencodeArgs(
  task: Task,
  prompt: string,
  resume: boolean,
  caps: OpencodeCaps | null,
): string[] {
  const executor = normalizeExecutor(task.executor);
  const wd = String(task.work_dir ?? "").trim();
  const args: string[] = [];
  // `--directory` 要放在子命令前；`--dir` 放在 run 后面。cwd 始终是最低保障。
  // 目录为空的 task 不传目录参数（位置参数传空串会把 prompt 吞掉）。
  if (caps?.directory && wd) args.push("--directory", wd);
  args.push("run");
  if (caps?.dir && wd) args.push("--dir", wd);
  if (caps?.standalone) args.push("--standalone");   // 私有 server：目录与热更新双隔离
  args.push(prompt);

  if (resume) {
    if (!caps) args.push("-s", task.session_id);
    else if (caps.session === "long") args.push("--session", task.session_id);
    else if (caps.session === "short") args.push("-s", task.session_id);
    else throw new Error("当前执行器不支持恢复会话（help 里没有 --session / -s），请升级或换执行器");
  }

  if (!caps || caps.title) args.push("--title", sessionTitle(task));
  if (!caps || caps.formatJson) args.push("--format", "json");

  const model = String(task.model ?? "").trim();
  if (model) {
    if (!caps) args.push(executor === "mimo" ? "--model" : "-m", model);
    else if (caps.model === "long") args.push("--model", model);
    else if (caps.model === "short") args.push("-m", model);
    // 探测到该版本没有 model 参数：宁可不传，也别因为未知 flag 起不来
  }

  if (!caps) args.push("--dangerously-skip-permissions");
  else if (caps.permission) args.push(caps.permission);
  // 2.0.32 的全局用法是 `<opencode> <subcommand> [flags] [<directory>]`，
  // 目录必须是最后一个位置参数。放到 run 后面会被当成 message 吞进 prompt，
  // 真正决定目录的反而是 $PWD（见 RUNNER_REAPER_JS 里的覆盖）。
  if (!caps?.directory && !caps?.dir && caps?.positionalDir && wd) args.push(wd);
  return args;
}

function executorArgs(
  task: Task,
  prompt: string,
  resume: boolean,
  opts: { binPath?: string; probe?: boolean } = {},
): string[] {
  const executor = normalizeExecutor(task.executor);
  const model = String(task.model ?? "").trim();
  if (executor === "codex") {
    // codex exec 是非交互入口；--json 输出 JSONL（首条 thread.started 带 thread_id），
    // 工作目录用 -C 显式指定，--skip-git-repo-check 允许在非 git 目录里跑。
    const args = [
      "exec", "--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox",
      "-C", String(task.work_dir ?? ""),
    ];
    if (model) args.push("-m", model);
    if (resume) args.push("resume", task.session_id, prompt);
    else args.push(prompt);
    return args;
  }
  if (executor === "claude") {
    // claude -p 是打印模式；stream-json 逐行输出，system init 带 session_id，
    // result 带 usage / total_cost_usd。CLI 用宿主机全局安装的 claude（或 CLAUDE_BIN 指定）。
    // 无审批执行，并禁掉交互式提问工具，避免跑任务时等人回答。
    const args = [
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--permission-mode", "bypassPermissions",
      "--disallowedTools", "AskUserQuestion",
    ];
    if (model) args.push("--model", model);
    if (resume) args.push("--resume", task.session_id);
    args.push(prompt);
    return args;
  }

  const caps = opts.probe && opts.binPath ? probeOpencodeCaps(opts.binPath) : null;
  return buildOpencodeArgs(task, prompt, resume, caps);
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
  if (!docPath) docPath = writeTaskDoc(store, getTask(store, fresh.id)!, { apiBase: opts.apiBase, runtimeDir: opts.runtimeDir, sharedDir: opts.sharedDir, businessDir: opts.businessDir });

  const runtimeDir = resolveRuntimeDir(opts);
  const scratchDir = runtimeDir ? path.join(runtimeDir, ".ufa", "work", `task-${fresh.id}`) : "";
  if (scratchDir) fs.mkdirSync(scratchDir, { recursive: true });

  const prompt = opts.resume ? `继续任务，先读 ${docPath}` : `读 ${docPath} 并执行`;
  const executor: Executor = normalizeExecutor(fresh.executor);
  const baseBin = executor === "codex" ? CODEX_BIN
    : executor === "claude" ? CLAUDE_BIN
      : executor === "mimo" ? MIMO_BIN : "opencode";
  const binPath = resolveExecutable(opts.executorBin ?? baseBin);
  // 测试/显式指定可执行文件时不探测：那可能是任意包装器，跑 --help 会有副作用。
  const args = executorArgs({ ...fresh, doc_path: docPath }, prompt, opts.resume, {
    binPath, probe: opts.executorBin === undefined,
  });
  const plan = spawnPlan(binPath, args);
  const workerId = `${executor}-${fresh.id}`;
  const dataDir = opts.dataDir ?? DEFAULT_DATA_DIR;
  const logDir = path.join(dataDir, "tasks", String(fresh.id));
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, "runner.jsonl");
  const stateFile = runnerStatePath(dataDir, fresh.id);
  // 上一轮的 runner.state.json 先删掉：否则 waitForRunnerState 会立刻读到旧结果
  fs.rmSync(stateFile, { force: true });
  // 只从这一轮新写的内容里抓 session，避免读到上一轮日志
  let logOffset = 0;
  try { logOffset = fs.statSync(logFile).size; } catch { logOffset = 0; }
  const budget = Math.max(1000, opts.captureMs ?? DEFAULT_CAPTURE_MS);
  const deadline = Date.now() + budget;

  const env = {
    ...process.env,
    RB_API_BASE: opts.apiBase,
    RB_API_TOKEN: opts.token,
    RB_APP_DIR: APP_ROOT,
    RB_TASK_DOC: docPath,
    ...(scratchDir ? { RB_TASK_DIR: scratchDir } : {}),
    ...(opts.sharedDir ? {
      RB_SHARED_DIR: opts.sharedDir,
      RB_MEMORY_FILE: path.join(path.dirname(opts.sharedDir), "memory.md"),
    } : {}),
  };

  const runId = randomUUID();
  let launcher: ChildProcess;
  try {
    launcher = spawn(process.execPath, ["-e", RUNNER_LAUNCHER_JS], {
      detached: true,
      stdio: "ignore",
      env: {
        ...env,
        RB_REAPER_JS: RUNNER_REAPER_JS,
        RB_RUNNER_SPEC: JSON.stringify({
          run_id: runId,
          task_id: fresh.id,
          executor,
          action: opts.resume ? "resume" : "start",
          bin: plan.file,
          args: plan.args,
          shell: plan.shell,
          cwd: workDir,
          log: logFile,
          state: stateFile,
          dir: logDir,
        }),
      },
    });
    launcher.once("error", () => { /* 后面等不到状态文件会统一报错 */ });
    launcher.unref();
  } catch (e) {
    updateTask(store, fresh.id, { runner_pid: null, status: "pending" });
    throw new Error(`启动 ${executor} 失败：${(e as Error).message}`);
  }

  const state = await waitForRunnerState(dataDir, fresh.id, runId, Math.max(500, deadline - Date.now()));
  const pid = state?.pid ?? null;
  if (!state || !pid || state.status === "failed") {
    const reason = state?.error
      || (state?.status === "exited" ? "执行器启动后立刻退出，未拿到 pid" : "执行器进程没有起来（未拿到 pid 和状态文件）");
    updateTask(store, fresh.id, { runner_pid: null, status: "pending" });
    throw new Error(`启动 ${executor} 失败：${reason}`);
  }

  // pid 会复用：把 ps 的进程启动时间记进状态文件，重启后靠它确认「还是那个执行器」
  const boot = state.boot || procStartTime(pid) || "";
  if (boot && boot !== state.boot) patchRunnerState(dataDir, fresh.id, { boot });

  const startedAt = state.started_at || (opts.now ?? Date.now());
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

  let sessionId = fresh.session_id;
  let captured = opts.resume;
  if (!opts.resume) {
    // 恢复不需要抓 session：立刻返回，别把 API 请求拖到任务结束
    sessionId = await captureSessionFromLog(logFile, logOffset, Math.max(0, deadline - Date.now()));
    captured = !!sessionId;
  }

  if (!captured && !opts.resume) {
    fs.appendFileSync(logFile, `${JSON.stringify({
      type: "ufa-dispatch",
      note: `${budget}ms 内未从事件流抓到 sessionID（pid=${pid}），恢复任务前需要手动补 session_id`,
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
      ? "恢复执行（沿用 session）"
      : `已启动 ${executor}（session ${sessionId ? "已捕获" : "未捕获"}）`,
    sender: "dispatcher",
    senderName: "调度器",
  });

  // 执行器不在本进程树里，拿不到 exit 事件；挂 1s 探活 watcher，退出后从状态文件取退出码
  ensureRunnerWatch(store, updated, { dataDir });
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
  const dataDir = opts.dataDir ?? DEFAULT_DATA_DIR;
  const pid = fresh.runner_pid;
  const state = readRunnerState(dataDir, fresh.id);
  const own = state && state.pid === pid ? state : null;
  // 先摘 watcher：停止过程中的退出事件由本函数统一写，避免同一轮出现两条
  detachRunnerWatch(fresh.id);
  const wasAlive = !!pid && runnerProcessAlive(pid, own?.boot ?? "");
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
  if (own && own.status === "running") {
    patchRunnerState(dataDir, fresh.id, { status: "stopped", exited_at: opts.now ?? Date.now() });
  }
  // 关闭也要落一次用量：进程被 SIGTERM/KILL 时不一定还能等到 exit 回调。
  // 已记录过的退出耗时之和 + 本轮实际跑的时长；token 从 runner.jsonl 重算，不会重复累加。
  if (pid !== null) {
    const usage = parseRunnerUsage(runnerLogPath(dataDir, fresh.id));
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
