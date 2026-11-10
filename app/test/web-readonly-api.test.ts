/** Web 管理台的 API 契约：只读视图字段 + 静态页可登录。 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { APP_ROOT, loadConfig } from "../src/config.ts";
import { Store } from "../src/core/db.ts";
import { Logger } from "../src/core/logger.ts";
import { startApiServer } from "../src/api.ts";
import { createTask, updateTask } from "../src/core/tasks.ts";
import { registerWorker } from "../src/core/workers.ts";
import { createApproval } from "../src/core/approvals.ts";

const dir = path.join(APP_ROOT, ".scratch", "web-readonly-api");
fs.mkdirSync(dir, { recursive: true });
const cfg = loadConfig({
  dataDir: dir,
  logDir: path.join(dir, "logs"),
  api: { enabled: true, port: 0, host: "127.0.0.1" },
  runtimeDir: path.join(dir, "runtime"),
  exec: { dir: path.join(dir, "sandbox") },
});
const store = new Store(":memory:");
const log = new Logger(null, true);
const token = "r".repeat(32);

let server: Awaited<ReturnType<typeof startApiServer>> = null;
let base = "";
let taskId = 0;

test.before(async () => {
  const task = createTask(store, {
    userId: "u1",
    poolId: "p1",
    name: "#看板",
    goal: "只读看板任务",
    deliverable: "report.md",
    constraints: "只读，不写库",
    acceptance: "页面能看到",
    stage: "review",
  });
  taskId = task.id;
  registerWorker(store, { workerId: "wa-1", name: "本地 WA", kind: "wa" });
  updateTask(store, taskId, { status: "running", worker_id: "wa-1" });
  createApproval(store, {
    taskId,
    workerId: "wa-1",
    action: "shell: ls",
    detail: "/work",
    why: "检查文件",
  });

  server = await startApiServer({ cfg, store, log, token });
  const addr = server!.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

test.after(() => {
  server?.close();
  store.close();
});

const call = async (p: string, auth = true) => {
  const headers: Record<string, string> = {};
  if (auth) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${p}`, { headers });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
};

test("静态页 200：管理台可打开，审批仍提示去飞书", async () => {
  const page = await fetch(`${base}/`);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  assert.match(html, /Rabbit Bot 管理台/);
  assert.match(html, /审批请在飞书里完成/);

  const bundles = [...html.matchAll(/src="\/ui\/(assets\/[^"]+\.js)"/g)].map((m) => m[1]);
  assert.ok(bundles.length > 0, "index.html 应引用打包后的 JS");
  const js = bundles
    .map((rel) => fs.readFileSync(path.join(APP_ROOT, "web", rel), "utf8"))
    .join("\n");
  assert.match(js, /\/v1\/persona/);
  assert.match(js, /\/v1\/memories\//);
  assert.match(js, /DELETE/);
  assert.match(js, /审批请在飞书里完成/);
});

test("任务 / 快照 / worker / 审批：带 token 200，无 token 401", async () => {
  const routes = [
    "/v1/tasks",
    `/v1/tasks/${taskId}/snapshot`,
    "/v1/workers",
    "/v1/approvals?status=pending",
  ];
  for (const route of routes) {
    const ok = await call(route, true);
    assert.equal(ok.status, 200, route);
    assert.equal(ok.body.ok, true, route);
    assert.equal((await call(route, false)).status, 401, route);
  }
});

test("只读视图需要的字段齐全", async () => {
  const tasks = await call("/v1/tasks", true);
  const task = tasks.body.data.find((t: any) => t.id === taskId);
  assert.ok(task);
  for (const key of ["id", "goal", "status", "stage", "worker_id", "constraints", "updated_at_local", "start_at_local"]) {
    assert.ok(key in task, `任务缺字段 ${key}`);
  }
  assert.equal(task.constraints, "只读，不写库");

  const snap = await call(`/v1/tasks/${taskId}/snapshot`, true);
  assert.equal(snap.body.data.task.id, taskId);
  assert.equal(snap.body.data.worker.worker_id, "wa-1");

  const workers = await call("/v1/workers", true);
  const worker = workers.body.data.find((w: any) => w.worker_id === "wa-1");
  assert.ok(worker);
  for (const key of ["worker_id", "name", "kind", "status", "last_seen_at"]) {
    assert.ok(key in worker, `worker 缺字段 ${key}`);
  }

  const approvals = await call("/v1/approvals?status=pending", true);
  const approval = approvals.body.data.find((a: any) => a.task_id === taskId);
  assert.ok(approval);
  for (const key of ["id", "task_id", "worker_id", "action", "why", "created_at_local", "expires_at_local"]) {
    assert.ok(key in approval, `审批缺字段 ${key}`);
  }
});
