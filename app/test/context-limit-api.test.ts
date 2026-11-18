/** 上下文交接阈值 API：GET 默认档、PUT 只收固定档位、落盘、重启读回。 */
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
import { loadContextLimitSettings } from "../src/ops/context-limit-settings.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-context-limit-"));
const overrides = {
  dataDir: dir,
  logDir: path.join(dir, "logs"),
  api: { enabled: true, port: 0, host: "127.0.0.1" },
  runtimeDir: path.join(dir, "runtime"),
  exec: { dir: path.join(dir, "sandbox") },
};
const cfg = loadConfig(overrides);
const store = new Store(":memory:");
const log = new Logger(null, true);
const token = "c".repeat(32);

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

test("GET /v1/context-limit：默认 100k", async () => {
  const r = await call("/v1/context-limit");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.tokenLimit, 100000);
});

test("PUT /v1/context-limit：收固定档位、落盘、改 cfg", async () => {
  const r = await call("/v1/context-limit", {
    method: "PUT",
    body: JSON.stringify({ tokenLimit: 200000 }),
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.tokenLimit, 200000);
  assert.equal(cfg.handoff.contextTokenLimit, 200000);

  const saved = JSON.parse(fs.readFileSync(path.join(dir, "run", "context-limit.json"), "utf8"));
  assert.equal(saved.tokenLimit, 200000);
  assert.equal(typeof saved.updated_at, "string");
});

test("PUT /v1/context-limit：非档位值 400，且不应用", async () => {
  const before = cfg.handoff.contextTokenLimit;
  for (const tokenLimit of [0, 123456, "200000", 1.5, 900000]) {
    const r = await call("/v1/context-limit", { method: "PUT", body: JSON.stringify({ tokenLimit }) });
    assert.equal(r.status, 400, JSON.stringify({ tokenLimit }));
  }
  assert.equal(cfg.handoff.contextTokenLimit, before);
});

test("重启时 loadContextLimitSettings 能读回保存值", () => {
  const fresh = loadConfig(overrides);
  const loaded = loadContextLimitSettings(fresh);
  assert.deepEqual(loaded, { tokenLimit: 200000 });
  assert.equal(fresh.handoff.contextTokenLimit, 200000);
});
