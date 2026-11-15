/** /v1/pools 未读角标：只算游标之后、非自己发、非系统留痕的消息。 */
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-unread-"));
const cfg = loadConfig({
  dataDir: dir,
  logDir: path.join(dir, "logs"),
  api: { enabled: true, port: 0, host: "127.0.0.1" },
  runtimeDir: path.join(dir, "runtime"),
  exec: { dir: path.join(dir, "sandbox") },
});
const store = new Store(path.join(dir, "test.db"));
const log = new Logger(null, true);
const token = "r".repeat(32);

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

const call = async (p: string) => {
  const res = await fetch(`${base}${p}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
};

const msg = (msg_id: string, text: string, extra: Record<string, unknown> = {}) => store.insertMessage({
  platform: "feishu", external_chat_id: "c-unread", pool_kind: "private", msg_id,
  sender_id: "u1", sender_name: "小王", ts: Date.now(), text,
  reply_to: null, mentions: [], is_mention_me: false, media_type: "text", ...extra,
});

test("池列表带 unread / cursor：自己发的和系统留痕不算未读", async () => {
  const first = msg("m1", "在吗")!;
  msg("m2", "吃了吗");
  msg("m3", "我发的", { from_self: true, sender_id: "bot" });
  msg("m4", "系统提示", { internal: true, sender_id: "system" });

  let r = await call("/v1/pools");
  assert.equal(r.status, 200);
  const pool = r.body.data[0];
  assert.equal(pool.unread, 2, JSON.stringify(pool));
  assert.equal(pool.cursor, 0);

  store.advanceCursor(pool.pool_id, first.seq);
  r = await call("/v1/pools");
  assert.equal(r.body.data[0].unread, 1);
  assert.equal(r.body.data[0].cursor, first.seq);

  store.advanceCursor(pool.pool_id, store.maxSeq(pool.pool_id));
  r = await call("/v1/pools");
  assert.equal(r.body.data[0].unread, 0);
});
