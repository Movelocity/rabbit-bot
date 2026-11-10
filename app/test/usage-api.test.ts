/** Token 用量 API：默认值、小时/天聚合、范围校验、逐次明细。 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { APP_ROOT, loadConfig } from "../src/config.ts";
import { Store } from "../src/core/db.ts";
import { Logger } from "../src/core/logger.ts";
import { startApiServer } from "../src/api.ts";

const dir = path.join(APP_ROOT, ".scratch", "usage-api");
fs.mkdirSync(dir, { recursive: true });
const cfg = loadConfig({
  dataDir: dir,
  logDir: path.join(dir, "logs"),
  api: { enabled: true, port: 0, host: "127.0.0.1" },
  exec: { dir: path.join(dir, "sandbox") },
});
const store = new Store(":memory:");
const log = new Logger(null, true);
const token = "u".repeat(32);

const t1 = Date.UTC(2026, 0, 5, 2, 10);
const t2 = Date.UTC(2026, 0, 5, 2, 40);
const t3 = Date.UTC(2026, 0, 5, 4, 10);
const from = Date.UTC(2026, 0, 5, 0, 0);
const to = Date.UTC(2026, 0, 6, 0, 0);
store.addUsageEvent({ ts: t1, model: "deepseek-flash", cacheHit: 60, cacheMiss: 40, outTokens: 20, totalTokens: 100, costUsd: 0.001, calls: 2 });
store.addUsageEvent({ ts: t2, model: "deepseek-flash", cacheHit: 100, cacheMiss: 100, outTokens: 50, totalTokens: 200, costUsd: 0.002, calls: 3 });
store.addUsageEvent({ ts: t3, model: "deepseek-v4-pro", cacheHit: 0, cacheMiss: 200, outTokens: 30, totalTokens: 300, costUsd: 0.003, calls: 4 });

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

test("GET /v1/usage 默认 bucket=hour、最近 24 小时", async () => {
  const now = Date.now();
  store.addUsageEvent({ ts: now - 3600_000, cacheHit: 30, cacheMiss: 10, outTokens: 2, totalTokens: 42, costUsd: 0.0004 });
  const r = await call("/v1/usage");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const data = r.body.data;
  assert.equal(data.bucket, "hour");
  assert.ok(data.to > data.from);
  assert.ok(Math.abs(data.to - data.from - 24 * 3600e3) < 5_000);
  assert.equal(data.summary.calls, 1);
  assert.equal(data.summary.tokens, 42);
  assert.equal(data.series.length, 1);
});

test("GET /v1/usage：hour/day 聚合正确", async () => {
  const hour = await call(`/v1/usage?bucket=hour&from=${from}&to=${to}`);
  assert.equal(hour.status, 200, JSON.stringify(hour.body));
  assert.equal(hour.body.data.bucket, "hour");
  assert.equal(hour.body.data.summary.calls, 9);
  assert.equal(hour.body.data.summary.tokens, 600);
  assert.equal(hour.body.data.summary.cacheHit, 160);
  assert.equal(hour.body.data.summary.cacheMiss, 340);
  assert.equal(hour.body.data.summary.outTokens, 100);
  assert.ok(Math.abs(hour.body.data.summary.hitRate - 0.32) < 1e-9);
  assert.deepEqual(hour.body.data.series.map((p: any) => p.key), ["2026-01-05 10", "2026-01-05 12"]);
  assert.equal(hour.body.data.series[0].calls, 5);
  assert.equal(hour.body.data.series[0].tokens, 300);

  const day = await call(`/v1/usage?bucket=day&from=${from}&to=${to}`);
  assert.equal(day.status, 200, JSON.stringify(day.body));
  assert.equal(day.body.data.bucket, "day");
  assert.equal(day.body.data.series.length, 1);
  assert.equal(day.body.data.series[0].key, "2026-01-05");
  assert.equal(day.body.data.series[0].calls, 9);
  assert.equal(day.body.data.series[0].tokens, 600);
});

test("GET /v1/usage：范围校验 400", async () => {
  assert.equal((await call(`/v1/usage?from=2000&to=1000`)).status, 400);
  assert.equal((await call(`/v1/usage?from=0&to=${91 * 86400e3}`)).status, 400);
  assert.equal((await call(`/v1/usage?bucket=week&from=${from}&to=${to}`)).status, 400);
});

test("GET /v1/usage/calls：返回明细、倒序、limit", async () => {
  const r = await call(`/v1/usage/calls?from=${from}&to=${to}&limit=2`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.calls.length, 2);
  assert.deepEqual(r.body.data.calls.map((c: any) => c.ts), [t3, t2]);
  assert.match(r.body.data.calls[0].ts_local, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(r.body.data.calls[0].source, "llm");
  assert.equal(r.body.data.calls[0].model, "deepseek-v4-pro");
  assert.equal(r.body.data.calls[0].calls, 4);
  assert.equal(r.body.data.calls[1].calls, 3);

  const all = await call(`/v1/usage/calls?from=${from}&to=${to}`);
  assert.equal(all.status, 200);
  assert.equal(all.body.data.calls.length, 3);

  assert.equal((await call(`/v1/usage/calls?from=2000&to=1000`)).status, 400);
});
