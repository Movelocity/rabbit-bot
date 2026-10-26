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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-bot-ws-"));
  const cfg = { ...loadConfig(), dataDir };
  const tools = createTools({ store: new Store(":memory:"), hub: {} as any, cfg, now: () => Date.now() });
  const tool = (tools as any[]).find((t) => t.name === "web_search");
  return { tool };
}

/** 替换全局 fetch，记下最后一次请求，跑完还原。 */
async function withFetch<T>(impl: (url: string, init: any) => Promise<any>, fn: (last: () => any) => Promise<T>): Promise<T> {
  const orig = (globalThis as any).fetch;
  let last: any = null;
  (globalThis as any).fetch = async (url: string, init: any) => { last = { url, init, body: JSON.parse(init.body) }; return impl(url, init); };
  try { return await fn(() => last); } finally { (globalThis as any).fetch = orig; }
}

const okJson = (body: any, status = 200) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const hits = (n: number) => Array.from({ length: n }, (_, i) => ({
  rerank_score: 2.7 - i * 0.1, title: `标题${i + 1}`, url: `https://ex.com/${i + 1}`,
  snippet: `摘要${i + 1}`, summary: `长摘要${i + 1}`, content: `正文${i + 1}`,
  site_name: "示例站", date: "2026-10-20T00:00:00+00:00", authority: i === 0 ? 3 : 1,
}));

test("web_search：正常结果给出标题、链接、站点、日期、长摘要", async () => {
  const { tool } = setup();
  await withFetch(okJson({ results: hits(2) }), async (last) => {
    const r = await tool.execute("c1", { query: "DeepSeek V4.1", count: 2 });
    const text = r.content[0].text as string;
    assert.match(text, /标题1/);
    assert.match(text, /https:\/\/ex\.com\/1/);
    assert.match(text, /示例站/);
    assert.match(text, /2026-10-20/);
    assert.match(text, /权威/);
    assert.match(text, /长摘要1/);          // 默认用 summary 而非 snippet
    assert.doesNotMatch(text, /^摘要1$/m);   // 不是短摘要
    assert.equal(r.details.hits, 2);
    const req = last();
    assert.equal(req.url, "https://api.deepseek.com/v1/tools/search");
    assert.equal(req.body.query, "DeepSeek V4.1");
    assert.equal(req.body.count, 2);
    assert.equal(req.body.need_content, false);
    assert.match(req.init.headers.authorization, /^Bearer /);
  });
});

test("web_search：count 越界被夹到 1-10，缺省 6", async () => {
  const { tool } = setup();
  await withFetch(okJson({ results: hits(1) }), async (last) => {
    await tool.execute("c1", { query: "x", count: 99 });
    assert.equal(last().body.count, 10);
    await tool.execute("c2", { query: "x", count: 0 });
    assert.equal(last().body.count, 6);
    await tool.execute("c3", { query: "x" });
    assert.equal(last().body.count, 6);
  });
});

test("web_search：with_content 时用正文，且请求体 need_content=true", async () => {
  const { tool } = setup();
  await withFetch(okJson({ results: hits(1) }), async (last) => {
    const r = await tool.execute("c1", { query: "x", with_content: true });
    assert.equal(last().body.need_content, true);
    assert.match(r.content[0].text as string, /正文1/);
  });
});

test("web_search：HTTP 错误返回失败文本而不是抛出", async () => {
  const { tool } = setup();
  await withFetch(okJson({ error: "bad" }, 500), async () => {
    const r = await tool.execute("c1", { query: "x" });
    assert.match(r.content[0].text as string, /搜索失败：HTTP 500/);
    assert.equal(r.details.ok, false);
  });
});

test("web_search：空语义化查询直接拒绝", async () => {
  const { tool } = setup();
  const r = await tool.execute("c1", { query: "   " });
  assert.match(r.content[0].text as string, /搜索词不能为空/);
});

test("web_search：没有 API key 时明确说不可用", async () => {
  const { tool } = setup();
  const old = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    const r = await tool.execute("c1", { query: "x" });
    assert.match(r.content[0].text as string, /DEEPSEEK_API_KEY/);
  } finally {
    if (old !== undefined) process.env.DEEPSEEK_API_KEY = old;
  }
});

test("web_search：零结果说明白，不算错误", async () => {
  const { tool } = setup();
  await withFetch(okJson({ results: [] }), async () => {
    const r = await tool.execute("c1", { query: "找不到的东西" });
    assert.match(r.content[0].text as string, /没搜到结果/);
    assert.equal(r.details.hits, 0);
  });
});

test("web_search：网络异常被兜住", async () => {
  const { tool } = setup();
  await withFetch(async () => { throw new Error("boom"); }, async () => {
    const r = await tool.execute("c1", { query: "x" });
    assert.match(r.content[0].text as string, /搜索失败：boom/);
  });
});

test("web_search：坏数据（缺 title/url）被过滤掉", async () => {
  const { tool } = setup();
  await withFetch(okJson({ results: [{ title: "有标题没链接" }, { url: "https://ok.com", title: "完整", summary: "S" }] }), async () => {
    const r = await tool.execute("c1", { query: "x" });
    const text = r.content[0].text as string;
    assert.doesNotMatch(text, /有标题没链接/);
    assert.match(text, /完整/);
    assert.equal(r.details.hits, 1);
  });
});
