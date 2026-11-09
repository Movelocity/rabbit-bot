/**
 * 一次性进程派发 e2e：真 opencode、真 HTTP、真 SQLite，不连飞书。
 *
 *   npx tsx scripts/e2e-dispatch.ts
 *
 * 库和 runner 日志都落在 app/.scratch/e2e-dispatch/，工作目录 app/.scratch/e2e-work/，
 * 不碰真实 data/rabbit-bot.db。
 */
import "../src/env-defaults.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { APP_ROOT, loadConfig } from "../src/config.ts";
import { Store } from "../src/core/db.ts";
import { Logger } from "../src/core/logger.ts";
import { startApiServer } from "../src/api.ts";
import { getTask } from "../src/core/tasks.ts";

const scratch = path.join(APP_ROOT, ".scratch", "e2e-dispatch");
const workDir = path.join(APP_ROOT, ".scratch", "e2e-work");
fs.mkdirSync(scratch, { recursive: true });
fs.mkdirSync(workDir, { recursive: true });

const cfg = loadConfig({
  dataDir: scratch,
  logDir: path.join(scratch, "logs"),
  api: { enabled: true, port: 0, host: "127.0.0.1" },
  exec: { dir: path.join(scratch, "sandbox") },
});
const dbFile = path.join(scratch, "e2e-dispatch.db");
const store = new Store(dbFile);
const log = new Logger(null, true);
const token = `e2e-dispatch-${process.pid}-${Date.now()}`;

let server: Awaited<ReturnType<typeof startApiServer>> = null;
let base = "";

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

async function waitTask(id: number, predicate: (t: any) => boolean, timeoutMs: number): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let last: any = null;
  while (Date.now() < deadline) {
    last = await api<any>(`/v1/tasks/${id}/snapshot`);
    if (predicate(last.task)) return last;
    await sleep(1000);
  }
  throw new Error(`等待任务 #${id} 超时；最后状态：${JSON.stringify(last?.task ?? null)}`);
}

async function main(): Promise<void> {
  server = await startApiServer({ cfg, store, log, token });
  const addr = server!.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
  console.log(`e2e API: ${base}`);
  console.log(`e2e DB: ${dbFile}`);
  console.log(`e2e 工作目录: ${workDir}`);

  const goal = [
    "读你的任务文档（初始提示里给了路径）。",
    "先用 curl 调一次 progress API（stage=working），再用 curl 调 complete API，result 写 OK。",
    "只用任务文档和环境变量里的 RB_API_BASE / RB_API_TOKEN，不要把 token 打印出来。",
    "不要改工作目录之外的文件，不要编结果。",
  ].join("\n");

  const created = await api<any>("/v1/tasks", {
    method: "POST",
    body: JSON.stringify({
      user_id: "u_e2e",
      pool_id: "e2e",
      goal,
      work_dir: workDir,
      executor: "opencode",
      dispatch: true,
    }),
  });
  const id = created.id;
  console.log(`\n建任务 #${id}：executor=${created.executor} session=${created.session_id} pid=${created.runner_pid}`);
  console.log(`doc_path=${created.doc_path}`);
  assert.equal(created.status, "running", "dispatch 后任务应在 running");
  assert.ok(created.session_id, "3 秒内应抓到 session_id");
  assert.equal(typeof created.runner_pid, "number", "应记录 runner_pid");
  assert.equal(fs.existsSync(created.doc_path), true, "任务文档应存在");

  console.log("\n任务文档内容：");
  console.log(fs.readFileSync(created.doc_path, "utf8"));

  const done = await waitTask(id, (t) => t.status === "done" || t.status === "failed", 240_000);
  console.log(`\n首次执行结束：status=${done.task.status} result=${done.task.result}`);
  assert.equal(done.task.status, "done", "opencode 应调用 complete 把任务置 done");
  assert.match(done.task.result, /OK/, "result 应包含 OK");
  assert.equal(done.task.session_id, created.session_id, "session_id 第一次执行后不变");

  const events1 = await api<any>(`/v1/tasks/${id}/events?limit=100`);
  const text1 = events1.messages.map((m: any) => m.text).join("\n");
  console.log("\n任务池事件：");
  for (const m of events1.messages) console.log(`  [${m.local}] ${m.sender}: ${m.text}`);
  assert.match(text1, /已启动 opencode/, "任务池要有「已启动」事件");
  assert.match(text1, /阶段 working/, "任务池要有 progress 阶段事件");
  assert.match(text1, /任务完成/, "任务池要有完成事件");

  const runnerLog = path.join(scratch, "tasks", String(id), "runner.jsonl");
  const log1 = fs.readFileSync(runnerLog, "utf8");
  assert.equal(log1.includes(token), false, "runner 日志不能落明文 token");
  const parseLines = (text: string) => text.split("\n").filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter((x) => x?.type === "ufa-dispatch");
  const startLine = parseLines(log1).find((x) => x.action === "start");
  assert.ok(startLine, "runner 日志要记录 start");
  assert.equal(startLine.argv.includes("-s"), false, "首次启动不该带 -s");

  // 停掉（已退出，等于清理状态），再 resume 验证同一 session
  console.log("\n停止后 resume：");
  await api(`/v1/tasks/${id}/stop`, { method: "POST" });
  const resumed = await api<any>(`/v1/tasks/${id}/resume`, { method: "POST" });
  console.log(`resume 返回：status=${resumed.status} session=${resumed.session_id} pid=${resumed.runner_pid}`);
  assert.equal(resumed.session_id, created.session_id, "resume 必须沿用同一个 session id");
  assert.equal(typeof resumed.runner_pid, "number", "resume 应记录新的 runner_pid");

  const done2 = await waitTask(id, (t) => t.status === "done" || t.status === "failed", 240_000);
  console.log(`resume 执行结束：status=${done2.task.status} result=${done2.task.result}`);
  assert.equal(done2.task.status, "done", "resume 后仍应能完成");
  assert.match(done2.task.result, /OK/);

  const log2 = fs.readFileSync(runnerLog, "utf8");
  const resumeLine = parseLines(log2).find((x) => x.action === "resume");
  assert.ok(resumeLine, "找不到 resume 的命令记录");
  assert.ok(resumeLine.argv.includes("-s"), "resume 命令必须带 -s");
  assert.equal(resumeLine.argv[resumeLine.argv.indexOf("-s") + 1], created.session_id, "-s 后应跟原 session id");

  const events2 = await api<any>(`/v1/tasks/${id}/events?limit=100`);
  const text2 = events2.messages.map((m: any) => m.text).join("\n");
  assert.match(text2, /恢复执行/, "任务池要有恢复执行事件");

  console.log("\nALL PASS：一次性进程 + session 抓取 + resume(-s) 都验证通过");
}

async function cleanup(): Promise<void> {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  try { store.close(); } catch { /* 已经关过 */ }
}

main()
  .catch((e) => {
    console.error(`e2e 失败：${(e as Error).stack ?? e}`);
    process.exitCode = 1;
  })
  .finally(cleanup);
