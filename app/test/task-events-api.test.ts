/** 任务池事件 API：200 / 404 / 401，以及详情/快照里的 task_pool_id + recent_events。 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { APP_ROOT, loadConfig } from "../src/config.ts";
import { Store } from "../src/core/db.ts";
import { Logger } from "../src/core/logger.ts";
import { startApiServer } from "../src/api.ts";
import { updateTask } from "../src/core/tasks.ts";

const dir = path.join(APP_ROOT, ".scratch", "task-events-api");
fs.mkdirSync(dir, { recursive: true });
const cfg = loadConfig({
  dataDir: dir,
  logDir: path.join(dir, "logs"),
  api: { enabled: true, port: 0, host: "127.0.0.1" },
  exec: { dir: path.join(dir, "sandbox") },
});
const store = new Store(":memory:");
const log = new Logger(null, true);
const token = "e".repeat(32);

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

test("GET /v1/tasks/:id/events：401 / 404 / 200", async () => {
  assert.equal((await call("/v1/tasks/1/events", { auth: null })).status, 401);
  assert.equal((await call("/v1/tasks/999999/events")).status, 404);

  const created = await post("/v1/tasks", { name: "#时间线", goal: "看事件时间线", work_dir: dir });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.data.id;
  assert.ok(created.body.data.task_pool_id);
  const queued = await post(`/v1/tasks/${id}/status`, { status: "pending" });
  assert.equal(queued.status, 200, JSON.stringify(queued.body));

  updateTask(store, id, { status: "running", worker_id: "opencode-1" });
  await post(`/v1/tasks/${id}/progress`, { worker_id: "opencode-1", stage: "review", note: "检查中" });
  await post(`/v1/tasks/${id}/complete`, { worker_id: "opencode-1", result: "好了", artifact: "out.md" });

  const events = await call(`/v1/tasks/${id}/events?limit=10`);
  assert.equal(events.status, 200, JSON.stringify(events.body));
  assert.equal(events.body.data.task_id, id);
  assert.equal(events.body.data.pool_id, created.body.data.task_pool_id);
  const messages = events.body.data.messages;
  assert.equal(messages.length, 2);
  assert.match(messages[0].text, /阶段 review/);
  assert.match(messages[1].text, /任务完成：好了/);
  for (const m of messages) {
    assert.equal(typeof m.seq, "number");
    assert.equal(typeof m.ts, "number");
    assert.match(m.local, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.equal(typeof m.sender, "string");
  }

  const detail = await call(`/v1/tasks/${id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.data.task_pool_id, created.body.data.task_pool_id);
  assert.equal(detail.body.data.recent_events.length, 2);

  const snap = await call(`/v1/tasks/${id}/snapshot`);
  assert.equal(snap.status, 200);
  assert.equal(snap.body.data.task.task_pool_id, created.body.data.task_pool_id);
  assert.equal(snap.body.data.recent_events.length, 2);
});
