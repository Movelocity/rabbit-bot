/**
 * 真实 WA worker：注册 → 领任务 → 跑任务 → 回传完成/失败。
 *
 *   npx tsx scripts/wa-worker.ts \
 *     --api http://127.0.0.1:3738 --token <token> \
 *     --worker-id wa-local --poll-ms 2000 --mode demo --dir /abs/path
 *
 * 三种模式：
 *   demo      —— sleep 3s，把当前时间写成 result，不调模型；
 *   opencode  —— 把任务四段拼成提示词，跑 `opencode run ... --format json`；
 *   mimo      —— 跑本机 mimo，参数见 `--mimo-bin` / `--model` / `--mimo-extra`。
 * 两种执行器都从 JSONL 事件里拼 `type=text` 的 `part.text` 作为 result。
 *
 * 权限：env WA_DEMO_APPROVAL=1 时，在干活前申请一条审批并每 2s 轮询；
 * 只有 approved 才继续，rejected / timeout / 到 expires_at 都按失败回传。
 *
 * SIGINT/SIGTERM 只停止 claim，不删任何数据；正在跑的任务会做完再退出。
 */
import { spawn } from "node:child_process";

interface Task {
  id: number;
  goal: string;
  deliverable: string;
  constraints: string;
  acceptance: string;
  status: string;
}

interface Approval {
  id: number;
  status: "pending" | "approved" | "rejected" | "timeout";
  expires_at: number;
}

