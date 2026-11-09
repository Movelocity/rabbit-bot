/** 任务派发 API 契约：work_dir 校验、start/resume/stop 的 404/409、快照字段。 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { APP_ROOT, loadConfig } from "../src/config.ts";
import { Store } from "../src/core/db.ts";
import { Logger } from "../src/core/logger.ts";
import { startApiServer } from "../src/api.ts";
import { getTask, updateTask } from "../src/core/tasks.ts";

const dir = path.join(APP_ROOT, ".scratch", "dispatch-api");
const workDir = path.join(dir, "work");
fs.mkdirSync(workDir, { recursive: true });
const cfg = loadConfig({
  dataDir: dir,
  logDir: path.join(dir, "logs"),
  api: { enabled: true, port: 0, host: "127.0.0.1" },
  exec: { dir: path.join(dir, "sandbox") },
});
const store = new Store(":memory:");
const log = new Logger(null, true);
const token = "d".repeat(32);

let server: Awaited<ReturnType<typeof startApiServer>> = null;
let base = "";

test.before(async () => {
  server = await startApiServer({ cfg, store, log, token });
  const addr = server!.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

test.after(() => {
  server?.close();
  store.close();
});

const call = async (p: string, init: RequestInit & { auth?: string | null } = {}) => {
  const { auth, ...rest } = init;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth !== null) headers.authorization = auth ?? `Bearer ${token}`;
  const res = await fetch(`${base}${p}`, { ...rest, headers: { ...headers, ...(rest.headers as any) } });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
};
const post = (p: string, data: unknown = {}) => call(p, { method: "POST", body: JSON.stringify(data) });

test("POST /v1/tasks：name 缺失 / work_dir 缺失 / 相对 / 不存在 / executor 非法都 400", async () => {
  assert.equal((await post("/v1/tasks", { name: "#干活", goal: "干活" })).status, 400);
  assert.equal((await post("/v1/tasks", { goal: "干活", work_dir: workDir })).status, 400);
  assert.equal((await post("/v1/tasks", { name: "  ", goal: "干活", work_dir: workDir })).status, 400);
  assert.equal((await post("/v1/tasks", { name: "#干活", goal: "干活", work_dir: "relative/dir" })).status, 400);
  assert.equal((await post("/v1/tasks", { name: "#干活", goal: "干活", work_dir: path.join(dir, "nope") })).status, 400);
  assert.equal((await post("/v1/tasks", { name: "#干活", goal: "干活", work_dir: workDir, executor: "other" })).status, 400);
});

test("POST /v1/tasks dispatch=false：只登记，字段可读", async () => {
  const created = await post("/v1/tasks", {
    name: "整理资料", goal: "整理资料", work_dir: workDir, executor: "mimo", model: "provider/model-x", dispatch: false,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const t = created.body.data;
  assert.equal(t.name, "#整理资料");
  assert.equal(t.work_dir, workDir);
  assert.equal(t.executor, "mimo");
  assert.equal(t.model, "provider/model-x");
  assert.equal(t.session_id, "");
  assert.equal(t.runner_pid, null);
  assert.equal(t.doc_path, "");
  assert.equal(t.status, "pending");

  const got = await call(`/v1/tasks/${t.id}`);
  assert.equal(got.status, 200);
  assert.equal(got.body.data.work_dir, workDir);
  assert.equal(got.body.data.executor, "mimo");

  const snap = await call(`/v1/tasks/${t.id}/snapshot`);
  assert.equal(snap.status, 200);
  for (const key of ["name", "work_dir", "executor", "model", "session_id", "runner_pid", "doc_path"]) {
    assert.ok(key in snap.body.data.task, `snapshot 缺 ${key}`);
  }
});

test("start / resume / stop：不存在 404；无 session 或已在跑 409", async () => {
  assert.equal((await post("/v1/tasks/999999/start")).status, 404);
  assert.equal((await post("/v1/tasks/999999/resume")).status, 404);
  assert.equal((await post("/v1/tasks/999999/stop")).status, 404);

  const created = await post("/v1/tasks", { name: "#恢复", goal: "恢复测试", work_dir: workDir, dispatch: false });
  const id = created.body.data.id;

  // 没有 session_id 不能 resume
  assert.equal((await post(`/v1/tasks/${id}/resume`)).status, 409);

  // runner 还活着时 start / resume 都拒绝，避免起两个进程
  updateTask(store, id, { status: "running", session_id: "ses_alive", runner_pid: process.pid });
  assert.equal((await post(`/v1/tasks/${id}/start`)).status, 409);
  assert.equal((await post(`/v1/tasks/${id}/resume`)).status, 409);

  // stop 清理 runner 状态（不会杀测试进程之外的 pid）
  updateTask(store, id, { runner_pid: null });
  const stopped = await post(`/v1/tasks/${id}/stop`);
  assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
  assert.equal(stopped.body.data.runner_pid, null);
  assert.equal(stopped.body.data.status, "pending");
  assert.equal(getTask(store, id)?.runner_pid, null);
});
