/** worker 领任务 / 快照 API 契约：8 个新路由的成功、校验、鉴权。 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { APP_ROOT, loadConfig } from "../src/config.ts";
import { Store } from "../src/core/db.ts";
import { Logger } from "../src/core/logger.ts";
import { startApiServer } from "../src/api.ts";

const dir = path.join(APP_ROOT, ".scratch", "workers-api");
fs.mkdirSync(dir, { recursive: true });
const cfg = loadConfig({
  dataDir: dir,
  logDir: path.join(dir, "logs"),
  api: { enabled: true, port: 0, host: "127.0.0.1" },
  exec: { dir: path.join(dir, "sandbox") },
});
const store = new Store(":memory:");
const log = new Logger(null, true);
const token = "w".repeat(32);
let enqueued = 0;

let server: Awaited<ReturnType<typeof startApiServer>> = null;
let base = "";

test.before(async () => {
  server = await startApiServer({ cfg, store, log, token, enqueue: () => { enqueued++; } });
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

test("8 个新路由都要求 Bearer token", async () => {
  const routes: [string, RequestInit][] = [
    ["/v1/workers/register", { method: "POST", body: "{}" }],
    ["/v1/workers", { method: "GET" }],
    ["/v1/workers/wa-1/claim", { method: "POST", body: "{}" }],
    ["/v1/tasks/1/touch", { method: "POST", body: "{}" }],
    ["/v1/tasks/1/progress", { method: "POST", body: "{}" }],
    ["/v1/tasks/1/complete", { method: "POST", body: "{}" }],
    ["/v1/tasks/1/fail", { method: "POST", body: "{}" }],
    ["/v1/tasks/1/snapshot", { method: "GET" }],
  ];
  for (const [p, init] of routes) {
    assert.equal((await call(p, { ...init, auth: null })).status, 401, p);
  }
});

test("workers：注册幂等、列表、参数校验", async () => {
  assert.equal((await post("/v1/workers/register", {})).status, 400);
  assert.equal((await post("/v1/workers/register", { worker_id: "wa-1" })).status, 400);

  const first = await post("/v1/workers/register", { worker_id: "wa-1", name: "本地 WA", kind: "wa" });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.data.worker_id, "wa-1");
  assert.equal(first.body.data.status, "online");

  const again = await post("/v1/workers/register", { worker_id: "wa-1", name: "本地 WA" });
  assert.equal(again.status, 200);
  const listed = await call("/v1/workers");
  assert.equal(listed.status, 200);
  assert.equal(listed.body.data.filter((w: any) => w.worker_id === "wa-1").length, 1);
});

test("claim：没任务返回 null，有任务原子领走并分配租约", async () => {
  const empty = await post("/v1/workers/wa-1/claim");
  assert.equal(empty.status, 200);
  assert.equal(empty.body.data.task, null);

  const created = await post("/v1/tasks", { name: "#验收", goal: "跑一遍验收", work_dir: dir, dispatch: false });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.data.id;

  const claimed = await post("/v1/workers/wa-1/claim");
  assert.equal(claimed.status, 200);
  assert.equal(claimed.body.data.task.id, id);
  assert.equal(claimed.body.data.task.status, "running");
  assert.equal(claimed.body.data.task.worker_id, "wa-1");
  assert.equal(claimed.body.data.task.attempt, 1);
  assert.ok(claimed.body.data.task.lease_until > Date.now());

  const dup = await post("/v1/workers/wa-1/claim");
  assert.equal(dup.body.data.task, null, "已被领走的任务不会重复领");
});

test("touch：续租成功；缺 worker 400，不匹配 409，不存在 404", async () => {
  const id = (await call("/v1/tasks?status=running")).body.data[0].id;
  assert.equal((await post(`/v1/tasks/${id}/touch`, {})).status, 400);
  assert.equal((await post(`/v1/tasks/${id}/touch`, { worker_id: "wa-2" })).status, 409);
  assert.equal((await post("/v1/tasks/999999/touch", { worker_id: "wa-1" })).status, 404);

  const ok = await post(`/v1/tasks/${id}/touch`, { worker_id: "wa-1" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(typeof ok.body.data.lease_until, "number");
});

test("progress：写 stage/note；校验 400、越权 409、不存在 404", async () => {
  const id = (await call("/v1/tasks?status=running")).body.data[0].id;
  assert.equal((await post(`/v1/tasks/${id}/progress`, { stage: "working" })).status, 400);
  assert.equal((await post(`/v1/tasks/${id}/progress`, { worker_id: "wa-1" })).status, 400);
  assert.equal((await post(`/v1/tasks/${id}/progress`, { worker_id: "wa-2", stage: "working" })).status, 409);
  assert.equal((await post("/v1/tasks/999999/progress", { worker_id: "wa-1", stage: "working" })).status, 404);

  const ok = await post(`/v1/tasks/${id}/progress`, { worker_id: "wa-1", stage: "review", note: "写完了，检查中" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.stage, "review");
  assert.equal(ok.body.data.note, "写完了，检查中");
});

test("snapshot：任务快照 + worker 状态，无工具调用明细", async () => {
  const id = (await call("/v1/tasks?status=running")).body.data[0].id;
  const snap = await call(`/v1/tasks/${id}/snapshot`);
  assert.equal(snap.status, 200);
  assert.equal(snap.body.data.task.id, id);
  assert.equal(snap.body.data.task.status, "running");
  assert.equal(snap.body.data.task.stage, "review");
  assert.equal(snap.body.data.worker.worker_id, "wa-1");
  assert.equal(snap.body.data.worker.status, "online");
  assert.equal(typeof snap.body.data.worker.last_seen_at, "number");
  assert.equal("events" in snap.body.data, false);
  assert.equal("tools" in snap.body.data, false);
  assert.equal((await call("/v1/tasks/999999/snapshot")).status, 404);
});

test("complete：done/end_at/清 lease；重复完成 400，不匹配 409，缺 worker 400", async () => {
  const id = (await call("/v1/tasks?status=running")).body.data[0].id;
  assert.equal((await post(`/v1/tasks/${id}/complete`, {})).status, 400);
  assert.equal((await post(`/v1/tasks/${id}/complete`, { worker_id: "wa-2" })).status, 409);
  assert.equal((await post("/v1/tasks/999999/complete", { worker_id: "wa-1" })).status, 404);

  const done = await post(`/v1/tasks/${id}/complete`, {
    worker_id: "wa-1", result: "全部通过", artifact: "report.md", note: "交付完成",
  });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.data.status, "done");
  assert.equal(done.body.data.result, "全部通过");
  assert.equal(done.body.data.artifact, "report.md");
  assert.ok(done.body.data.end_at > 0);
  assert.equal(enqueued, 1, "完成触发了一次 task-updated 唤醒");

  assert.equal((await post(`/v1/tasks/${id}/complete`, { worker_id: "wa-1" })).status, 400);
});

test("fail：retryable 回 pending，非 retryable 置 failed", async () => {
  const retryId = (await post("/v1/tasks", { name: "#重试", goal: "重试任务", work_dir: dir, dispatch: false })).body.data.id;
  await post("/v1/workers/wa-1/claim");
  const back = await post(`/v1/tasks/${retryId}/fail`, { worker_id: "wa-1", error: "临时错误", retryable: true });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.equal(back.body.data.status, "pending");
  let snap = await call(`/v1/tasks/${retryId}/snapshot`);
  assert.equal(snap.body.data.task.worker_id, null);
  assert.equal(snap.body.data.task.lease_until, null);
  assert.match(snap.body.data.task.note, /临时错误/);

  await post("/v1/workers/wa-1/claim");
  const dead = await post(`/v1/tasks/${retryId}/fail`, {
    worker_id: "wa-1", error: "彻底失败", retryable: false,
  });
  assert.equal(dead.status, 200, JSON.stringify(dead.body));
  assert.equal(dead.body.data.status, "failed");
  assert.equal(dead.body.data.result, "彻底失败");

  assert.equal((await post(`/v1/tasks/${retryId}/fail`, { worker_id: "wa-1" })).status, 400);
  assert.equal((await post("/v1/tasks/999999/fail", { worker_id: "wa-1" })).status, 404);
});