type Mode = "demo" | "opencode" | "mimo";
type Executor = "opencode" | "mimo";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
  const pref = `${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pref));
  return hit ? hit.slice(pref.length) : undefined;
}

/** 可重复透传参数：值可以以 -- 开头（如 --mimo-extra --yolo）。 */
function collect(name: string): string[] {
  const out: string[] = [];
  const pref = `${name}=`;
  for (let i = 0; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === name) {
      if (process.argv[i + 1] !== undefined) { out.push(process.argv[i + 1]); i++; }
    } else if (a.startsWith(pref)) {
      out.push(a.slice(pref.length));
    }
  }
  return out;
}

const apiBase = (arg("--api") ?? "http://127.0.0.1:3738").replace(/\/+$/, "");
const token = arg("--token") ?? process.env.RB_API_TOKEN ?? "";
const workerId = arg("--worker-id") ?? "";
const pollMs = Math.max(50, Number(arg("--poll-ms") ?? 2000) || 2000);
const rawMode = arg("--mode") ?? "demo";
const mode: Mode = rawMode === "opencode" ? "opencode" : rawMode === "mimo" ? "mimo" : "demo";
const workDir = arg("--dir") ?? process.cwd();
const opencodeBin = arg("--opencode-bin") ?? "opencode";
const mimoBin = arg("--mimo-bin") ?? "/Users/viking/.mimocode/bin/mimo";
const model = arg("--model");
const timeoutMs = Math.max(1000, Number(arg("--timeout-ms") ?? 600000) || 600000);
const mimoExtra = collect("--mimo-extra");

if (!token) {
  console.error("缺少 --token（或 RB_API_TOKEN）");
  process.exit(2);
}
if (!workerId) {
  console.error("缺少 --worker-id");
  process.exit(2);
}
if (rawMode !== "demo" && rawMode !== "opencode" && rawMode !== "mimo") {
  console.error(`--mode 只能是 demo / opencode / mimo，收到 ${rawMode}`);
  process.exit(2);
}

let stopping = false;
const log = (msg: string) => console.log(`[wa ${workerId}] ${msg}`);

function request<T>(method: string, p: string, body?: unknown): Promise<T> {
  return fetch(`${apiBase}${p}`, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (res) => {
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON 走下面统一报错 */ }
    if (!res.ok || !json?.ok) {
      throw new Error(`${method} ${p} → ${res.status}：${json?.error ?? text.slice(0, 300)}`);
    }
    return json.data as T;
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 可被 SIGINT/SIGTERM 唤醒的等待；只在空转 claim 时用。 */
async function nap(ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!stopping && Date.now() < end) {
    await sleep(Math.min(200, Math.max(1, end - Date.now())));
  }
}

function localTime(d = new Date()): string {
  return d.toLocaleTimeString("zh-CN", { hour12: false });
}

function buildPrompt(task: Task): string {
  const lines = [
    "你是 WA worker，正在执行一条任务。请直接完成任务，只输出最终结果，不要修改与任务无关的文件。",
    `目标：${task.goal}`,
  ];
  if (task.deliverable.trim()) lines.push(`交付物：${task.deliverable}`);
  if (task.constraints.trim()) lines.push(`约束：${task.constraints}`);
  if (task.acceptance.trim()) lines.push(`验收标准：${task.acceptance}`);
  return lines.join("\n");
}

/** 从 `run --format json` 的 JSONL 事件流里拼接所有 `type=text` 的 part.text。 */
function extractFinalText(stdout: string): string {
  const parts: string[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let ev: any;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev?.type === "text" && ev?.part?.type === "text" && typeof ev.part.text === "string") {
      parts.push(ev.part.text);
    }
  }
  return parts.join("\n").trim();
}

function runExternal(executor: Executor, task: Task): Promise<string> {
  const prompt = buildPrompt(task);
  const bin = executor === "opencode" ? opencodeBin : mimoBin;
  const args = executor === "opencode"
    ? ["run", prompt, "--dir", workDir, "--format", "json", ...(model ? ["-m", model] : [])]
    : [
        "run", prompt, "--dir", workDir, "--title", `WA-task-${task.id}`, "--format", "json",
        ...(model ? ["--model", model] : []),
        ...mimoExtra,
      ];

  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const extra = executor === "mimo" && mimoExtra.length ? `, extra=${mimoExtra.join(" ")}` : "";
    log(`调用 ${executor}（bin=${bin}, model=${model ?? "默认"}, dir=${workDir}, timeout=${timeoutMs}ms${extra}）`);

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, {
        cwd: workDir,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      reject(new Error(`启动 ${executor} 失败（${bin}）：${(e as Error).message}`));
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (err?: Error, text?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      if (err) {
        log(`${executor} 失败，耗时 ${elapsed}s：${err.message}`);
        reject(err);
      } else {
        log(`${executor} 成功，耗时 ${elapsed}s，结果 ${text!.length} 字符`);
        resolve(text!);
      }
    };

    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 5000).unref?.();
      finish(new Error(`${executor} 超时（${timeoutMs}ms），已杀掉子进程`));
    }, timeoutMs);

    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
    child.on("error", (e) => finish(new Error(`启动 ${executor} 失败（${bin}）：${e.message}`)));
    child.on("close", (code) => {
      if (timedOut) return;
      if (code !== 0) {
        const tail = (stderr || stdout).trim().slice(-2000);
        finish(new Error(`${executor} 退出码 ${code}：${tail || "无输出"}`));
        return;
      }
      const text = extractFinalText(stdout);
      if (!text) finish(new Error(`${executor} 没有返回文本（stdout ${stdout.length} 字节）`));
      else finish(undefined, text);
    });
  });
}

async function waitForApproval(task: Task): Promise<void> {
  const created = await request<Approval>("POST", "/v1/approvals", {
    task_id: task.id,
    worker_id: workerId,
    action: `执行任务 #${task.id}：${task.goal.slice(0, 120)}`,
    detail: `mode=${mode} dir=${workDir}`,
    why: "WA_DEMO_APPROVAL=1 模拟权限申请",
    timeout_s: 120,
  });
  log(`审批 #${created.id} 已申请，等待裁决`);
  try {
    await request("POST", `/v1/tasks/${task.id}/progress`, {
      worker_id: workerId,
      stage: "waiting_approval",
      note: `等待审批 #${created.id}`,
    });
  } catch (e) {
    log(`写等待审批进度失败（继续等）：${(e as Error).message}`);
  }

  const deadline = created.expires_at;
  while (true) {
    if (Date.now() >= deadline) throw new Error(`审批 #${created.id} 等待超时（expires_at=${new Date(deadline).toISOString()}）`);
    await sleep(2000);
    const a = await request<Approval>("GET", `/v1/approvals/${created.id}`);
    if (a.status === "approved") {
      log(`审批 #${created.id} 已批准，继续执行`);
      return;
    }
    if (a.status === "rejected" || a.status === "timeout") {
      throw new Error(`审批 #${created.id} 被 ${a.status}，按失败处理`);
    }
  }
}

