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
const fakeBin = path.join(dir, "fake-exec.mjs");
fs.writeFileSync(fakeBin, `#!/usr/bin/env node
import fs from "node:fs";
const out = process.env.FAKE_EXEC_OUT;
if (out) fs.writeFileSync(out, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));
console.log(JSON.stringify({ type: "step_start", sessionID: "ses_api_fake" }));
setTimeout(() => process.exit(0), 20);
`, "utf8");
fs.chmodSync(fakeBin, 0o755);
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
  server = await startApiServer({ cfg, store, log, token, executorBin: fakeBin });
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

test("POST /v1/tasks 默认 pending_approval：只登记，不写文档也不启动", async () => {
  const created = await post("/v1/tasks", {
    name: "整理资料", goal: "整理资料", work_dir: workDir, executor: "mimo", model: "provider/model-x",
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
  assert.equal(t.status, "pending_approval");

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

test("approve：可改描述、重写任务文档、留审批痕迹，随后以无审批参数启动", async () => {
  const created = await post("/v1/tasks", {
    name: "#旧名", goal: "旧目标", constraints: "旧约束", work_dir: workDir,
  });
  const id = created.body.data.id;
  const out = path.join(dir, `approve-${id}.json`);
  process.env.FAKE_EXEC_OUT = out;

  const approved = await post(`/v1/tasks/${id}/approve`, {
    name: "#新名", goal: "新目标", constraints: "新约束", acceptance: "新验收", by: "tester",
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const t = approved.body.data;
  assert.equal(t.id, id);
  assert.equal(t.name, "#新名");
  assert.equal(t.goal, "新目标");
  assert.equal(t.constraints, "新约束");
  assert.equal(t.acceptance, "新验收");
  assert.equal(t.status, "running");

  const fresh = getTask(store, id)!;
  assert.equal(fresh.doc_path, path.join(workDir, ".ufa", "tasks", `task-${id}.md`));
  const doc = fs.readFileSync(fresh.doc_path, "utf8");
  assert.match(doc, /新目标/);
  assert.match(doc, /新约束/);
  assert.match(doc, /新验收/);
  assert.equal(doc.includes("旧目标"), false);
  assert.match(fresh.note, /Web 审批通过（by=tester；修改字段：name, goal, constraints, acceptance）/);

  const argv: string[] = JSON.parse(fs.readFileSync(out, "utf8")).argv;
  assert.ok(argv.includes("--dangerously-skip-permissions"));
  const runnerLog = path.join(dir, "tasks", String(id), "runner.jsonl");
  assert.match(fs.readFileSync(runnerLog, "utf8"), /--dangerously-skip-permissions/);
});

test("reject：置 cancelled、写原因、不启动", async () => {
  const created = await post("/v1/tasks", { name: "#驳回", goal: "别跑", work_dir: workDir });
  const id = created.body.data.id;
  const out = path.join(dir, `reject-${id}.json`);
  process.env.FAKE_EXEC_OUT = out;

  const rejected = await post(`/v1/tasks/${id}/reject`, { reason: "描述不清楚", by: "tester" });
  assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
  assert.equal(rejected.body.data.status, "cancelled");
  const fresh = getTask(store, id)!;
  assert.equal(fresh.status, "cancelled");
  assert.match(fresh.note, /Web 驳回：描述不清楚/);
  assert.equal(fresh.runner_pid, null);
  assert.equal(fs.existsSync(out), false);
  assert.equal(fs.existsSync(path.join(dir, "tasks", String(id), "runner.jsonl")), false);
});

test("approve / reject / start：只有 pending_approval 能审批，start 不能绕过", async () => {
  const created = await post("/v1/tasks", { name: "#状态", goal: "状态测试", work_dir: workDir });
  const id = created.body.data.id;

  assert.equal((await post(`/v1/tasks/${id}/start`)).status, 409);
  assert.equal((await post(`/v1/tasks/${id}/reject`, { reason: "不做了" })).status, 200);
  assert.equal((await post(`/v1/tasks/${id}/approve`, { goal: "改主意了" })).status, 409);
  assert.equal((await post(`/v1/tasks/${id}/reject`, { reason: "再拒一次" })).status, 409);

  updateTask(store, id, { status: "done" });
  assert.equal((await post(`/v1/tasks/${id}/approve`, {})).status, 409);
  assert.equal((await post("/v1/tasks/999999/approve", {})).status, 404);
  assert.equal((await post("/v1/tasks/999999/reject", {})).status, 404);
});
