/**
 * 本地 REST API：把「池 / 计划 / 记忆 / 图片 / 联网 / 沙盒文件」暴露给沙盒里的技能脚本。
 *
 * 设计约束：
 *   - 只做宿主能力的出口，沙盒不挂库、不挂 scripts；
 *   - 所有请求必须带 Bearer token（token 自动生成到 data/run/api.token，并注入容器环境变量）；
 *   - 绑定地址由 config.api.host 决定（默认 0.0.0.0，容器才连得上，见 docs/sandbox-api.md）；
 *   - 返回体固定 {ok:true,data} / {ok:false,error}，和 CLI 的 JSON 约定一致。
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { APP_ROOT, type Config, type ModelChoice } from "./config.ts";
import type { Store } from "./core/db.ts";
import type { Logger } from "./core/logger.ts";
import { archivePool, listPools, readPool, searchPool } from "./ops/pools.ts";
import { listLlmSessions, readLlmSession } from "./ops/llm-logs.ts";
import {
  addGoals, addProgress, archiveBoard, checkGoal, createBoard, getBoard, listBoards, updateBoard,
  BOARD_STATUSES, type BoardStatus,
} from "./core/board.ts";
import { formatBoard } from "./ops/board.ts";
import { appendNote, cancelTask, createTask, getTask, isTaskStatus, normalizeTaskName, TASK_STATUSES, taskDisplayName, updateTask, type Task } from "./core/tasks.ts";
import {
  WorkerMismatchError, completeTask, failTask, progressTask, touchTask,
} from "./core/workers.ts";
import { appendTaskEvent, listTaskEvents } from "./core/task-events.ts";
import { isRunnerAlive, resumeTask, startTask, stopTask, writeTaskDoc } from "./core/dispatch.ts";
import {
  APPROVAL_STATUSES, ApprovalConflictError, createApproval, decideApproval, getApproval,
  isApprovalStatus,
} from "./core/approvals.ts";
import { formatTask, getTaskView, listTaskViews } from "./ops/tasks.ts";
import { taskStats } from "./ops/task-stats.ts";
import { auditTasks, type PmTaskRow } from "./core/pm.ts";
import { getApprovalView, listApprovalViews } from "./ops/approvals.ts";
import { addMemory, closeMemory, deleteMemory, listMemoriesGlobal, searchMemories, traceMemory, updateMemory } from "./ops/memories.ts";
import { getProject, listProjects, updateProject } from "./ops/projects.ts";
import { listPrompts, markFreshSession, readPersona, readPrompt, writePersona, writePrompt } from "./ops/runtime-files.ts";
import { listImages, resolveImagePath } from "./ops/images.ts";
import { fetchWeb, searchWeb } from "./ops/web.ts";
import { listSandboxFiles, readSandboxFile, writeSandboxFile } from "./ops/exec.ts";
import { listOutputs, listOutputTree, readOutput, readOutputRaw } from "./ops/outputs.ts";
import { readWorkingMemory } from "./core/working-memory.ts";
import {
  effectiveModelSettings, normalizeChoice, saveModelSettings, MAX_MODEL_CHOICES, type ModelSettings,
} from "./ops/model-settings.ts";
import { listSkills } from "./ops/skills.ts";
import { listExecutors } from "./ops/executors.ts";
import { ensureBusinessSeeded, loadBusinessMap, relationEdges, replaceBusinessMap } from "./ops/business-map.ts";
import { lintBusinessMap, writeBusinessLintReport } from "./ops/business-lint.ts";
import { boardDir, businessDir, sharedDir } from "./core/runtime.ts";
import { usageCalls, usageSeries, usageSummary } from "./ops/usage.ts";
import { createSchedule, formatSchedule, isScheduleStatus } from "./core/schedules.ts";
import {
  applySchedulerSettings, effectiveSchedulerSettings, saveSchedulerSettings, validateSchedulerSettings,
} from "./ops/scheduler-settings.ts";
import {
  effectiveMemoryReviewSettings, saveMemoryReviewSettings, validateMemoryReviewSettings,
} from "./ops/memory-review.ts";
import {
  applyWatchdogSettings, effectiveWatchdogSettings, saveWatchdogSettings, validateWatchdogSettings,
} from "./ops/watchdog-settings.ts";
import {
  applySendReviewSettings, effectiveSendReviewSettings, mainPoolId, saveSendReviewSettings, validateSendReviewSettings,
} from "./ops/send-review-settings.ts";
import { resolveSendReviewConfig, sendReviewReady } from "./core/send-review.ts";
import type { Scheduler } from "./core/scheduler.ts";

const MAX_BODY = 512 * 1024;
const DEFAULT_PORT = 3738;
const MAX_BUSINESS_EDGES = 1000;

export interface ApiDeps {
  cfg: Config;
  store: Store;
  log: Logger;
  token: string;
  /** 任务完成置位 pending tick 时喊一声；没注入就只落标记（测试/只读进程） */
  enqueue?: () => void;
  /** 测试注入：替换任务执行器可执行文件 */
  executorBin?: string;
  /** 任务建好后发审批提示（原聊天或 IM 审批房）；不传则只能在 Web 任务页审批 */
  onTaskCreated?: (task: Task) => void;
  /** 任务在 Web 审批/驳回/取消后，清掉 IM 里的待审提示 */
  onTaskDecided?: (taskId: number) => void;
  /** 调度器：Web 保存调度设置后调用 updateConfig 立即生效；日程变更后叫它马上重查 */
  scheduler?: Pick<Scheduler, "updateConfig"> & Partial<Pick<Scheduler, "notifyScheduleChange">>;
  /** 管理台换主模型：由 App 负责校验凭据、持久化并重建会话 */
  switchModel?: (provider: string, model: string) => Promise<ModelSettings>;
  /** 管理台可选模型：返回当前有凭据的模型 */
  listModels?: () => Promise<{ provider: string; model: string; name: string }[]>;
}

const WEB_ROOT = path.join(APP_ROOT, "web");

const MIME: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

/**
 * 本地 Web 控制台的静态文件。未登录也能打开页面；接口仍然要 token。
 * 只认 `/`（index.html）、`/favicon.ico` 和 `/ui/*`，碰到路径穿越就当没这个文件，继续走 404。
 */
function serveStatic(pathname: string, res: http.ServerResponse, method: string): boolean {
  if (
    pathname !== "/" &&
    pathname !== "/ui" &&
    pathname !== "/favicon.ico" &&
    !pathname.startsWith("/ui/")
  ) return false;
  let rel: string;
  try {
    rel = pathname === "/" || pathname === "/ui"
      ? "index.html"
      : pathname === "/favicon.ico"
        ? "favicon.ico"
        : decodeURIComponent(pathname.slice("/ui/".length));
  } catch {
    return false;
  }
  const abs = path.resolve(WEB_ROOT, rel);
  if (!abs.startsWith(WEB_ROOT + path.sep)) return false;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  const buf = fs.readFileSync(abs);
  res.writeHead(200, {
    "content-type": MIME[path.extname(abs).toLowerCase()] ?? "application/octet-stream",
    "content-length": buf.length,
    "cache-control": "no-cache",
  });
  res.end(method === "HEAD" ? undefined : buf);
  return true;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const safeEqual = (a: string, b: string): boolean => {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let raw = "";
    let done = false;
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      raw += chunk.toString("utf8");
      if (raw.length > MAX_BODY) {
        done = true;
        reject(new HttpError(413, `body 太大（上限 ${MAX_BODY} 字节）`));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (done) return;
      if (!raw.trim()) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new HttpError(400, "不是合法 JSON")); }
    });
    req.on("error", reject);
  });
}

