/** 看门狗设置 API 契约：GET/PUT、持久化、非法值 400、重启能读回。 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { APP_ROOT, loadConfig } from "../src/config.ts";
import { Store } from "../src/core/db.ts";
import { Logger } from "../src/core/logger.ts";
import { startApiServer } from "../src/api.ts";
import { loadWatchdogSettings } from "../src/ops/watchdog-settings.ts";

const dir = path.join(APP_ROOT, ".scratch", "watchdog-api");
const cfg = loadConfig({
  dataDir: dir,
  logDir: path.join(dir, "logs"),
  api: { enabled: true, port: 0, host: "127.0.0.1" },
  exec: { dir: path.join(dir, "sandbox") },
});
const store = new Store(":memory:");
const log = new Logger(null, true);
const token = "w".repeat(32);

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

test("GET /v1/watchdog 默认关闭", async () => {
  const r = await call("/v1/watchdog");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data, { enabled: false, delayMs: 10000, cooldownMs: 600000 });
});

test("PUT /v1/watchdog：合法值 200、写文件、改 cfg", async () => {
  const r = await call("/v1/watchdog", {
    method: "PUT",
    body: JSON.stringify({ enabled: true, delayMs: 8000, cooldownMs: 300000 }),
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.data, { enabled: true, delayMs: 8000, cooldownMs: 300000 });
  assert.deepEqual(cfg.watchdog, { enabled: true, delayMs: 8000, cooldownMs: 300000 });

  const file = path.join(dir, "run", "watchdog.json");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(saved.enabled, true);
  assert.equal(saved.delayMs, 8000);
  assert.equal(saved.cooldownMs, 300000);
  assert.equal(typeof saved.updated_at, "string");
});

test("PUT /v1/watchdog：非法值 400，且不应用", async () => {
  const before = { ...cfg.watchdog };
  const bad = [
    { enabled: "yes", delayMs: 10000, cooldownMs: 600000 },
    { enabled: true, delayMs: 0, cooldownMs: 600000 },
    { enabled: true, delayMs: 999, cooldownMs: 600000 },
    { enabled: true, delayMs: 10000, cooldownMs: -1 },
    { enabled: true, delayMs: 10000, cooldownMs: 86400001 },
    { enabled: true, delayMs: 10000 },
  ];
  for (const body of bad) {
    const r = await call("/v1/watchdog", { method: "PUT", body: JSON.stringify(body) });
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.deepEqual(cfg.watchdog, before);
});

test("重启时 loadWatchdogSettings 能读回保存值", () => {
  const fresh = loadConfig({
    dataDir: dir,
    logDir: path.join(dir, "logs"),
    api: { enabled: true, port: 0, host: "127.0.0.1" },
    exec: { dir: path.join(dir, "sandbox") },
  });
  const loaded = loadWatchdogSettings(fresh);
  assert.deepEqual(loaded, { enabled: true, delayMs: 8000, cooldownMs: 300000 });
  assert.deepEqual(fresh.watchdog, { enabled: true, delayMs: 8000, cooldownMs: 300000 });
});
