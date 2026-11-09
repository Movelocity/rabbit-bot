/**
 * WA worker 端到端测试：真进程、真 HTTP、真 SQLite，不连飞书、不调模型。
 *
 *   npx tsx scripts/e2e-wa.ts
 *
 * 库固定落在 app/.scratch/e2e-wa.db；API 用随机端口。
 * 场景：
 *   A 正常完成：worker 注册 → 领任务 → progress/touch → done
 *   B 权限申请：worker 建 pending 审批 → e2e 批准 → 任务 done
 *   C 合并 tick：连续完成 3 个任务，pending tick 只有一条，take 一次后为空
 */
import "../src/env-defaults.ts";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import type { AddressInfo } from "node:net";
import { APP_ROOT, loadConfig } from "../src/config.ts";
import { Store } from "../src/core/db.ts";
import { Hub } from "../src/core/hub.ts";
import { EmojiTable } from "../src/core/emoji.ts";
import { Logger } from "../src/core/logger.ts";
import { startApiServer } from "../src/api.ts";
import { PENDING_TASK_TICK_KEY, getTask, takePendingTick } from "../src/core/tasks.ts";

const scratchDir = path.join(APP_ROOT, ".scratch");
fs.mkdirSync(scratchDir, { recursive: true });
const dbFile = path.join(scratchDir, "e2e-wa.db");

const cfg = loadConfig({
  dataDir: scratchDir,
  logDir: path.join(scratchDir, "logs"),
  api: { enabled: true, port: 0, host: "127.0.0.1" },
  exec: { dir: path.join(scratchDir, "sandbox") },
});
const store = new Store(dbFile);
const log = new Logger(null, true);
// 只为了和正式进程一样复用同一套组装；e2e 不启动适配器，也不会有入站消息。
const hub = new Hub(store, cfg, log, EmojiTable.load(null));
void hub;

const token = `e2e-${process.pid}-${Date.now()}`;
const workerPath = path.join(APP_ROOT, "scripts", "wa-worker.ts");
const children = new Set<ChildProcess>();

let server: Awaited<ReturnType<typeof startApiServer>> = null;
let base = "";
let failed = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api<T = any>(p: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${base}${p}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { /* 非 JSON */ }
  if (!res.ok || !body?.ok) {
    throw new Error(`${init.method ?? "GET"} ${p} → ${res.status}：${body?.error ?? text.slice(0, 300)}`);
  }
  return body.data as T;
}

async function waitFor<T>(label: string, timeoutMs: number, fn: () => Promise<T | null | undefined>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: Error | null = null;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v !== null && v !== undefined) return v;
    } catch (e) {
      lastError = e as Error;
    }
    await sleep(100);
  }
  throw new Error(`${label} 超时（${timeoutMs}ms）${lastError ? `：${lastError.message}` : ""}`);
}

