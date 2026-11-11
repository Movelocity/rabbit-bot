/** 沙盒里的 rb 客户端：业务走 API，文件和 shell 直接操作 cwd。 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/core/db.ts";
import { Logger } from "../src/core/logger.ts";
import { startApiServer } from "../src/api.ts";
import { resolveApiToken } from "../src/api-token.ts";

const execFileAsync = promisify(execFile);
const APP = path.resolve(import.meta.dirname, "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-client-"));
const sandbox = path.join(dir, "sandbox");
fs.mkdirSync(sandbox, { recursive: true });

const cfg = loadConfig({
  dataDir: dir,
  logDir: path.join(dir, "logs"),
  runtimeDir: path.join(dir, "runtime"),
  exec: { dir: sandbox },
  api: { enabled: true, port: 0, host: "127.0.0.1" },
});
const store = new Store(path.join(dir, "test.db"));
const token = resolveApiToken(cfg);
let server: Awaited<ReturnType<typeof startApiServer>> = null;
let env: NodeJS.ProcessEnv = {};

test.before(async () => {
  store.insertMessage({
    platform: "feishu", external_chat_id: "c1", pool_kind: "private", msg_id: "m1",
    sender_id: "u1", sender_name: "小王", ts: Date.now(), text: "明天吃火锅",
    reply_to: null, mentions: [], is_mention_me: false, media_type: "text",
  });
  server = await startApiServer({ cfg, store, log: new Logger(null, true), token });
  const port = (server!.address() as AddressInfo).port;
  env = { ...process.env, RB_API_URL: `http://127.0.0.1:${port}`, RB_API_TOKEN: token, RB_NOW: "1792627200000" };
});

test.after(() => {
  server?.close();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function rb(...args: string[]) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [path.join(APP, "docker", "rb.mjs"), ...args], { cwd: sandbox, env });
    return { code: 0, body: JSON.parse(stdout) };
  } catch (e) {
    const err = e as { code?: number; stdout?: string };
    return { code: err.code ?? 1, body: JSON.parse(err.stdout ?? "{}") };
  }
}

test("pool-list：走 API 拿 JSON", async () => {
  const r = await rb("pool-list");
  assert.equal(r.code, 0);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.data[0].alias, "p1");
});

test("pool-search：命中，关键词太短退出码 1", async () => {
  const hit = await rb("pool-search", "火锅", "--pool", "p1");
  assert.equal(hit.body.data.hits, 1);
  const bad = await rb("pool-search", "火", "--pool", "p1");
  assert.equal(bad.code, 1);
  assert.match(bad.body.error, /至少两个字/);
});

test("plan-add → plan-list → plan-check → plan-archive", async () => {
  const add = await rb("plan-add", "--title", "问他结果", "--background", "他周三出结果", "--goals", "问他,记结果");
  assert.equal(add.code, 0, JSON.stringify(add.body));
  const slug = add.body.data.slug;

  const list = await rb("plan-list", "--status", "all");
  assert.ok(list.body.data.some((p: any) => p.slug === slug));

  const check = await rb("plan-check", slug, "1");
  assert.equal(check.body.data.goals[0].done, true);

  const archived = await rb("plan-archive", slug);
  assert.equal(archived.body.data.status, "archived");
});

test("mem-add → mem-search", async () => {
  const add = await rb("mem-add", "--user", "u1", "--content", "他对花生过敏", "--pool", "p1");
  assert.equal(add.code, 0);
  assert.equal(add.body.data.scope, "private");
  const found = await rb("mem-search", "--user", "u1", "--pool", "p1");
  assert.equal(found.body.data[0].content, "他对花生过敏");
});

test("sb：写/读/列/跑命令都在当前沙盒", async () => {
  const put = await rb("sb", "write", "notes/todo.md", "--content", "- 买菜");
  assert.equal(put.code, 0, JSON.stringify(put.body));
  assert.equal(fs.readFileSync(path.join(sandbox, "notes", "todo.md"), "utf8"), "- 买菜");

  const got = await rb("sb", "read", "notes/todo.md");
  assert.equal(got.body.data.content, "- 买菜");

  const listed = await rb("sb", "list", "notes");
  assert.ok(listed.body.data.some((e: any) => e.name === "notes/todo.md"));

  const ran = await rb("sb", "run", "echo hi && pwd -P");
  assert.equal(ran.code, 0);
  assert.match(ran.body.data.output, /hi/);
  assert.equal(ran.body.data.output.trim().split("\n").pop(), fs.realpathSync(sandbox));
});

test("sb 拒绝绝对路径和 ../ 越界", async () => {
  for (const p of ["/etc/passwd", "../outside.txt"]) {
    const r = await rb("sb", "read", p);
    assert.equal(r.code, 1, `应拒绝 ${p}`);
    assert.match(r.body.error, /相对|越界/);
  }
});

test("未知命令退出码 1", async () => {
  const r = await rb("frobnicate");
  assert.equal(r.code, 1);
  assert.match(r.body.error, /没有这个命令/);
});

test("没有 API 地址时明确报错", async () => {
  const old = env.RB_API_URL;
  delete env.RB_API_URL;
  try {
    const r = await rb("pool-list");
    assert.equal(r.code, 1);
    assert.match(r.body.error, /RB_API_URL/);
  } finally {
    env.RB_API_URL = old;
  }
});
