/** 日额度 API：GET 当前限制 + 今日用量、PUT 校验/持久化/立即生效、重启读回。 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/core/db.ts";
import { Logger } from "../src/core/logger.ts";
import { startApiServer } from "../src/api.ts";
import { loadLimitSettings } from "../src/ops/limit-settings.ts";
import { dayKey } from "../src/core/time.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-limits-"));
const overrides = {
  dataDir: dir,
  logDir: path.join(dir, "logs"),
  api: { enabled: true, port: 0, host: "127.0.0.1" },
  runtimeDir: path.join(dir, "runtime"),
  exec: { dir: path.join(dir, "sandbox") },
  limits: { dailyLlmCalls: -1, dailyTokens: -1, dailyCny: 10, usdCny: 7 },
};
const cfg = loadConfig(overrides);
const store = new Store(":memory:");
const log = new Logger(null, true);
const token = "l".repeat(32);

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
  fs.rmSync(dir, { recursive: true, force: true });
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

test("GET /v1/limits：返回限制和今日用量，默认不设调用/token 闸", async () => {
  const today = dayKey(Date.now(), cfg.timezone);
  store.addUsage(today, 2, 300, 1, { costUsd: 0.5 });
  const r = await call("/v1/limits");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.dailyLlmCalls, -1);
  assert.equal(r.body.data.dailyTokens, -1);
  assert.equal(r.body.data.dailyCny, 10);
  assert.equal(r.body.data.usdCny, 7);
  assert.equal(r.body.data.today.day, today);
  assert.equal(r.body.data.today.llm_calls, 2);
  assert.equal(r.body.data.today.tokens, 300);
  assert.equal(r.body.data.today.cost_cny, 3.5);
  assert.equal(r.body.data.today.calls_left, null);
  assert.equal(r.body.data.today.tokens_left, null);
  assert.equal(r.body.data.today.cny_left, 6.5);
});

test("PUT /v1/limits：合法值 200、写文件、改 cfg、立即体现在 GET", async () => {
  const r = await call("/v1/limits", {
    method: "PUT",
    body: JSON.stringify({ dailyLlmCalls: 100, dailyTokens: 200000, dailyCny: 5 }),
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.dailyLlmCalls, 100);
  assert.equal(r.body.data.dailyTokens, 200000);
  assert.equal(r.body.data.dailyCny, 5);
  assert.deepEqual(
    { calls: cfg.limits.dailyLlmCalls, tokens: cfg.limits.dailyTokens, cny: cfg.limits.dailyCny },
    { calls: 100, tokens: 200000, cny: 5 },
  );

  const saved = JSON.parse(fs.readFileSync(path.join(dir, "run", "limits.json"), "utf8"));
  assert.equal(saved.dailyLlmCalls, 100);
  assert.equal(saved.dailyTokens, 200000);
  assert.equal(saved.dailyCny, 5);
  assert.equal(typeof saved.updated_at, "string");

  const got = await call("/v1/limits");
  assert.equal(got.body.data.dailyLlmCalls, 100);
  assert.equal(got.body.data.today.calls_left, 98);
  assert.equal(got.body.data.today.tokens_left, 199700);
  assert.equal(got.body.data.today.cny_left, 1.5);
});

test("PUT /v1/limits：-1 表示关掉该闸，dailyCny=0 表示不按钱限额", async () => {
  const r = await call("/v1/limits", {
    method: "PUT",
    body: JSON.stringify({ dailyLlmCalls: -1, dailyTokens: -1, dailyCny: 0 }),
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.today.calls_left, null);
  assert.equal(r.body.data.today.tokens_left, null);
  assert.equal(r.body.data.today.cny_left, null);
});

test("PUT /v1/limits：非法值 400，且不应用", async () => {
  const before = { ...cfg.limits };
  const bad = [
    { dailyLlmCalls: 1.5, dailyTokens: 100, dailyCny: 1 },
    { dailyLlmCalls: -2, dailyTokens: 100, dailyCny: 1 },
    { dailyLlmCalls: 0, dailyTokens: "100", dailyCny: 1 },
    { dailyLlmCalls: 0, dailyTokens: 100, dailyCny: -1 },
    { dailyLlmCalls: 0, dailyTokens: 100, dailyCny: "1" },
    { dailyLlmCalls: 0, dailyTokens: 100, dailyCny: 1000001 },
  ];
  for (const body of bad) {
    const r = await call("/v1/limits", { method: "PUT", body: JSON.stringify(body) });
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.deepEqual(cfg.limits, before);
});

test("重启时 loadLimitSettings 能读回保存值", () => {
  const fresh = loadConfig({ ...overrides, limits: { dailyLlmCalls: -1, dailyTokens: -1, dailyCny: 10, usdCny: 7 } });
  const loaded = loadLimitSettings(fresh);
  assert.deepEqual(loaded, { dailyLlmCalls: -1, dailyTokens: -1, dailyCny: 0 });
  assert.equal(fresh.limits.dailyLlmCalls, -1);
  assert.equal(fresh.limits.dailyTokens, -1);
  assert.equal(fresh.limits.dailyCny, 0);
});