async function processTask(task: Task): Promise<void> {
  const id = task.id;
  const startedAt = Date.now();
  log(`领到任务 #${id}：${task.goal.slice(0, 80)}`);
  const touchMs = mode === "demo" ? 5000 : 30_000;
  let touchTimer: ReturnType<typeof setInterval> | null = null;
  try {
    await request("POST", `/v1/tasks/${id}/progress`, {
      worker_id: workerId,
      stage: "working",
      note: `worker ${workerId} 开始执行（${mode}）`,
    });
    touchTimer = setInterval(() => {
      request("POST", `/v1/tasks/${id}/touch`, { worker_id: workerId })
        .catch((e) => log(`任务 #${id} 续租失败：${(e as Error).message}`));
    }, touchMs);

    if (process.env.WA_DEMO_APPROVAL === "1") await waitForApproval(task);

    let result: string;
    if (mode === "demo") {
      await sleep(3000);
      const now = new Date();
      result = `${now.toISOString()} / ${localTime(now)} demo done`;
      log(`demo 完成，耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
    } else {
      result = await runExternal(mode, task);
    }

    await request("POST", `/v1/tasks/${id}/complete`, {
      worker_id: workerId,
      result,
      note: `worker ${workerId} 完成（${mode}）`,
    });
    log(`任务 #${id} 已回传完成（${mode}，总耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s）`);
  } catch (e) {
    const msg = (e as Error).message;
    log(`任务 #${id} 失败（${mode}，总耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s）：${msg}`);
    try {
      await request("POST", `/v1/tasks/${id}/fail`, {
        worker_id: workerId,
        error: msg,
        retryable: false,
      });
      log(`任务 #${id} 已回传失败`);
    } catch (e2) {
      log(`任务 #${id} 回传失败也失败了：${(e2 as Error).message}`);
    }
  } finally {
    if (touchTimer) clearInterval(touchTimer);
  }
}

function stop(signal: string): void {
  if (stopping) return;
  stopping = true;
  log(`收到 ${signal}，停止 claim（不删任何数据）；当前任务会做完再退出`);
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

async function main(): Promise<void> {
  await request("POST", "/v1/workers/register", {
    worker_id: workerId,
    name: `WA worker ${workerId}`,
    kind: "wa",
  });
  const executor = mode === "opencode" ? `bin=${opencodeBin}` : mode === "mimo" ? `bin=${mimoBin}` : "executor=none";
  log(`已注册到 ${apiBase}，mode=${mode} ${executor} model=${model ?? "默认"} poll=${pollMs}ms timeout=${timeoutMs}ms`);

  while (!stopping) {
    let task: Task | null = null;
    try {
      const got = await request<{ task: Task | null }>("POST", `/v1/workers/${encodeURIComponent(workerId)}/claim`);
      task = got.task;
    } catch (e) {
      log(`claim 失败：${(e as Error).message}`);
      await nap(pollMs);
      continue;
    }
    if (!task) {
      await nap(pollMs);
      continue;
    }
    await processTask(task);
  }
  log("已退出");
}

main().catch((e) => {
  console.error(`[wa ${workerId}] 启动失败：${(e as Error).message}`);
  process.exit(1);
});
