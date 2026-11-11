/** 日程 API：创建 cron/delay、列表、取消、非法表达式 400。 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { APP_ROOT, loadConfig } from "../src/config.ts";
import { Store } from "../src/core/db.ts";
import { Logger } from "../src/core/logger.ts";
import { startApiServer } from "../src/api.ts";
import { fmtLocal, parseIsoInTz } from "../src/core/time.ts";

const dir = path.join(APP_ROOT, ".scratch", "schedule-api");
const cfg = loadConfig({
  dataDir: dir,
  logDir: path.join(dir, "logs"),
  api: { enabled: true, port: 0, host: "127.0.0.1" },
  exec: { dir: path.join(dir, "sandbox") },
});
const store = new Store(":memory:");
const log = new Logger(null, true);
const token = "s".repeat(32);
let notified = 0;

let server: Awaited<ReturnType<typeof startApiServer>> = null;
let base = "";

test.before(async () => {
  server = await startApiServer({
    cfg, store, log, token,
    scheduler: { updateConfig: () => {}, notifyScheduleChange: () => { notified++; } },
  });
  const addr = server!.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

test.after(() => {
  server?.close();
  store.close();
});

const call = async (p: string, init: RequestInit = {}) => {
  const res = await fetch(`${base}${p}`, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(init.headers as any) },
  });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
};

test("POST /v1/schedules 建 delay 日程并通知调度器", async () => {
  const before = notified;
  const r = await call("/v1/schedules", {
    method: "POST",
    body: JSON.stringify({ content: "提醒他交报告", delay_minutes: 30 }),
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.kind, "delay");
  assert.equal(r.body.data.status, "active");
  assert.equal(r.body.data.delay_minutes, 30);
  assert.ok(notified > before);
});

test("POST /v1/schedules 建 cron 日程", async () => {
  const r = await call("/v1/schedules", {
    method: "POST",
    body: JSON.stringify({ title: "早报", content: "看看今天的任务", cron: "0 9 * * *" }),
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.kind, "cron");
  assert.equal(r.body.data.cron, "0 9 * * *");
  const at = parseIsoInTz("2026-11-11T08:00:00", "Asia/Shanghai")!;
  assert.equal(fmtLocal(r.body.data.next_at, "Asia/Shanghai").slice(11), "09:00:00");
  assert.ok(at > 0);
});

test("GET /v1/schedules?status=active 只返回 active", async () => {
  const r = await call("/v1/schedules?status=active");
  assert.equal(r.status, 200);
  assert.ok(r.body.data.length >= 2);
  assert.ok(r.body.data.every((s: any) => s.status === "active"));
});

test("PATCH 取消后 GET 能查到 cancelled", async () => {
  const created = await call("/v1/schedules", {
    method: "POST",
    body: JSON.stringify({ content: "取消我", delay_minutes: 5 }),
  });
  const id = created.body.data.id;
  const r = await call(`/v1/schedules/${id}`, { method: "PATCH", body: JSON.stringify({ status: "cancelled" }) });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.status, "cancelled");

  const got = await call(`/v1/schedules/${id}`);
  assert.equal(got.body.data.status, "cancelled");
});

test("DELETE 等于取消", async () => {
  const created = await call("/v1/schedules", {
    method: "POST",
    body: JSON.stringify({ content: "删除我", delay_minutes: 5 }),
  });
  const id = created.body.data.id;
  const r = await call(`/v1/schedules/${id}`, { method: "DELETE" });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.status, "cancelled");
});

test("非法 cron / 缺 content 返回 400", async () => {
  const bad = await call("/v1/schedules", {
    method: "POST",
    body: JSON.stringify({ content: "x", cron: "not a cron" }),
  });
  assert.equal(bad.status, 400);

  const noContent = await call("/v1/schedules", {
    method: "POST",
    body: JSON.stringify({ delay_minutes: 5 }),
  });
  assert.equal(noContent.status, 400);
});

test("GET 不存在的日程返回 404", async () => {
  const r = await call("/v1/schedules/999999");
  assert.equal(r.status, 404);
});
