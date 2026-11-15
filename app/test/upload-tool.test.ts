/** upload：只收沙盒相对路径、50MB 本地拦截、返回一行 URL，凭据只从框架环境变量读。 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTools } from "../src/agent/tools.ts";
import { Store } from "../src/core/db.ts";
import { loadConfig } from "../src/config.ts";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-upload-"));
  const runtime = path.join(dir, "runtime");
  fs.mkdirSync(path.join(runtime, "files"), { recursive: true });
  const cfg = loadConfig({
    runtimeDir: runtime,
    dataDir: path.join(dir, "data"),
    logDir: path.join(dir, "logs"),
    exec: { dir: runtime, shell: { mode: "docker" } },
  });
  const tools = createTools({
    store: new Store(":memory:"), hub: {} as any, cfg, now: () => Date.now(),
    profile: "ufa", readRoot: runtime,
  }) as any[];
  const tool = tools.find((t) => t.name === "upload");
  return { dir, runtime, tool, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function saveEnv() {
  return { url: process.env.TOS_SHORT_URL, token: process.env.TOS_SHORT_TOKEN };
}

function restoreEnv(old: ReturnType<typeof saveEnv>) {
  if (old.url === undefined) delete process.env.TOS_SHORT_URL; else process.env.TOS_SHORT_URL = old.url;
  if (old.token === undefined) delete process.env.TOS_SHORT_TOKEN; else process.env.TOS_SHORT_TOKEN = old.token;
}

const text = (r: any): string => r.content.map((c: any) => c.text ?? "").join("");

test("没配 TOS_SHORT_URL / TOKEN：直接报没配好，不翻文件", async () => {
  const old = saveEnv();
  delete process.env.TOS_SHORT_URL;
  delete process.env.TOS_SHORT_TOKEN;
  const s = setup();
  try {
    const r = await s.tool.execute("u1", { path: "files/a.txt" });
    assert.equal(r.details?.ok, false);
    assert.match(text(r), /上传没配好/);
  } finally {
    restoreEnv(old);
    s.cleanup();
  }
});

test("上传成功：一行 URL，文件名和二进制正文按服务端约定发", async () => {
  const old = saveEnv();
  process.env.TOS_SHORT_URL = "https://s.hollway.top/";
  process.env.TOS_SHORT_TOKEN = "test-token";
  const s = setup();
  const origFetch = globalThis.fetch;
  const calls: { url: string; init: any }[] = [];
  globalThis.fetch = (async (url: string, init: any) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({
      url: "https://s.hollway.top/ab3Kd9.txt", key: "files/ab3Kd9.txt", size: 5,
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    fs.writeFileSync(path.join(s.runtime, "files", "a.txt"), "hello");
    const r = await s.tool.execute("u2", { path: "files/a.txt" });
    assert.equal(r.details?.ok, true, text(r));
    assert.equal(text(r), "https://s.hollway.top/ab3Kd9.txt", "只回一行 URL，不裹 JSON");
    assert.equal(r.details?.bytes, 5);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://s.hollway.top/u");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.headers.Authorization, "Bearer test-token");
    assert.equal(calls[0].init.headers["X-Filename"], "a.txt");
    assert.equal(Buffer.from(calls[0].init.body).toString(), "hello");
  } finally {
    globalThis.fetch = origFetch;
    restoreEnv(old);
    s.cleanup();
  }
});

test("路径边界：目录、..、绝对路径、指向外部的软链都拒绝", async () => {
  const old = saveEnv();
  process.env.TOS_SHORT_URL = "https://s.hollway.top";
  process.env.TOS_SHORT_TOKEN = "test-token";
  const s = setup();
  const origFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched += 1;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    fs.writeFileSync(path.join(s.runtime, "files", "a.txt"), "hello");
    fs.writeFileSync(path.join(s.dir, "outside.txt"), "secret");
    fs.mkdirSync(path.join(s.runtime, "files", "sub"));
    fs.symlinkSync(path.join(s.dir, "outside.txt"), path.join(s.runtime, "files", "link.txt"));

    for (const bad of ["files/sub", "../outside.txt", path.join(s.dir, "outside.txt"), "files/link.txt"]) {
      const r = await s.tool.execute("u3", { path: bad });
      assert.equal(r.details?.ok, false, `应拒绝：${bad}`);
      assert.match(text(r), /路径不对|这是目录/, `错误要说人话：${text(r)}`);
    }
    assert.equal(fetched, 0, "边界检查没过就不该发请求");
  } finally {
    globalThis.fetch = origFetch;
    restoreEnv(old);
    s.cleanup();
  }
});

test("超过 50MB：本地先拦，不发给服务端", async () => {
  const old = saveEnv();
  process.env.TOS_SHORT_URL = "https://s.hollway.top";
  process.env.TOS_SHORT_TOKEN = "test-token";
  const s = setup();
  const origFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched += 1;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    const big = path.join(s.runtime, "files", "big.bin");
    fs.writeFileSync(big, "");
    fs.truncateSync(big, 50 * 1024 * 1024 + 1);
    const r = await s.tool.execute("u4", { path: "files/big.bin" });
    assert.equal(r.details?.ok, false);
    assert.match(text(r), /文件太大/);
    assert.equal(fetched, 0);
  } finally {
    globalThis.fetch = origFetch;
    restoreEnv(old);
    s.cleanup();
  }
});

test("服务端报错：把状态和原因说清楚", async () => {
  const old = saveEnv();
  process.env.TOS_SHORT_URL = "https://s.hollway.top";
  process.env.TOS_SHORT_TOKEN = "wrong";
  const s = setup();
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })) as typeof fetch;
  try {
    fs.writeFileSync(path.join(s.runtime, "files", "a.txt"), "hello");
    const r = await s.tool.execute("u5", { path: "files/a.txt" });
    assert.equal(r.details?.ok, false);
    assert.match(text(r), /401/);
    assert.match(text(r), /unauthorized/);
  } finally {
    globalThis.fetch = origFetch;
    restoreEnv(old);
    s.cleanup();
  }
});
