import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTools } from "../src/agent/tools.ts";
import { Store } from "../src/core/db.ts";
import { loadConfig } from "../src/config.ts";

// 这两个工具读 DEEPSEEK_API_KEY；测试不依赖外部 env（有专门用例临时删它）。
process.env.DEEPSEEK_API_KEY ||= "sk-test-placeholder";

function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-bot-wf-"));
  const cfg = { ...loadConfig(), dataDir };
  const tools = createTools({ store: new Store(":memory:"), hub: {} as any, cfg, now: () => Date.now() });
  return { tool: (tools as any[]).find((t) => t.name === "web_fetch") };
}

async function withFetch<T>(impl: (url: string, init: any) => Promise<any>, fn: (last: () => any) => Promise<T>): Promise<T> {
  const orig = (globalThis as any).fetch;
  let last: any = null;
  (globalThis as any).fetch = async (url: string, init: any) => { last = { url, init, body: JSON.parse(init.body) }; return impl(url, init); };
  try { return await fn(() => last); } finally { (globalThis as any).fetch = orig; }
}

const ok = (body: any, status = 200) => async () => ({
  ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body),
});

test("web_fetch：返回标题和正文，打到 /v1/tools/fetch", async () => {
  const { tool } = setup();
  await withFetch(ok({ title: "示例标题", content: "# 正文\n\n第一段\n\n\n\n第二段" }), async (last) => {
    const r = await tool.execute("c1", { url: "https://ex.com/a" });
    const text = r.content[0].text as string;
    assert.match(text, /标题：示例标题/);
    assert.match(text, /第一段/);
    assert.match(text, /第二段/);
    assert.equal(r.details.ok, true);
    const req = last();
    assert.equal(req.url, "https://api.deepseek.com/v1/tools/fetch");
    assert.equal(req.body.url, "https://ex.com/a");
  });
});

test("web_fetch：超长正文截断并标注", async () => {
  const { tool } = setup();
  await withFetch(ok({ title: "长文", content: "字".repeat(9000) }), async () => {
    const r = await tool.execute("c1", { url: "https://ex.com/long" });
    assert.equal((r.content[0].text as string).includes("字".repeat(6001)), false);
    assert.match(r.content[0].text as string, /正文已截断/);
    assert.equal(r.details.truncated, true);
  });
});

test("web_fetch：非法链接本地就拦掉，不发请求", async () => {
  const { tool } = setup();
  for (const bad of ["not-a-url", "ftp://ex.com/a", "https://user:pw@ex.com/a", ""]) {
    const r = await tool.execute("c1", { url: bad });
    assert.match(r.content[0].text as string, /链接不合法/, `应当拒绝 ${JSON.stringify(bad)}`);
  }
});

test("web_fetch：HTTP 错误兜成文本", async () => {
  const { tool } = setup();
  await withFetch(ok({ error: "nope" }, 404), async () => {
    const r = await tool.execute("c1", { url: "https://ex.com/404" });
    assert.match(r.content[0].text as string, /抓取失败：HTTP 404/);
    assert.equal(r.details.ok, false);
  });
});

test("web_fetch：没有正文时说明白", async () => {
  const { tool } = setup();
  await withFetch(ok({ title: "空页", content: "" }), async () => {
    const r = await tool.execute("c1", { url: "https://ex.com/empty" });
    assert.match(r.content[0].text as string, /没有正文/);
  });
});

test("web_fetch：异常被兜住", async () => {
  const { tool } = setup();
  await withFetch(async () => { throw new Error("net down"); }, async () => {
    const r = await tool.execute("c1", { url: "https://ex.com/x" });
    assert.match(r.content[0].text as string, /抓取失败：net down/);
  });
});
