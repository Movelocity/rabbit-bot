/** REST API 的契约：鉴权、路由、返回体、沙盒文件边界。 */
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-api-"));
const cfg = loadConfig({
  dataDir: dir,
  logDir: path.join(dir, "logs"),
  api: { enabled: true, port: 0, host: "127.0.0.1" },
  // 单测会合并线上 local.json，外部技能库要显式关掉，否则列的是本机真库
  exec: { dir: path.join(dir, "sandbox"), sharedSkillsDir: "" },
});
const store = new Store(path.join(dir, "test.db"));
const log = new Logger(null, true);
const token = "t".repeat(32);

let server: Awaited<ReturnType<typeof startApiServer>> = null;
let base = "";

test.before(async () => {
  store.insertMessage({
    platform: "feishu", external_chat_id: "c1", pool_kind: "private", msg_id: "m1",
    sender_id: "u1", sender_name: "小王", ts: Date.parse("2026-10-20T10:00:00+08:00"),
    text: "明天一起吃火锅", reply_to: null, mentions: [], is_mention_me: false, media_type: "text",
  });
  fs.mkdirSync(path.join(dir, "media"), { recursive: true });
  fs.mkdirSync(path.join(dir, "sandbox", "skills", "demo"), { recursive: true });
  fs.writeFileSync(path.join(dir, "sandbox", "skills", "demo", "SKILL.md"), "# demo\n");
  fs.writeFileSync(path.join(dir, "media", "a.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  server = await startApiServer({ cfg, store, log, token });
  const addr = server!.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

test.after(() => {
  server?.close();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const call = async (p: string, init: RequestInit & { auth?: string | null } = {}) => {
  const { auth, ...rest } = init;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth !== null) headers.authorization = auth ?? `Bearer ${token}`;
  const res = await fetch(`${base}${p}`, { ...rest, headers: { ...headers, ...(rest.headers as any) } });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, headers: res.headers };
};

test("没有 token / token 不对：401", async () => {
  assert.equal((await call("/v1/pools", { auth: null })).status, 401);
  assert.equal((await call("/v1/pools", { auth: "Bearer wrong-wrong-wrong" })).status, 401);
});

test("健康检查不需要 token", async () => {
  const r = await call("/health", { auth: null });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.status, "ok");
});

test("池：列表、读消息、搜索", async () => {
  const list = await call("/v1/pools");
  assert.equal(list.status, 200);
  assert.equal(list.body.data[0].alias, "p1");
  assert.equal(list.body.data[0].total, 1);

  const msgs = await call("/v1/pools/p1/messages?limit=5");
  assert.equal(msgs.status, 200);
  assert.match(JSON.stringify(msgs.body.data.messages), /火锅/);

  const found = await call("/v1/pools/p1/search?q=火锅");
  assert.equal(found.body.data.hits, 1);
  const tooShort = await call("/v1/pools/p1/search?q=火");
  assert.equal(tooShort.status, 400);
});

test("计划：写、列、改状态", async () => {
  const add = await call("/v1/plans", {
    method: "POST",
    body: JSON.stringify({ title: "问他结果", kind: "once", when: "2030-01-01T10:00", pool: "p1" }),
  });
  assert.equal(add.status, 201, JSON.stringify(add.body));
  const id = add.body.data.id;

  const list = await call("/v1/plans");
  assert.ok(list.body.data.some((p: any) => p.id === id && p.title === "问他结果"));

  const done = await call(`/v1/plans/${id}`, { method: "PATCH", body: JSON.stringify({ status: "done" }) });
  assert.equal(done.status, 200);
  assert.equal(done.body.data.status, "done");

  const bad = await call("/v1/plans/99999", { method: "PATCH", body: JSON.stringify({ status: "done" }) });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /没有计划/);
});

test("记忆：写、查；scope 按池类型推导", async () => {
  const add = await call("/v1/memories", {
    method: "POST",
    body: JSON.stringify({ user: "u1", content: "他对花生过敏", pool: "p1" }),
  });
  assert.equal(add.status, 201);
  assert.equal(add.body.data.scope, "private");

  const found = await call("/v1/memories?user=u1&pool=p1");
  assert.equal(found.body.data.length, 1);
  assert.equal(found.body.data[0].content, "他对花生过敏");
});

test("技能：列出设计文件和数据目录", async () => {
  const r = await call("/v1/skills");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data, [{ name: "demo", description: "", skill: "skills/demo/SKILL.md", data: "skills/demo/data", has_data: false, readonly: false }]);
});

test("沙盒文件：写读、越界拒绝", async () => {
  const put = await call("/v1/sandbox/file?path=notes/todo.md", {
    method: "PUT",
    body: JSON.stringify({ content: "- 买菜" }),
  });
  assert.equal(put.status, 200, JSON.stringify(put.body));

  const got = await call("/v1/sandbox/file?path=notes/todo.md");
  assert.equal(got.body.data.content, "- 买菜");

  const listed = await call("/v1/sandbox/files?path=notes");
  assert.match(JSON.stringify(listed.body.data), /todo\.md/);

  const escape = await call("/v1/sandbox/file?path=../../etc/passwd", { method: "PUT", body: JSON.stringify({ content: "x" }) });
  assert.equal(escape.status, 400);
});

test("图片：列表与原始字节，越界拒绝", async () => {
  const list = await call("/v1/images?source=inbox");
  assert.equal(list.status, 200);

  const raw = await fetch(`${base}/v1/images/file?path=media/a.png`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(raw.status, 200);
  assert.equal(raw.headers.get("content-type"), "image/png");
  assert.equal((await raw.arrayBuffer()).byteLength, 4);

  const escape = await call("/v1/images/file?path=../test.db");
  assert.equal(escape.status, 400);
});

test("未知路由 404，缺 token 时也不泄露路由", async () => {
  assert.equal((await call("/v1/nope")).status, 404);
  assert.equal((await call("/v1/nope", { auth: null })).status, 401);
});
