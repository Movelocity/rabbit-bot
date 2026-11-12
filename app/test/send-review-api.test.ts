/** 发送审核设置 API：GET/PUT、持久化、立即生效、非法值 400。 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { APP_ROOT, loadConfig } from "../src/config.ts";
import { Store } from "../src/core/db.ts";
import { Logger } from "../src/core/logger.ts";
import { startApiServer } from "../src/api.ts";

const dir = path.join(APP_ROOT, ".scratch", "send-review-api");
fs.rmSync(dir, { recursive: true, force: true });

const cfg = loadConfig({
  dataDir: dir,
  logDir: path.join(dir, "logs"),
  api: { enabled: true, port: 0, host: "127.0.0.1" },
  exec: { dir: path.join(dir, "sandbox") },
  sendReview: { enabled: false, platform: "feishu", roomId: "oc_review", ownerIds: ["u_owner"] },
});
const store = new Store(":memory:");
const log = new Logger(null, true);
const token = "s".repeat(32);

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

test("GET /v1/send-review：返回总开关、默认策略、覆盖和就绪状态", async () => {
  const r = await call("/v1/send-review");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data, { enabled: false, defaultReview: false, primaryPoolId: null, overrides: {}, ready: true });
});

test("PUT /v1/send-review：保存并立即改 cfg，按池覆盖 / 主对话可读回", async () => {
  store.upsertPool("feishu", "g1", "group", "测试群");
  const r = await call("/v1/send-review", {
    method: "PUT",
    body: JSON.stringify({
      enabled: true,
      defaultReview: false,
      primaryPoolId: "feishu:g1",
      overrides: { "feishu:g1": true, "feishu:g2": false },
    }),
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.data, {
    enabled: true,
    defaultReview: false,
    primaryPoolId: "feishu:g1",
    overrides: { "feishu:g1": true, "feishu:g2": false },
    ready: true,
  });
  assert.equal(cfg.sendReview?.enabled, true);
  assert.equal(cfg.sendReview?.defaultReview, false);
  assert.equal(cfg.sendReview?.primaryPoolId, "feishu:g1");
  assert.deepEqual(cfg.sendReview?.overrides, { "feishu:g1": true, "feishu:g2": false });

  const file = path.join(dir, "run", "send-review.json");
  assert.ok(fs.existsSync(file));
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(saved.enabled, true);
  assert.equal(saved.defaultReview, false);
  assert.equal(saved.primaryPoolId, "feishu:g1");
  assert.deepEqual(saved.overrides, { "feishu:g1": true, "feishu:g2": false });
});

test("PUT /v1/send-review：主对话池不存在时 400", async () => {
  const r = await call("/v1/send-review", {
    method: "PUT",
    body: JSON.stringify({
      enabled: false,
      defaultReview: false,
      primaryPoolId: "feishu:nope",
      overrides: {},
    }),
  });
  assert.equal(r.status, 400);
});

test("PUT /v1/send-review：非法值 400，且不改动已生效设置", async () => {
  const before = cfg.sendReview?.enabled;
  const r = await call("/v1/send-review", {
    method: "PUT",
    body: JSON.stringify({ enabled: "yes", defaultReview: true, overrides: {} }),
  });
  assert.equal(r.status, 400);
  assert.equal(cfg.sendReview?.enabled, before);

  const r2 = await call("/v1/send-review", {
    method: "PUT",
    body: JSON.stringify({ enabled: true, defaultReview: true, overrides: { "feishu:g1": "yes" } }),
  });
  assert.equal(r2.status, 400);
});

test("没配审批房时不允许打开总开关（否则会 fail-closed 拦住所有消息）", async () => {
  const noRoomCfg = loadConfig({
    dataDir: path.join(dir, "no-room"),
    logDir: path.join(dir, "no-room", "logs"),
    api: { enabled: true, port: 0, host: "127.0.0.1" },
    approval: { enabled: false, platform: "feishu", roomId: "", ownerIds: [] },
    sendReview: { enabled: false, platform: "feishu", roomId: "", ownerIds: [] },
  });
  const noRoomStore = new Store(":memory:");
  const srv = await startApiServer({ cfg: noRoomCfg, store: noRoomStore, log: new Logger(null, true), token });
  try {
    const addr = srv!.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${addr.port}/v1/send-review`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ enabled: true, defaultReview: true, overrides: {} }),
    });
    assert.equal(res.status, 400);
    assert.equal(noRoomCfg.sendReview?.enabled, false);
  } finally {
    srv?.close();
    noRoomStore.close();
  }
});
