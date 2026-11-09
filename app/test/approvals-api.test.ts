/** 审批 API 契约：5 个路由的成功、400/404/409/401。 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { APP_ROOT, loadConfig } from "../src/config.ts";
import { Store } from "../src/core/db.ts";
import { Logger } from "../src/core/logger.ts";
import { startApiServer } from "../src/api.ts";
import { takePendingTick } from "../src/core/tasks.ts";

const dir = path.join(APP_ROOT, ".scratch", "approvals-api");
fs.mkdirSync(dir, { recursive: true });
const cfg = loadConfig({
  dataDir: dir,
  logDir: path.join(dir, "logs"),
  api: { enabled: true, port: 0, host: "127.0.0.1" },
  exec: { dir: path.join(dir, "sandbox") },
});
const store = new Store(":memory:");
const log = new Logger(null, true);
const token = "a".repeat(32);
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

test("4 个审批路由都要求 Bearer token", async () => {
  const routes: [string, RequestInit][] = [
    ["/v1/approvals", { method: "POST", body: "{}" }],
    ["/v1/approvals", { method: "GET" }],
    ["/v1/approvals/1", { method: "GET" }],
    ["/v1/approvals/1/decide", { method: "POST", body: "{}" }],
  ];
  for (const [p, init] of routes) {
    assert.equal((await call(p, { ...init, auth: null })).status, 401, p);
  }
});

test("POST /v1/approvals：落库 201；缺 action / 非法 timeout_s 400", async () => {
  assert.equal((await post("/v1/approvals", {})).status, 400);
  assert.equal((await post("/v1/approvals", { action: "  " })).status, 400);
  assert.equal((await post("/v1/approvals", { action: "shell: x", timeout_s: 0 })).status, 400);
  assert.equal((await post("/v1/approvals", { action: "shell: x", timeout_s: "60" })).status, 400);

  const r = await post("/v1/approvals", {
    task_id: 3, worker_id: "wa-1", action: "shell: npm publish", detail: "/work", why: "发布", timeout_s: 30,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.data.status, "pending");
  assert.equal(r.body.data.task_id, 3);
  assert.equal(r.body.data.worker_id, "wa-1");
  assert.equal(r.body.data.action, "shell: npm publish");
  assert.equal(r.body.data.expires_at - r.body.data.created_at, 30_000);
  assert.equal(enqueued, 1, "申请落库置一次 pending tick");
});

test("GET /v1/approvals：列表与 status/task_id/limit 过滤；非法 status 400", async () => {
  await post("/v1/approvals", { task_id: 9, action: "shell: a" });
  const all = await call("/v1/approvals");
  assert.equal(all.status, 200);
  assert.ok(all.body.data.length >= 2);

  const pending = await call("/v1/approvals?status=pending");
  assert.equal(pending.status, 200);
  assert.ok(pending.body.data.every((a: any) => a.status === "pending"));

  const filtered = await call("/v1/approvals?task_id=3");
  assert.equal(filtered.status, 200);
  assert.ok(filtered.body.data.length === 1);
  assert.equal(filtered.body.data[0].task_id, 3);

  assert.equal((await call("/v1/approvals?status=wat")).status, 400);
});

test("GET /v1/approvals/:id：成功、404、非法 id 400", async () => {
  const created = await post("/v1/approvals", { action: "shell: whoami" });
  const id = created.body.data.id;

  const got = await call(`/v1/approvals/${id}`);
  assert.equal(got.status, 200);
  assert.equal(got.body.data.id, id);
  assert.equal(got.body.data.action, "shell: whoami");

  assert.equal((await call("/v1/approvals/999999")).status, 404);
  assert.equal((await call("/v1/approvals/abc")).status, 400);
});

test("POST /v1/approvals/:id/decide：批准、重复 409、非法 400、不存在 404", async () => {
  const created = await post("/v1/approvals", { action: "shell: deploy" });
  const id = created.body.data.id;
  takePendingTick(store);

  assert.equal((await post(`/v1/approvals/${id}/decide`, { decision: "maybe", by: "u1" })).status, 400);
  assert.equal((await post(`/v1/approvals/${id}/decide`, { decision: "approved" })).status, 400);
  assert.equal((await post("/v1/approvals/999999/decide", { decision: "approved", by: "u1" })).status, 404);

  const ok = await post(`/v1/approvals/${id}/decide`, { decision: "approved", by: "u1" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.status, "approved");
  assert.equal(ok.body.data.decided_by, "u1");
  assert.ok(ok.body.data.decided_at > 0);

  assert.equal((await post(`/v1/approvals/${id}/decide`, { decision: "rejected", by: "u1" })).status, 409);
});

test("POST /v1/approvals/:id/decide：拒绝 200 且置 pending tick", async () => {
  const created = await post("/v1/approvals", { action: "shell: dropdb" });
  const id = created.body.data.id;
  takePendingTick(store);
  const before = enqueued;

  const no = await post(`/v1/approvals/${id}/decide`, { decision: "rejected", by: "u2" });
  assert.equal(no.status, 200, JSON.stringify(no.body));
  assert.equal(no.body.data.status, "rejected");
  assert.equal(no.body.data.decided_by, "u2");
  assert.equal(enqueued, before + 1, "拒绝是终态，置一次 tick");
  assert.ok(takePendingTick(store) !== null);
});
