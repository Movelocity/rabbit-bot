/** GET /v1/llm-logs：列表和按会话分页。 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { APP_ROOT, loadConfig } from "../src/config.ts";
import { Store } from "../src/core/db.ts";
import { Logger } from "../src/core/logger.ts";
import { startApiServer } from "../src/api.ts";

const dir = path.join(APP_ROOT, ".scratch", "llm-logs-api");
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
fs.writeFileSync(path.join(dir, "sessions", "s1.jsonl"), [
  { type: "session", timestamp: "2026-11-12T07:00:00.000Z" },
  { type: "message", timestamp: "2026-11-12T07:00:01.000Z", message: { role: "user", content: "hi" } },
  { type: "message", timestamp: "2026-11-12T07:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "hello" }], model: "m" } },
].map((x) => JSON.stringify(x)).join("\n") + "\n");

const cfg = loadConfig({
  dataDir: dir,
  logDir: path.join(dir, "logs"),
  api: { enabled: true, port: 0, host: "127.0.0.1" },
  exec: { dir: path.join(dir, "sandbox") },
});
const store = new Store(":memory:");
const log = new Logger(null, true);
const token = "l".repeat(32);

let server: Awaited<ReturnType<typeof startApiServer>> = null;
let base = "";

test.before(async () => {
  server = await startApiServer({ cfg, store, log, token });
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
});

test.after(() => {
  server?.close();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const call = async (p: string) => {
  const res = await fetch(`${base}${p}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, body: await res.json() as any };
};

test("GET /v1/llm-logs：列表只回摘要", async () => {
  const r = await call("/v1/llm-logs?limit=10");
  assert.equal(r.status, 200);
  assert.equal(r.body.data.length, 1);
  assert.equal(r.body.data[0].id, "s1");
  assert.equal(r.body.data[0].messages, 2);
  assert.equal(r.body.data[0].preview, "hi");
});

test("GET /v1/llm-logs/:id：分页读取消息", async () => {
  const r = await call("/v1/llm-logs/s1?limit=1");
  assert.equal(r.status, 200);
  assert.equal(r.body.data.total, 2);
  assert.equal(r.body.data.messages.length, 1);
  assert.equal(r.body.data.messages[0].text, "hello");
  assert.equal(r.body.data.next_before, 1);

  const older = await call("/v1/llm-logs/s1?limit=1&before=1");
  assert.equal(older.body.data.messages[0].text, "hi");
  assert.equal(older.body.data.next_before, null);
});

test("GET /v1/llm-logs/:id：不存在 / 非法 id 404", async () => {
  assert.equal((await call("/v1/llm-logs/nope")).status, 404);
  assert.equal((await call("/v1/llm-logs/..%2Fetc%2Fpasswd")).status, 404);
});