const qInt = (v: string | null): number | undefined => {
  if (v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const qBool = (v: string | null): boolean => v === "1" || v === "true";

function bodyWorkerId(body: any): string {
  if (typeof body.worker_id !== "string" || !body.worker_id.trim()) throw new HttpError(400, "缺少 worker_id");
  return body.worker_id.trim();
}

function validateWorkDir(raw: unknown): string {
  const workDir = typeof raw === "string" ? raw.trim() : "";
  if (!workDir) throw new HttpError(400, "缺少 work_dir（任务工作目录，绝对路径）");
  if (!path.isAbsolute(workDir)) throw new HttpError(400, `work_dir 必须是绝对路径：${workDir}`);
  let stat: fs.Stats;
  try { stat = fs.statSync(workDir); } catch {
    throw new HttpError(400, `work_dir 不存在：${workDir}`);
  }
  if (!stat.isDirectory()) throw new HttpError(400, `work_dir 不是目录：${workDir}`);
  return workDir;
}

function validateExecutor(raw: unknown): "opencode" | "mimo" {
  const executor = raw === undefined ? "opencode" : raw;
  if (executor !== "opencode" && executor !== "mimo") {
    throw new HttpError(400, 'executor 只能是 "opencode" 或 "mimo"');
  }
  return executor;
}

function normalizeFiles(raw: unknown): string | undefined {
  if (Array.isArray(raw)) return JSON.stringify(raw.map((x) => String(x)));
  if (typeof raw === "string") return raw;
  return undefined;
}

/** 起 API；cfg.api.enabled=false 时返回 null。 */
export async function startApiServer(d: ApiDeps): Promise<http.Server | null> {
  if (d.cfg.api?.enabled === false) return null;
  // 老库第一次启动：把 runtime/business 的文件地图导一次；之后只读 SQLite
  try { ensureBusinessSeeded(d.store, businessDir(d.cfg)); } catch { /* 坏地图不挡 API */ }
  const port = d.cfg.api?.port ?? DEFAULT_PORT;
  const host = d.cfg.api?.host ?? "0.0.0.0";
  /** 给任务子进程的回环地址；listen 后才知道真实端口 */
  let apiBase = "";

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    const method = req.method ?? "GET";

    const send = (code: number, obj: unknown) => {
      if (res.writableEnded) return;
      res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(obj));
    };
    const reply = (code: number, data: unknown) => send(code, { ok: true, data });
    const fail = (code: number, error: string) => send(code, { ok: false, error });

    res.on("finish", () => d.log.info(`api ${method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`));

    // 健康检查不需要 token（只回状态，不含业务数据）
    if (method === "GET" && (url.pathname === "/health" || url.pathname === "/v1/health")) {
      return reply(200, { status: "ok", exec: d.cfg.exec.shell.mode, time: Date.now() });
    }

    // 静态控制台也不鉴权：页面只是壳子，所有数据接口仍要 Bearer token
    if ((method === "GET" || method === "HEAD") && serveStatic(url.pathname, res, method)) return;
    if (method === "GET" && url.pathname === "/favicon.ico") {
      res.writeHead(204);
      return res.end();
    }

    const auth = String(req.headers.authorization ?? "");
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : String(req.headers["x-rabbit-bot-token"] ?? "");
    if (!safeEqual(bearer, d.token)) return fail(401, "token 不对");

    try {
      if (parts[0] !== "v1") throw new HttpError(404, "只支持 /v1/*");
      const body = ["POST", "PUT", "PATCH"].includes(method) ? await readBody(req) : {};

      switch (parts[1]) {
        case "pools": {
          if (parts.length === 2 && method === "GET") {
            const inc = url.searchParams.get("archived");
            return reply(200, listPools(d.store, {
              includeArchived: inc === "1" || inc === "true",
              mainPoolId: mainPoolId(d.cfg),
            }));
          }
          if (parts.length === 4 && parts[3] === "archive" && (method === "POST" || method === "PUT")) {
            const archived = body.archived === undefined ? true : !!body.archived;
            return reply(200, archivePool(d.store, parts[2], archived));
          }
          if (parts.length === 4 && parts[3] === "messages" && method === "GET") {
            return reply(200, readPool(d.store, parts[2], {
              limit: qInt(url.searchParams.get("limit")),
              beforeSeq: qInt(url.searchParams.get("before_seq")),
            }));
          }
          if (parts.length === 4 && parts[3] === "search" && method === "GET") {
            return reply(200, searchPool(
              d.store, url.searchParams.get("q") ?? "", parts[2], qInt(url.searchParams.get("limit")),
              (url.searchParams.get("only") as "self" | "other" | null) ?? undefined,
            ));
          }
          throw new HttpError(404, "用法：GET /v1/pools?archived=1、/v1/pools/:ref/messages、/v1/pools/:ref/search?q=、POST /v1/pools/:ref/archive");
        }
        case "llm-logs": {
          if (parts.length === 2 && method === "GET") {
            return reply(200, listLlmSessions(d.cfg, { limit: qInt(url.searchParams.get("limit")) }));
          }
          if (parts.length === 3 && method === "GET") {
            const log = readLlmSession(d.cfg, decodeURIComponent(parts[2]), {
              limit: qInt(url.searchParams.get("limit")),
              before: qInt(url.searchParams.get("before")),
            });
            if (!log) throw new HttpError(404, "没有这个会话日志");
            return reply(200, log);
          }
          throw new HttpError(404, "用法：GET /v1/llm-logs?limit=30、GET /v1/llm-logs/:id?limit=40&before=N");
        }
        case "llm": {
          if (parts.length === 3 && parts[2] === "models" && method === "GET") {
            const settings = effectiveModelSettings(d.cfg);
            let available: { provider: string; model: string; name: string }[] = [];
            let availableError: string | undefined;
            if (d.listModels) {
              try { available = await d.listModels(); }
              catch (e) { availableError = (e as Error).message; }
            }
            return reply(200, { ...settings, available, ...(availableError ? { available_error: availableError } : {}) });
          }
          if (parts.length === 3 && parts[2] === "models" && method === "PUT") {
            if (!Array.isArray(body.choices)) throw new HttpError(400, "choices 要是数组");
            if (body.choices.length > MAX_MODEL_CHOICES) {
              throw new HttpError(400, `最多只能配置 ${MAX_MODEL_CHOICES} 个模型`);
            }
            const choices = (body.choices as unknown[]).map(normalizeChoice);
            if (choices.some((x) => !x)) throw new HttpError(400, "每个模型都要有 provider 和 model");
            return reply(200, saveModelSettings(d.cfg, {
              choices: choices.filter((x): x is ModelChoice => !!x),
            }));
          }
          if (parts.length === 3 && parts[2] === "switch" && method === "POST") {
            if (!d.switchModel) throw new HttpError(400, "当前进程不支持切换模型");
            const provider = typeof body.provider === "string" ? body.provider.trim() : "";
            const model = typeof body.model === "string" ? body.model.trim() : "";
            if (!provider || !model) throw new HttpError(400, "缺少 provider / model");
            return reply(200, await d.switchModel(provider, model));
          }
          throw new HttpError(404, "用法：GET|PUT /v1/llm/models、POST /v1/llm/switch {provider, model}");
        }
        case "users": {
          if (parts.length === 2 && method === "GET") return reply(200, d.store.listUsers());
          if (parts.length === 3 && method === "PATCH") {
            const raw = typeof body.alias === "string" ? body.alias : body.display_name;
            const displayName = typeof raw === "string" ? raw.trim() : "";
            if (!displayName) throw new HttpError(400, "缺少 alias");
            const backfill = body.backfill === true || body.backfill === "1" || body.backfill === "true";
            const result = d.store.renameUser(decodeURIComponent(parts[2]), displayName, { backfill });
            if (!result) throw new HttpError(404, `用户不存在：${parts[2]}`);
            return reply(200, result);
          }
          throw new HttpError(404, "用法：GET /v1/users、PATCH /v1/users/:user_id {alias}");
        }
        case "projects": {
          if (parts.length === 2 && method === "GET") {
            return reply(200, listProjects(d.cfg));
          }
          if (parts.length === 3 && method === "GET") {
            const p = getProject(d.cfg, decodeURIComponent(parts[2]));
            if (!p) throw new HttpError(404, `没有项目 ${parts[2]}`);
            return reply(200, p);
          }
          if (parts.length === 3 && method === "PATCH") {
            try {
              return reply(200, updateProject(d.cfg, decodeURIComponent(parts[2]), {
                context: body.context,
                plan: body.plan,
              }));
            } catch (e) {
              const msg = (e as Error).message;
              throw new HttpError(/没有项目/.test(msg) ? 404 : 400, msg);
            }
          }
          throw new HttpError(404, "用法：GET /v1/projects、GET/PATCH /v1/projects/:slug");
        }
        case "plans": {
          const dir = boardDir(d.cfg);
          if (parts.length === 2 && method === "GET") {
            const want = String(url.searchParams.get("status") ?? "all").trim().toLowerCase();
            const status = want === "all" ? "all" : (BOARD_STATUSES.includes(want as BoardStatus) ? want as BoardStatus : "all");
            return reply(200, listBoards(dir, status).map(formatBoard));
          }
          if (parts.length === 2 && method === "POST") {
            const b = createBoard(dir, {
              title: body.title,
              background: body.background,
              goals: Array.isArray(body.goals) ? body.goals : undefined,
              pool: typeof body.pool === "string" ? body.pool : null,
              tags: Array.isArray(body.tags) ? body.tags : undefined,
            }, Date.now());
            return reply(201, formatBoard(b));
          }
          if (parts.length === 3 && method === "GET") {
            const b = getBoard(dir, decodeURIComponent(parts[2]));
            if (!b) throw new HttpError(404, `没有计划 ${parts[2]}`);
            return reply(200, formatBoard(b));
          }
          if (parts.length === 3 && method === "PATCH") {
            const slug = decodeURIComponent(parts[2]);
            const want = body.status === undefined ? undefined : String(body.status).trim().toLowerCase();
            if (want !== undefined && !BOARD_STATUSES.includes(want as BoardStatus)) {
              throw new HttpError(400, `status 只能是 ${BOARD_STATUSES.join(" / ")}`);
            }
            if (want === "archived") return reply(200, formatBoard(archiveBoard(dir, slug)));
            let b = getBoard(dir, slug);
            if (!b) throw new HttpError(404, `没有计划 ${slug}`);
            if (body.background !== undefined || want !== undefined || Array.isArray(body.tags)) {
              b = updateBoard(dir, slug, { background: body.background, status: want as BoardStatus | undefined, tags: Array.isArray(body.tags) ? body.tags : undefined });
            }
            if (Array.isArray(body.goal_add)) b = addGoals(dir, slug, body.goal_add.map((x: unknown) => String(x)));
            if (body.goal_check && typeof body.goal_check === "object") {
              const g = body.goal_check as { goal?: string | number; done?: boolean };
              b = checkGoal(dir, slug, g.goal ?? "", g.done !== false);
            }
            if (typeof body.progress === "string" && body.progress.trim()) b = addProgress(dir, slug, body.progress);
            return reply(200, formatBoard(b));
          }
          if (parts.length === 3 && method === "DELETE") {
            return reply(200, formatBoard(archiveBoard(dir, decodeURIComponent(parts[2]))));
          }
          throw new HttpError(404, "用法：GET/POST /v1/plans、GET/PATCH/DELETE /v1/plans/:id");
        }
        case "schedules": {
          const tz = d.cfg.timezone;
          if (parts.length === 2 && method === "GET") {
            const want = String(url.searchParams.get("status") ?? "all").trim().toLowerCase();
            const status = want === "all" ? undefined : (isScheduleStatus(want) ? want : null);
            if (status === null) throw new HttpError(400, "status 只能是 active / cancelled / done / all");
            return reply(200, d.store.listSchedules(status).map((s) => formatSchedule(s, tz)));
          }
          if (parts.length === 2 && method === "POST") {
            let created;
            try {
              created = createSchedule(d.store, body, Date.now(), tz);
            } catch (e) {
              throw new HttpError(400, (e as Error).message);
            }
            d.scheduler?.notifyScheduleChange?.();
            return reply(201, formatSchedule(created, tz));
          }
          const id = parts.length >= 3 ? Number(parts[2]) : NaN;
          if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "日程 id 要是正整数");
          if (parts.length === 3 && method === "GET") {
            const s = d.store.getSchedule(id);
            if (!s) throw new HttpError(404, `没有日程 #${id}`);
            return reply(200, formatSchedule(s, tz));
          }
          if (parts.length === 3 && (method === "PATCH" || method === "DELETE")) {
            const want = method === "DELETE"
              ? "cancelled"
              : String(body.status ?? "").trim().toLowerCase();
            if (!isScheduleStatus(want)) throw new HttpError(400, "status 只能是 active / cancelled / done");
            const s = d.store.setScheduleStatus(id, want, Date.now());
            if (!s) throw new HttpError(404, `没有日程 #${id}`);
            d.scheduler?.notifyScheduleChange?.();
            return reply(200, formatSchedule(s, tz));
          }
          throw new HttpError(404, "用法：GET|POST /v1/schedules、GET/PATCH/DELETE /v1/schedules/:id");
        }
        case "tasks": {
          if (parts.length === 2 && method === "GET") {
            const status = url.searchParams.get("status");
            if (status && !isTaskStatus(status)) {
              throw new HttpError(400, `status 只能是 ${TASK_STATUSES.join(" / ")}`);
            }
            return reply(200, listTaskViews(d.store, {
              status: status ? status as any : undefined,
              limit: qInt(url.searchParams.get("limit")),
            }));
          }
          if (parts.length === 2 && method === "POST") {
            if (body.name !== undefined && typeof body.name !== "string") throw new HttpError(400, "name 要是字符串");
            if (typeof body.goal !== "string" || !body.goal.trim()) throw new HttpError(400, "缺少 goal");
            const workDir = validateWorkDir(body.work_dir);
            const executor = validateExecutor(body.executor);
            const task = createTask(d.store, {
              userId: typeof body.user_id === "string" ? body.user_id : "",
              poolId: typeof body.pool_id === "string" ? body.pool_id : "",
              name: body.name,
              goal: body.goal,
              deliverable: typeof body.deliverable === "string" ? body.deliverable : undefined,
              constraints: typeof body.constraints === "string" ? body.constraints : undefined,
              acceptance: typeof body.acceptance === "string" ? body.acceptance : undefined,
              files: Array.isArray(body.files) || typeof body.files === "string" ? body.files : undefined,
              start_at: typeof body.start_at === "number" ? body.start_at : undefined,
              work_dir: workDir,
              executor,
              model: typeof body.model === "string" ? body.model : undefined,
              status: "pending_approval",
            });
            // dispatch=true 只作为测试/内部逃生口，Web 和 UFA 都不走这条路。
            if (body.dispatch !== true) {
              d.onTaskCreated?.(task);
              return reply(201, formatTask(task));
            }
            writeTaskDoc(d.store, task, { apiBase, sharedDir: sharedDir(d.cfg), businessDir: businessDir(d.cfg) });
            const started = await startTask(d.store, getTask(d.store, task.id)!, {
              apiBase, token: d.token, dataDir: d.cfg.dataDir, executorBin: d.executorBin,
              sharedDir: sharedDir(d.cfg), businessDir: businessDir(d.cfg),
            });
            return reply(201, formatTask(started.task));
          }
          if (parts.length === 3 && parts[2] === "stats" && method === "GET") {
            const now = Date.now();
            const from = qInt(url.searchParams.get("from")) ?? 0;
            const to = qInt(url.searchParams.get("to")) ?? now;
            if (!(to >= from)) throw new HttpError(400, "to 必须大于等于 from");
            return reply(200, taskStats(d.store, d.cfg.dataDir, { from, to }));
          }
          const id = Number(parts[2]);
          if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "任务 id 要是正整数");
          if (parts.length === 3 && method === "GET") {
            const view = getTaskView(d.store, id, { recentEvents: 5 });
            if (!view) throw new HttpError(404, `没有任务 #${id}`);
            return reply(200, view);
          }
          if (parts.length === 4 && parts[3] === "events" && method === "GET") {
            if (!getTask(d.store, id)) throw new HttpError(404, `没有任务 #${id}`);
            const messages = listTaskEvents(d.store, id, { limit: qInt(url.searchParams.get("limit")) });
            const task = getTask(d.store, id)!;
            return reply(200, { task_id: id, pool_id: task.task_pool_id, messages });
          }
          if (parts.length === 4 && parts[3] === "note" && method === "POST") {
            if (typeof body.line !== "string" || !body.line.trim()) throw new HttpError(400, "line 不能为空");
            if (!getTask(d.store, id)) throw new HttpError(404, `没有任务 #${id}`);
            return reply(200, formatTask(appendNote(d.store, id, body.line)));
          }
          if (parts.length === 4 && parts[3] === "approve" && method === "POST") {
            const task = getTask(d.store, id);
            if (!task) throw new HttpError(404, `没有任务 #${id}`);
            if (task.status !== "pending_approval") {
              throw new HttpError(409, `任务 #${id} 当前是 ${task.status}，只有 pending_approval 能审批通过`);
            }
            const patch: Parameters<typeof updateTask>[2] = {};
            const changed: string[] = [];
            const put = <K extends keyof typeof patch>(key: K, value: (typeof patch)[K]) => {
              if (value === undefined) return;
              patch[key] = value;
              if (value !== (task as any)[key]) changed.push(String(key));
            };
            const optString = (key: string): string | undefined => {
              if (body[key] === undefined) return undefined;
              if (typeof body[key] !== "string") throw new HttpError(400, `${key} 要是字符串`);
              return body[key];
            };

            if (body.name !== undefined) {
              if (typeof body.name !== "string" || !body.name.trim()) {
                throw new HttpError(400, "name 不能为空（短任务名，格式 #xxx）");
              }
              put("name", normalizeTaskName(body.name));
            }
            if (body.goal !== undefined) {
              if (typeof body.goal !== "string" || !body.goal.trim()) throw new HttpError(400, "goal 不能为空");
              put("goal", body.goal);
            }
            put("deliverable", optString("deliverable"));
            put("constraints", optString("constraints"));
            put("acceptance", optString("acceptance"));
            if (body.files !== undefined) {
              const files = normalizeFiles(body.files);
              if (files === undefined) throw new HttpError(400, "files 要是字符串或字符串数组");
              put("files", files);
            }
            if (body.work_dir !== undefined) put("work_dir", validateWorkDir(body.work_dir));
            if (body.executor !== undefined) put("executor", validateExecutor(body.executor));
            put("model", optString("model"));

            const updated = Object.keys(patch).length ? updateTask(d.store, id, patch) : task;
            writeTaskDoc(d.store, updated, { apiBase, sharedDir: sharedDir(d.cfg), businessDir: businessDir(d.cfg) });
            const by = typeof body.by === "string" && body.by.trim() ? body.by.trim() : "web";
            appendNote(d.store, id, changed.length
              ? `Web 审批通过（by=${by}；修改字段：${changed.join(", ")}）`
              : `Web 审批通过（by=${by}）`);

            try {
              const started = await startTask(d.store, getTask(d.store, id)!, {
                apiBase, token: d.token, dataDir: d.cfg.dataDir, executorBin: d.executorBin,
                sharedDir: sharedDir(d.cfg), businessDir: businessDir(d.cfg),
              });
              d.onTaskDecided?.(id);
              return reply(200, formatTask(started.task));
            } catch (e) {
              const message = (e as Error).message;
              const fresh = getTask(d.store, id);
              if (!fresh || !isRunnerAlive(fresh.runner_pid)) {
                updateTask(d.store, id, { status: "pending_approval", runner_pid: null, runner_started_at: null });
              }
              appendNote(d.store, id, `启动失败：${message}`);
              throw new HttpError(500, `任务 #${id} 启动失败：${message}`);
            }
          }
          if (parts.length === 4 && parts[3] === "reject" && method === "POST") {
            const task = getTask(d.store, id);
            if (!task) throw new HttpError(404, `没有任务 #${id}`);
            if (task.status !== "pending_approval") {
              throw new HttpError(409, `任务 #${id} 当前是 ${task.status}，只有 pending_approval 能驳回`);
            }
            const reason = typeof body.reason === "string" ? body.reason.trim() : "";
            const cancelled = updateTask(d.store, id, { status: "cancelled" });
            appendNote(d.store, id, reason ? `Web 驳回：${reason}` : "Web 驳回");
            d.onTaskDecided?.(id);
            return reply(200, formatTask(getTask(d.store, id) ?? cancelled));
          }
          if (parts.length === 4 && parts[3] === "start" && method === "POST") {
            const task = getTask(d.store, id);
            if (!task) throw new HttpError(404, `没有任务 #${id}`);
            if (task.status === "pending_approval") {
              throw new HttpError(409, `任务 #${id} 等待审批，必须走 /v1/tasks/${id}/approve，不能直接 start`);
            }
            if (!task.work_dir) throw new HttpError(400, `任务 #${id} 没有 work_dir，不能启动`);
            if (isRunnerAlive(task.runner_pid)) throw new HttpError(409, `任务 #${id} 已在运行`);
            writeTaskDoc(d.store, task, { apiBase, sharedDir: sharedDir(d.cfg), businessDir: businessDir(d.cfg) });
            const started = await startTask(d.store, getTask(d.store, id)!, {
              apiBase, token: d.token, dataDir: d.cfg.dataDir, executorBin: d.executorBin,
              sharedDir: sharedDir(d.cfg), businessDir: businessDir(d.cfg),
            });
            return reply(200, formatTask(started.task));
          }
          if (parts.length === 4 && parts[3] === "resume" && method === "POST") {
            const task = getTask(d.store, id);
            if (!task) throw new HttpError(404, `没有任务 #${id}`);
            if (!String(task.session_id ?? "").trim()) {
              throw new HttpError(409, `任务 #${id} 没有 session_id，不能恢复；请先 start 或重新创建`);
            }
            if (isRunnerAlive(task.runner_pid)) throw new HttpError(409, `任务 #${id} 已在运行`);
            const resumed = await resumeTask(d.store, task, {
              apiBase, token: d.token, dataDir: d.cfg.dataDir,
              sharedDir: sharedDir(d.cfg), businessDir: businessDir(d.cfg),
            });
            return reply(200, formatTask(resumed.task));
          }
          if (parts.length === 4 && parts[3] === "stop" && method === "POST") {
            const task = getTask(d.store, id);
            if (!task) throw new HttpError(404, `没有任务 #${id}`);
            return reply(200, formatTask(await stopTask(d.store, task, { dataDir: d.cfg.dataDir })));
          }
          if (parts.length === 4 && parts[3] === "cancel" && method === "POST") {
            const task = getTask(d.store, id);
            if (!task) throw new HttpError(404, `没有任务 #${id}`);
            if (isRunnerAlive(task.runner_pid)) await stopTask(d.store, task, { dataDir: d.cfg.dataDir });
            const resumed = cancelTask(d.store, id);
            d.onTaskDecided?.(id);
            return reply(200, formatTask(resumed));
          }
          if (parts.length === 4 && parts[3] === "status" && method === "POST") {
            if (!isTaskStatus(body.status)) throw new HttpError(400, `status 只能是 ${TASK_STATUSES.join(" / ")}`);
            if (!getTask(d.store, id)) throw new HttpError(404, `没有任务 #${id}`);
            const updated = updateTask(d.store, id, {
              status: body.status,
              result: typeof body.result === "string" ? body.result : undefined,
              artifact: typeof body.artifact === "string" ? body.artifact : undefined,
            });
            // 终态写一条任务事件，交给下一次任务事件 tick 批量带走；这里不立即 enqueue。
            if (body.status === "done" || body.status === "failed" || body.status === "blocked") {
              appendTaskEvent(d.store, id, {
                text: `任务状态：${body.status}`,
                sender: "dispatcher",
                senderName: "调度器",
              });
            }
            return reply(200, formatTask(updated));
          }
          if (parts.length === 4 && parts[3] === "touch" && method === "POST") {
            const workerId = bodyWorkerId(body);
            if (!getTask(d.store, id)) throw new HttpError(404, `没有任务 #${id}`);
            const task = touchTask(d.store, id, workerId);
            if (!task) throw new HttpError(400, `任务 #${id} 不在运行`);
            return reply(200, { lease_until: task.lease_until });
          }
          if (parts.length === 4 && parts[3] === "progress" && method === "POST") {
            const workerId = bodyWorkerId(body);
            if (typeof body.stage !== "string" || !body.stage.trim()) throw new HttpError(400, "缺少 stage");
            if (!getTask(d.store, id)) throw new HttpError(404, `没有任务 #${id}`);
            return reply(200, formatTask(progressTask(d.store, id, {
              workerId,
              stage: body.stage,
              note: typeof body.note === "string" ? body.note : undefined,
            })));
          }
          if (parts.length === 4 && parts[3] === "complete" && method === "POST") {
            const workerId = bodyWorkerId(body);
            if (!getTask(d.store, id)) throw new HttpError(404, `没有任务 #${id}`);
            return reply(200, formatTask(completeTask(d.store, id, {
              workerId,
              result: typeof body.result === "string" ? body.result : undefined,
              artifact: typeof body.artifact === "string" ? body.artifact : undefined,
              note: typeof body.note === "string" ? body.note : undefined,
            }, d.enqueue)));
          }
          if (parts.length === 4 && parts[3] === "fail" && method === "POST") {
            const workerId = bodyWorkerId(body);
            if (!getTask(d.store, id)) throw new HttpError(404, `没有任务 #${id}`);
            return reply(200, formatTask(failTask(d.store, id, {
              workerId,
              error: typeof body.error === "string" ? body.error : undefined,
              retryable: body.retryable === true,
            }, d.enqueue)));
          }
          if (parts.length === 4 && parts[3] === "snapshot" && method === "GET") {
            const task = getTask(d.store, id);
            if (!task) throw new HttpError(404, `没有任务 #${id}`);
            const recent = listTaskEvents(d.store, id, { limit: 5 });
            const fresh = getTask(d.store, id)!;
            return reply(200, {
              task: {
                id: task.id,
                name: taskDisplayName(task),
                goal: task.goal,
                pool_id: task.pool_id,
                task_pool_id: fresh.task_pool_id,
                status: task.status,
                stage: task.stage,
                note: task.note,
                result: task.result,
                artifact: task.artifact,
                work_dir: task.work_dir,
                executor: task.executor,
                model: task.model,
                session_id: task.session_id,
                runner_pid: task.runner_pid,
                runner_started_at: task.runner_started_at,
                doc_path: task.doc_path,
                worker_id: task.worker_id,
                claimed_at: task.claimed_at,
                lease_until: task.lease_until,
                attempt: task.attempt,
                exec_usage_at: task.exec_usage_at,
                exec_steps: task.exec_steps,
                exec_duration_ms: task.exec_duration_ms,
                exec_total_tokens: task.exec_total_tokens,
                exec_cost_usd: task.exec_cost_usd,
                updated_at: task.updated_at,
              },
              recent_events: recent,
            });
          }
          throw new HttpError(404, "用法：GET|POST /v1/tasks、GET /v1/tasks/:id、GET /v1/tasks/:id/events、POST /v1/tasks/:id/approve|reject|start|resume|stop|note|cancel|status|touch|progress|complete|fail、GET /v1/tasks/:id/snapshot");
        }
        case "approvals": {
          if (parts.length === 2 && method === "POST") {
            if (typeof body.action !== "string" || !body.action.trim()) throw new HttpError(400, "缺少 action");
            if (body.timeout_s !== undefined && (typeof body.timeout_s !== "number" || !Number.isFinite(body.timeout_s) || body.timeout_s <= 0)) {
              throw new HttpError(400, "timeout_s 要是正数");
            }
            return reply(201, createApproval(d.store, {
              taskId: body.task_id,
              workerId: typeof body.worker_id === "string" ? body.worker_id : undefined,
              action: body.action,
              detail: typeof body.detail === "string" ? body.detail : undefined,
              why: typeof body.why === "string" ? body.why : undefined,
              timeoutS: body.timeout_s,
            }, d.enqueue));
          }
          if (parts.length === 2 && method === "GET") {
            const status = url.searchParams.get("status");
            if (status && !isApprovalStatus(status)) {
              throw new HttpError(400, `status 只能是 ${APPROVAL_STATUSES.join(" / ")}`);
            }
            return reply(200, listApprovalViews(d.store, {
              status: status ? status as any : undefined,
              taskId: qInt(url.searchParams.get("task_id")),
              limit: qInt(url.searchParams.get("limit")),
            }));
          }
          const id = Number(parts[2]);
          if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "审批 id 要是正整数");
          if (parts.length === 3 && method === "GET") {
            const a = getApprovalView(d.store, id);
            if (!a) throw new HttpError(404, `没有审批 #${id}`);
            return reply(200, a);
          }
          if (parts.length === 4 && parts[3] === "decide" && method === "POST") {
            if (body.decision !== "approved" && body.decision !== "rejected") {
              throw new HttpError(400, 'decision 只能是 "approved" 或 "rejected"');
            }
            if (typeof body.by !== "string" || !body.by.trim()) throw new HttpError(400, "缺少 by");
            if (!getApproval(d.store, id)) throw new HttpError(404, `没有审批 #${id}`);
            return reply(200, decideApproval(d.store, id, {
              decision: body.decision,
              by: body.by,
            }, d.enqueue));
          }
          throw new HttpError(404, "用法：GET|POST /v1/approvals、GET /v1/approvals/:id、POST /v1/approvals/:id/decide");
        }
        case "usage": {
          const now = Date.now();
          if (parts.length === 3 && parts[2] === "calls" && method === "GET") {
            const from = qInt(url.searchParams.get("from")) ?? now - 24 * 3600e3;
            const to = qInt(url.searchParams.get("to")) ?? now;
            if (!(to > from)) throw new HttpError(400, "to 必须大于 from");
            const rawLimit = qInt(url.searchParams.get("limit")) ?? 200;
            const limit = Math.min(500, Math.max(1, Math.round(rawLimit)));
            return reply(200, { from, to, calls: usageCalls(d.store, from, to, limit, d.cfg.timezone) });
          }
          if (parts.length === 2 && method === "GET") {
            const rawBucket = url.searchParams.get("bucket");
            if (rawBucket !== null && rawBucket !== "hour" && rawBucket !== "day") {
              throw new HttpError(400, "bucket 只能是 hour 或 day");
            }
            const bucket = (rawBucket ?? "hour") as "hour" | "day";
            const from = qInt(url.searchParams.get("from")) ?? now - 24 * 3600e3;
            const to = qInt(url.searchParams.get("to")) ?? now;
            if (!(to > from)) throw new HttpError(400, "to 必须大于 from");
            if (to - from > 90 * 86400e3) throw new HttpError(400, "时间范围最大 90 天");
            return reply(200, {
              bucket, from, to,
              summary: usageSummary(d.store, from, to, d.cfg.timezone),
              series: usageSeries(d.store, from, to, bucket, d.cfg.timezone),
            });
          }
          throw new HttpError(404, "用法：GET /v1/usage?bucket=hour|day&from=&to=、GET /v1/usage/calls?from=&to=&limit=");
        }
        case "scheduler": {
          if (parts.length === 2 && method === "GET") return reply(200, effectiveSchedulerSettings(d.cfg));
          if (parts.length === 2 && method === "PUT") {
            let settings;
            try {
              settings = validateSchedulerSettings(body);
            } catch (e) {
              throw new HttpError(400, (e as Error).message);
            }
            // 先落盘再应用：写文件失败就整体不动，不出现「接口回了 200 但重启后丢」
            try {
              saveSchedulerSettings(d.cfg, settings);
            } catch (e) {
              throw new HttpError(500, `写入调度设置失败：${(e as Error).message}`);
            }
            applySchedulerSettings(d.cfg, settings);
            d.scheduler?.updateConfig({
              privateWakeMs: settings.privateWakeMs,
              tickMs: settings.groupWakeMs,
              taskTickMs: settings.taskWakeMs,
            });
            return reply(200, effectiveSchedulerSettings(d.cfg));
          }
          throw new HttpError(404, "用法：GET|PUT /v1/scheduler");
        }
        case "watchdog": {
          if (parts.length === 2 && method === "GET") return reply(200, effectiveWatchdogSettings(d.cfg));
          if (parts.length === 2 && method === "PUT") {
            let settings;
            try {
              settings = validateWatchdogSettings(body);
            } catch (e) {
              throw new HttpError(400, (e as Error).message);
            }
            try {
              saveWatchdogSettings(d.cfg, settings);
            } catch (e) {
              throw new HttpError(500, `写入看门狗设置失败：${(e as Error).message}`);
            }
            applyWatchdogSettings(d.cfg, settings);
            return reply(200, effectiveWatchdogSettings(d.cfg));
          }
          throw new HttpError(404, "用法：GET|PUT /v1/watchdog");
        }
        case "memory-review": {
          if (parts.length === 2 && method === "GET") return reply(200, effectiveMemoryReviewSettings(d.cfg));
          if (parts.length === 2 && method === "PUT") {
            let settings;
            try {
              settings = validateMemoryReviewSettings(body);
            } catch (e) {
              throw new HttpError(400, (e as Error).message);
            }
            try {
              saveMemoryReviewSettings(d.cfg, settings);
            } catch (e) {
              throw new HttpError(500, `写入记忆梳理设置失败：${(e as Error).message}`);
            }
            return reply(200, effectiveMemoryReviewSettings(d.cfg));
          }
          throw new HttpError(404, "用法：GET|PUT /v1/memory-review");
        }
        case "send-review": {
          if (parts.length === 2 && method === "GET") {
            return reply(200, { ...effectiveSendReviewSettings(d.cfg), ready: sendReviewReady(d.cfg) });
          }
          if (parts.length === 2 && method === "PUT") {
            let settings;
            try {
              settings = validateSendReviewSettings(body);
            } catch (e) {
              throw new HttpError(400, (e as Error).message);
            }
            // 主对话必须真实存在，避免写进一个永远收不到审批的池
            if (settings.primaryPoolId && !d.store.getPool(settings.primaryPoolId)) {
              throw new HttpError(400, `没有这个会话池：${settings.primaryPoolId}`);
            }
            // 没配审批去处时不允许打开：否则所有出站消息都会 fail-closed 被拦下。
            // 用这次要保存的设置算，而不是还没应用的旧 cfg，否则「刚指定主对话就打开」会被误拒。
            const resolved = resolveSendReviewConfig(d.cfg);
            const hasTarget = !!resolved.roomId || !!settings.primaryPoolId;
            if (settings.enabled && (!hasTarget || !(resolved.ownerIds ?? []).length)) {
              throw new HttpError(400, "审批去处没配好：先在 config/local.json 的 sendReview 或 approval 里配置 platform / roomId / ownerIds，或指定一个主对话池");
            }
            try {
              saveSendReviewSettings(d.cfg, settings);
            } catch (e) {
              throw new HttpError(500, `写入发送审核设置失败：${(e as Error).message}`);
            }
            applySendReviewSettings(d.cfg, settings);
            return reply(200, { ...effectiveSendReviewSettings(d.cfg), ready: sendReviewReady(d.cfg) });
          }
          throw new HttpError(404, "用法：GET|PUT /v1/send-review");
        }
        case "persona": {
          if (parts.length === 2 && method === "GET") return reply(200, readPersona(d.cfg));
          if (parts.length === 2 && method === "PUT") {
            if (typeof body.content !== "string") throw new HttpError(400, "缺少 content");
            const saved = writePersona(d.cfg, body.content);
            markFreshSession(d.cfg);
            return reply(200, saved);
          }
          throw new HttpError(404, "用法：GET|PUT /v1/persona {content}");
        }
        case "prompts": {
          if (parts.length === 2 && method === "GET") return reply(200, listPrompts(d.cfg));
          if (parts.length === 3 && method === "GET") return reply(200, readPrompt(d.cfg, parts[2]));
          if (parts.length === 3 && method === "PUT") {
            if (typeof body.content !== "string") throw new HttpError(400, "缺少 content");
            const saved = writePrompt(d.cfg, parts[2], body.content);
            markFreshSession(d.cfg);
            return reply(200, saved);
          }
          throw new HttpError(404, "用法：GET /v1/prompts、GET|PUT /v1/prompts/:name {content}");
        }
        case "memories": {
          if (parts.length === 2 && method === "GET") {
            const user = url.searchParams.get("user") ?? undefined;
            const global = url.searchParams.get("global");
            // 带 global=1（或干脆不给 user）走管理台全局列表；给 user 仍按原来「该用户在当前池可见」查。
            if (!user || global === "1" || global === "true") {
              const status = url.searchParams.get("status");
              return reply(200, listMemoriesGlobal(d.store, {
                user,
                kind: url.searchParams.get("kind") ?? undefined,
                scope: url.searchParams.get("scope") ?? undefined,
                status: status === "valid" || status === "expired" ? status : undefined,
                q: url.searchParams.get("q") ?? undefined,
                limit: qInt(url.searchParams.get("limit")),
                offset: qInt(url.searchParams.get("offset")),
              }));
            }
            const all = url.searchParams.get("all");
            return reply(200, searchMemories(d.store, {
              user,
              pool: url.searchParams.get("pool") ?? undefined,
              limit: qInt(url.searchParams.get("limit")),
              at: url.searchParams.get("at") ?? undefined,
              all: all === "1" || all === "true",
            }));
          }
          if (parts.length === 2 && method === "POST") {
            return reply(201, addMemory(d.store, {
              user: body.user, content: body.content, pool: body.pool, kind: body.kind, scope: body.scope,
              from: body.from, until: body.until, supersede: body.supersede,
            }));
          }
          if (parts.length === 3 && method === "PATCH") {
            // 只关掉，不写新的：事实过期但没有替代的说法时用这个
            return reply(200, closeMemory(d.store, { user: body.user, id: parts[2], at: body.at }));
          }
          if (parts.length === 3 && method === "PUT") {
            return reply(200, updateMemory(d.store, {
              user: body.user, id: parts[2], content: body.content, from: body.from,
            }));
          }
          if (parts.length === 3 && method === "DELETE") {
            return reply(200, deleteMemory(d.store, {
              user: body.user ?? url.searchParams.get("user") ?? undefined,
              id: parts[2],
            }));
          }
          if (parts.length === 4 && parts[3] === "trace" && method === "GET") {
            return reply(200, traceMemory(d.store, {
              user: url.searchParams.get("user") ?? undefined,
              id: parts[2],
              before: qInt(url.searchParams.get("before")),
              after: qInt(url.searchParams.get("after")),
            }));
          }
          throw new HttpError(404, "用法：GET /v1/memories?user=&pool=[&at=ISO][&all=1]、GET /v1/memories?global=1[&user=&kind=&scope=&status=&q=&limit=&offset=]、GET /v1/memories/:id/trace?user=、POST /v1/memories、PATCH /v1/memories/:id（关闭）、PUT /v1/memories/:id（改正文）、DELETE /v1/memories/:id?user=");
        }
        case "images": {
          if (parts.length === 2 && method === "GET") {
            return reply(200, listImages(d.store, d.cfg.dataDir, {
              source: url.searchParams.get("source") ?? undefined,
              page: qInt(url.searchParams.get("page")),
              size: qInt(url.searchParams.get("size")),
            }));
          }
          if (parts.length === 3 && parts[2] === "file" && method === "GET") {
            const abs = resolveImagePath(d.cfg.dataDir, url.searchParams.get("path") ?? "");
            const buf = fs.readFileSync(abs);
            res.writeHead(200, {
              "content-type": MIME[path.extname(abs).toLowerCase()] ?? "application/octet-stream",
              "content-length": buf.length,
              "cache-control": "private, max-age=60",
            });
            return res.end(buf);
          }
          throw new HttpError(404, "用法：GET /v1/images、GET /v1/images/file?path=media/x.jpg");
        }
        case "web": {
          if (parts.length === 3 && parts[2] === "search" && method === "GET") {
            return reply(200, await searchWeb(url.searchParams.get("q") ?? "", {
              count: qInt(url.searchParams.get("count")),
              content: qBool(url.searchParams.get("content")),
            }));
          }
          if (parts.length === 3 && parts[2] === "fetch" && method === "POST") {
            return reply(200, await fetchWeb(String(body.url ?? "")));
          }
          throw new HttpError(404, "用法：GET /v1/web/search?q=、POST /v1/web/fetch {url}");
        }
        case "skills": {
          if (parts.length === 2 && method === "GET") {
            return reply(200, listSkills(d.cfg).map((s) => ({
              name: s.name,
              description: s.description,
              skill: s.path,
              data: s.readonly ? null : `skills/${s.name}/data`,
              has_data: s.hasData,
              readonly: s.readonly,
            })));
          }
          throw new HttpError(404, "用法：GET /v1/skills");
        }
        case "executors": {
          if (parts.length === 2 && method === "GET") return reply(200, listExecutors());
          throw new HttpError(404, "用法：GET /v1/executors");
        }
        case "pm": {
          if (parts.length === 3 && parts[2] === "audit" && method === "GET") {
            const rows = d.store.db
              .prepare(
                `SELECT id, name, goal, acceptance, status, doc_path, result, artifact, note,
                        lease_until, created_at, updated_at, end_at
                   FROM tasks ORDER BY id DESC LIMIT 200`,
              )
              .all() as PmTaskRow[];
            const report = auditTasks(rows, { now: Date.now() });
            return reply(200, {
              headline: report.headline,
              red: report.red,
              yellow: report.yellow,
              findings: report.findings,
              tasks: rows.length,
              checked_at: new Date().toISOString(),
            });
          }
          throw new HttpError(404, "用法：GET /v1/pm/audit");
        }
        case "business": {
          if (parts.length === 2 && method === "GET") {
            let map;
            try {
              map = loadBusinessMap(d.store);
            } catch (e) {
              throw new HttpError(400, `业务地图读取失败：${(e as Error).message}`);
            }
            if (!map) {
              return reply(200, {
                exists: false, dir: businessDir(d.cfg), version: null,
                types: [], objects: [], relations: [], actions: [], terms: [], edges: [],
                edge_total: 0, edges_truncated: false,
              });
            }
            const relations = map.relations.map((r) => ({
              id: r.id, name: r.name, fromType: r.fromType, toType: r.toType,
              kind: r.kind, cardinality: r.cardinality, direction: r.direction,
              risk: r.risk, semantics: r.semantics,
              graph_id: r.graph_id, import_batch: r.import_batch,
              edge_count: relationEdges(map, r.id).length,
            }));
            const edges: { relation: string; relation_name: string; from: string; to: string; graph_id: string; import_batch: string; evidence: string | null }[] = [];
            let edgeTotal = 0;
            for (const r of map.relations) {
              const es = relationEdges(map, r.id);
              edgeTotal += es.length;
              for (const e of es) {
                if (edges.length >= MAX_BUSINESS_EDGES) continue;
                edges.push({
                  relation: r.id, relation_name: r.name, from: e.from, to: e.to,
                  graph_id: e.graph_id, import_batch: e.import_batch, evidence: e.evidence ?? null,
                });
              }
            }
            return reply(200, {
              exists: true, dir: map.dir || businessDir(d.cfg), version: map.version,
              types: map.types,
              objects: map.objects,
              relations,
              actions: map.actions,
              terms: map.terms,
              edges,
              edge_total: edgeTotal,
              edges_truncated: edgeTotal > edges.length,
            });
          }
          if (parts.length === 2 && method === "PUT") {
            try {
              return reply(200, replaceBusinessMap(d.store, body));
            } catch (e) {
              throw new HttpError(400, `业务地图写入失败：${(e as Error).message}`);
            }
          }
          if (parts.length === 3 && parts[2] === "lint" && method === "GET") {
            const report = lintBusinessMap(d.store);
            try { writeBusinessLintReport(d.cfg, report); } catch { /* 报告落盘失败不影响返回 */ }
            return reply(200, report);
          }
          throw new HttpError(404, "用法：GET|PUT /v1/business、GET /v1/business/lint（只读检查）");
        }
        case "outputs": {
          if (parts.length === 2 && method === "GET") {
            return reply(200, listOutputs(d.cfg, url.searchParams.get("path") ?? ""));
          }
          if (parts.length === 3 && parts[2] === "tree" && method === "GET") {
            return reply(200, listOutputTree(d.cfg));
          }
          if (parts.length === 3 && parts[2] === "file" && method === "GET") {
            return reply(200, readOutput(d.cfg, url.searchParams.get("path") ?? ""));
          }
          if (parts.length === 3 && parts[2] === "raw" && method === "GET") {
            const raw = readOutputRaw(d.cfg, url.searchParams.get("path") ?? "");
            res.writeHead(200, {
              "content-type": raw.mime,
              "content-length": raw.buffer.length,
              "cache-control": "private, max-age=60",
            });
            return res.end(raw.buffer);
          }
          throw new HttpError(404, "用法：GET /v1/outputs?path=、GET /v1/outputs/tree、GET /v1/outputs/file?path=、GET /v1/outputs/raw?path=");
        }
        case "working-memory": {
          if (parts.length === 2 && method === "GET") {
            return reply(200, readWorkingMemory(d.cfg));
          }
          throw new HttpError(404, "用法：GET /v1/working-memory");
        }
        case "sandbox": {
          // 只暴露文件区；`sb run` 不给 —— 技能脚本本来就在 shell 里
          if (parts.length === 3 && parts[2] === "files" && method === "GET") {
            return reply(200, listSandboxFiles(d.cfg, url.searchParams.get("path") ?? ""));
          }
          if (parts.length === 3 && parts[2] === "file" && method === "GET") {
            return reply(200, readSandboxFile(d.cfg, url.searchParams.get("path") ?? ""));
          }
          if (parts.length === 3 && parts[2] === "file" && method === "PUT") {
            return reply(200, writeSandboxFile(d.cfg, url.searchParams.get("path") ?? "", body.content));
          }
          throw new HttpError(404, "用法：GET /v1/sandbox/files?path=、GET|PUT /v1/sandbox/file?path=");
        }
        default:
          throw new HttpError(404, `没有这个接口：${url.pathname}`);
      }
    } catch (e) {
      const err = e as Error;
      const status = e instanceof HttpError ? e.status
        : e instanceof WorkerMismatchError || e instanceof ApprovalConflictError ? 409
        : 400;
      if (status >= 500) d.log.error(`api ${method} ${url.pathname} 失败`, e);
      return fail(status, err.message);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  apiBase = `http://127.0.0.1:${actualPort}`;
  d.log.info(`api: 监听 ${host}:${actualPort}（沙盒用 http://host.docker.internal:${actualPort}）`);
  if (host === "0.0.0.0") d.log.warn("api: 绑定 0.0.0.0，局域网可访问，全靠 Bearer token 挡着");
  return server;
}