function startWorker(workerId: string, mode: "demo" | "opencode", extraEnv: Record<string, string> = {}) {
  const child = spawn(process.execPath, [
    "--import", "tsx",
    workerPath,
    "--api", base,
    "--token", token,
    "--worker-id", workerId,
    "--poll-ms", "100",
    "--mode", mode,
    "--dir", APP_ROOT,
  ], {
    cwd: APP_ROOT,
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  child.stdout.on("data", (d: Buffer) => process.stdout.write(`[${workerId}] ${d.toString("utf8")}`));
  child.stderr.on("data", (d: Buffer) => process.stderr.write(`[${workerId}:err] ${d.toString("utf8")}`));
  child.once("exit", () => children.delete(child));
  return child;
}

async function stopWorker(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  child.kill("SIGTERM");
  await Promise.race([exited, sleep(5000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([exited, sleep(2000)]);
  }
}

async function createTask(goal: string): Promise<number> {
  const t = await api<{ id: number }>("/v1/tasks", {
    method: "POST",
    body: JSON.stringify({ user_id: "u_e2e", pool_id: "e2e", goal, work_dir: APP_ROOT, dispatch: false }),
  });
  return t.id;
}

async function waitTask(id: number, status: string, timeoutMs = 30_000) {
  return waitFor(`任务 #${id} 变成 ${status}`, timeoutMs, async () => {
    const snap = await api<any>(`/v1/tasks/${id}/snapshot`);
    return snap.task.status === status ? snap : null;
  });
}

async function scenario(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}：${(e as Error).message}`);
  }
}

async function scenarioA(): Promise<void> {
  const workerId = `e2e-demo-${Date.now()}`;
  const worker = startWorker(workerId, "demo");
  try {
    const id = await createTask("等 3 秒后报告当前时间");
    const snap = await waitTask(id, "done");
    assert.match(snap.task.result, /demo done/, "result 要包含 demo done");
    assert.match(snap.task.result, /\d{2}:\d{2}:\d{2}|\d{4}-\d{2}-\d{2}T/, "result 要包含当前时间");
    assert.equal(snap.task.worker_id, workerId, "worker_id 要匹配领任务的 worker");
    assert.equal(snap.task.lease_until, null, "done 后 lease_until 必须清空");
    assert.ok(snap.worker && snap.worker.worker_id === workerId, "快照要带 worker 状态");
  } finally {
    await stopWorker(worker);
  }
}

async function scenarioB(): Promise<void> {
  const workerId = `e2e-approval-${Date.now()}`;
  const worker = startWorker(workerId, "demo", { WA_DEMO_APPROVAL: "1" });
  try {
    const id = await createTask("申请权限后 3 秒报告当前时间");
    const approval = await waitFor("审批出现 pending", 20_000, async () => {
      const list = await api<any[]>("/v1/approvals?status=pending");
      return list.find((a) => a.task_id === id) ?? null;
    });
    assert.equal(approval.status, "pending");
    assert.equal(approval.worker_id, workerId);
    assert.ok(approval.action.includes(`#${id}`), "action 要写清楚在申请什么");

    const listedAgain = await api<any[]>("/v1/approvals?status=pending");
    assert.ok(listedAgain.some((a) => a.id === approval.id), "GET /v1/approvals?status=pending 要能看到");

    const decided = await api<any>(`/v1/approvals/${approval.id}/decide`, {
      method: "POST",
      body: JSON.stringify({ decision: "approved", by: "e2e" }),
    });
    assert.equal(decided.status, "approved");

    const snap = await waitTask(id, "done");
    assert.match(snap.task.result, /demo done/);
    assert.equal(snap.task.worker_id, workerId);
    assert.equal(snap.task.lease_until, null);
  } finally {
    await stopWorker(worker);
  }
}

async function scenarioC(): Promise<void> {
  // 先清掉 A/B 留下的 tick，避免把旧标记算进来（走 core/tasks 自己的消费语义）。
  takePendingTick(store);

  const workerId = `e2e-merge-${Date.now()}`;
  const worker = startWorker(workerId, "demo");
  try {
    const ids: number[] = [];
    for (let i = 1; i <= 3; i++) ids.push(await createTask(`合并 tick 测试任务 ${i}`));
    for (const id of ids) await waitTask(id, "done", 40_000);

    const row = store.db.prepare("SELECT COUNT(*) AS c FROM kv WHERE k=?").get(PENDING_TASK_TICK_KEY) as { c: number };
    assert.equal(row.c, 1, "3 次完成只应有 1 条 pending tick");

    const setAt = takePendingTick(store);
    assert.equal(typeof setAt, "number", "takePendingTick 应返回 set_at");
    for (const id of ids) {
      const t = getTask(store, id)!;
      assert.equal(t.status, "done");
      assert.ok(t.updated_at >= setAt!, `任务 #${id} 的 updated_at 应 >= set_at`);
    }
    assert.equal(takePendingTick(store), null, "再取一次应为 null");
  } finally {
    await stopWorker(worker);
  }
}

async function main(): Promise<void> {
  // 历史库里的旧 tick 不影响本次断言；场景 C 会再清一次。
  takePendingTick(store);

  server = await startApiServer({ cfg, store, log, token });
  const addr = server!.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
  console.log(`e2e API: ${base}`);
  console.log(`e2e DB: ${dbFile}`);

  await scenario("A 正常完成（注册 / 领任务 / 快照 / 完成回传）", scenarioA);
  await scenario("B 权限申请（pending → approved → 任务完成）", scenarioB);
  await scenario("C pending tick 合并（3 个任务只置一次）", scenarioC);

  console.log(failed === 0 ? "ALL PASS" : `${failed} scenario(s) FAILED`);
  process.exitCode = failed === 0 ? 0 : 1;
}

async function cleanup(): Promise<void> {
  for (const child of [...children]) await stopWorker(child);
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  try { store.close(); } catch { /* 已经关过 */ }
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void cleanup().finally(() => process.exit(1));
  });
}

main()
  .catch((e) => {
    console.error(`e2e 启动失败：${(e as Error).stack ?? e}`);
    process.exitCode = 1;
  })
  .finally(cleanup);
