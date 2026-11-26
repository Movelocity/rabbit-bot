/** 飞书对接：凭据落盘/掩码、适配器入站计数、hub 入池计数、管理 API 契约。 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { FeishuAdapter } from "../src/adapters/feishu.ts";
import { loadConfig } from "../src/config.ts";
import { startApiServer } from "../src/api.ts";
import { Store } from "../src/core/db.ts";
import { Hub } from "../src/core/hub.ts";
import { Logger } from "../src/core/logger.ts";
import {
  clearFeishuCredentials, effectiveFeishuCredentials, feishuCredentialView, maskAppId,
  saveFeishuCredentials,
} from "../src/ops/feishu-connection.ts";

const log = new Logger(null, true);

function tmpCfg() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-feishu-conn-"));
  const cfg = loadConfig({
    dataDir: dir,
    logDir: path.join(dir, "logs"),
    runtimeDir: path.join(dir, "runtime"),
    exec: { dir: path.join(dir, "sandbox") },
    llm: { provider: "deepseek", model: "deepseek-flash", models: [] },
    adapters: { feishu: { enabled: false, domain: "feishu", fetchSenderName: false, reactions: false, logRawEmoji: false } },
  });
  return { dir, cfg };
}

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("App ID 掩码只保留足够核对的部分", () => {
  assert.equal(maskAppId("cli_a1b2c3d4e5f6"), "cli_a1…e5f6");
  assert.equal(maskAppId("short"), "sh***");
  assert.equal(maskAppId(""), "");
});

test("凭据保存：runtime 优先于 env，文件 0600，接口视图不包含 secret", () => {
  const { dir, cfg } = tmpCfg();
  withEnv({ FEISHU_APP_ID: "cli_env", FEISHU_APP_SECRET: "env-secret-value" }, () => {
    assert.equal(effectiveFeishuCredentials(cfg).source, "env");
    const saved = saveFeishuCredentials(cfg, {
      appId: "cli_runtime_123456",
      appSecret: "runtime-secret-value",
      domain: "feishu",
    });
    assert.equal(saved.source, "runtime");
    assert.equal(effectiveFeishuCredentials(cfg).appId, "cli_runtime_123456");
    assert.equal(effectiveFeishuCredentials(cfg).source, "runtime");

    const file = path.join(dir, "secrets", "feishu.json");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).app_secret, "runtime-secret-value");

    const view = feishuCredentialView(cfg);
    assert.equal(view.configured, true);
    assert.equal(view.credential_source, "runtime");
    assert.equal(view.app_id_masked, "cli_ru…3456");
    assert.equal(JSON.stringify(view).includes("runtime-secret-value"), false);

    clearFeishuCredentials(cfg);
    assert.equal(effectiveFeishuCredentials(cfg).source, "env");
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Secret 留空：没有 runtime 凭据时拒绝，避免把 env secret 静默写盘", () => {
  const { dir, cfg } = tmpCfg();
  withEnv({ FEISHU_APP_ID: undefined, FEISHU_APP_SECRET: undefined }, () => {
    assert.throws(() => saveFeishuCredentials(cfg, { appId: "cli_x", appSecret: "" }), /App Secret/);
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("适配器入站计数：收到、重复、已交入池", async () => {
  const a = new FeishuAdapter(
    { appId: "test", appSecret: "test", domain: "feishu", fetchSenderName: false },
    log,
  );
  const got: string[] = [];
  (a as any).sink = (m: any) => got.push(m.msg_id);
  const ev = {
    sender: { sender_id: { open_id: "ou_1" }, sender_type: "user" },
    message: {
      message_id: "om_conn_1", chat_id: "oc_p2p", chat_type: "p2p", message_type: "text",
      content: JSON.stringify({ text: "在吗" }), create_time: "1792641840000",
    },
  };
  await a._deliver("im.message.receive_v1", ev);
  await a._deliver("im.message.receive_v1", ev);

  const st = a.status();
  assert.deepEqual(got, ["om_conn_1"]);
  assert.equal(st.counters?.received, 2);
  assert.equal(st.counters?.duplicates, 1);
  assert.equal(st.counters?.processed, 1);
  assert.equal(st.counters?.conversion_errors, 0);
  assert.equal(st.counters?.enqueue_errors, 0);
  assert.ok(st.last_event_at);
  assert.ok(st.last_inbound_at);
  assert.deepEqual(st.events, []);
});

test("hub 入站计数：入库、重复、自己发送分开统计", () => {
  const { dir, cfg } = tmpCfg();
  const store = new Store(":memory:");
  const hub = new Hub(store, cfg, log, {} as any);
  const msg = {
    platform: "feishu" as const, external_chat_id: "oc_stats", pool_kind: "private" as const,
    msg_id: "om_stats_1", sender_id: "ou_1", sender_name: "用户", ts: 1792641840000,
    text: "hi", reply_to: null, mentions: [], is_mention_me: false, media_type: "text" as const,
  };
  hub.ingest(msg);
  hub.ingest(msg);
  hub.ingest({ ...msg, msg_id: "om_stats_2", from_self: true });

  const st = hub.inboundStats("feishu");
  assert.equal(st.attempts, 3);
  assert.equal(st.stored, 1);
  assert.equal(st.duplicates, 1);
  assert.equal(st.self, 1);
  assert.ok(st.last_stored_at);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("API：GET/PUT/DELETE /v1/adapters/feishu 不回显 secret", async () => {
  const { dir, cfg } = tmpCfg();
  cfg.api = { enabled: true, port: 0, host: "127.0.0.1" };
  const store = new Store(":memory:");
  const token = "f".repeat(32);
  const server = await startApiServer({ cfg, store, log, token });
  const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  const call = async (p: string, init: RequestInit = {}) => {
    const res = await fetch(`${base}${p}`, {
      ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(init.headers as any) },
    });
    return { status: res.status, body: await res.json() };
  };
  const savedId = process.env.FEISHU_APP_ID;
  const savedSecret = process.env.FEISHU_APP_SECRET;
  delete process.env.FEISHU_APP_ID;
  delete process.env.FEISHU_APP_SECRET;
  try {
    const list = await call("/v1/adapters");
    assert.equal(list.status, 200);
    assert.equal(list.body.data.bots.length, 1);
    assert.equal(list.body.data.bots[0].platform, "feishu");
    assert.equal(list.body.data.bots[0].configured, false);

    const empty = await call("/v1/adapters/feishu");
    assert.equal(empty.status, 200);
    assert.equal(empty.body.data.configured, false);
    assert.equal(empty.body.data.connection, null);

    const bad = await call("/v1/adapters/feishu/credentials", {
      method: "PUT",
      body: JSON.stringify({ app_id: "cli_a", app_secret: "s", domain: "other", verify: false }),
    });
    assert.equal(bad.status, 400);

    const saved = await call("/v1/adapters/feishu/credentials", {
      method: "PUT",
      body: JSON.stringify({ app_id: "cli_api_abcdef", app_secret: "api-secret-value", domain: "feishu", verify: false }),
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.data.configured, true);
    assert.equal(saved.body.data.credential_source, "runtime");
    assert.equal(saved.body.data.app_id_masked, "cli_ap…cdef");
    assert.equal(JSON.stringify(saved.body).includes("api-secret-value"), false);
    assert.equal(saved.body.data.enabled, false);

    const again = await call("/v1/adapters/feishu");
    assert.equal(again.body.data.credential_source, "runtime");

    const listSaved = await call("/v1/adapters");
    assert.equal(listSaved.body.data.bots[0].credential_source, "runtime");
    assert.equal(JSON.stringify(listSaved.body).includes("api-secret-value"), false);

    const cleared = await call("/v1/adapters/feishu", { method: "DELETE" });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.data.configured, false);
  } finally {
    if (savedId === undefined) delete process.env.FEISHU_APP_ID;
    else process.env.FEISHU_APP_ID = savedId;
    if (savedSecret === undefined) delete process.env.FEISHU_APP_SECRET;
    else process.env.FEISHU_APP_SECRET = savedSecret;
    server?.close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});