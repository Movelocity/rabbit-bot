/** 联网搜索（ops/web）：API 和沙盒 rb 客户端共用。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { searchWeb } from "../src/ops/web.ts";

// 读 DEEPSEEK_API_KEY；测试不依赖外部 env（有专门用例临时删它）。
process.env.DEEPSEEK_API_KEY ||= "sk-test-placeholder";

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

test("web-search：返回标题、链接、站点、日期、摘要", async () => {
  await withFetch(okJson({ results: hits(2) }), async (last) => {
    const rs = await searchWeb("DeepSeek V4.1", { count: 2 });
    assert.equal(rs.length, 2);
    assert.equal(rs[0].title, "标题1");
    assert.equal(rs[0].url, "https://ex.com/1");
    assert.equal(rs[0].site, "示例站");
    assert.equal(rs[0].date, "2026-10-20");
    assert.equal(rs[0].authority, 3);
    assert.equal(rs[0].summary, "长摘要1");
    const req = last();
    assert.equal(req.url, "https://api.deepseek.com/v1/tools/search");
    assert.equal(req.body.query, "DeepSeek V4.1");
    assert.equal(req.body.count, 2);
    assert.equal(req.body.need_content, false);
    assert.match(req.init.headers.authorization, /^Bearer /);
  });
});

test("web-search：count 越界被夹到 1-10，缺省 6", async () => {
  await withFetch(okJson({ results: hits(1) }), async (last) => {
    await searchWeb("x", { count: 99 });
    assert.equal(last().body.count, 10);
    await searchWeb("x", { count: 0 });
    assert.equal(last().body.count, 6);
    await searchWeb("x");
    assert.equal(last().body.count, 6);
  });
});

test("web-search：with_content 时额外给正文，请求体 need_content=true", async () => {
  await withFetch(okJson({ results: hits(1) }), async (last) => {
    const rs = await searchWeb("x", { content: true });
    assert.equal(last().body.need_content, true);
    assert.equal(rs[0].content, "正文1");
  });
});

test("web-search：HTTP 错误抛出", async () => {
  await withFetch(okJson({ error: "bad" }, 500), async () => {
    await assert.rejects(() => searchWeb("x"), /搜索失败 HTTP 500/);
  });
});

test("web-search：空查询直接拒绝", async () => {
  await assert.rejects(() => searchWeb("   "), /缺少查询词/);
});

test("web-search：没有 API key 时明确说不可用", async () => {
  // 光删 process.env 不够：loadEnvFile() 会去 ~/.config/rabbit-bot/env 把 key 捞回来，
  // 本机有那份文件的时候这条用例必然失败。把 HOME 指到空目录，才是真的「没有 key」。
  const oldKey = process.env.DEEPSEEK_API_KEY;
  const oldHome = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rb-nokey-"));
  delete process.env.DEEPSEEK_API_KEY;
  process.env.HOME = home;
  try {
    await assert.rejects(() => searchWeb("x"), /DEEPSEEK_API_KEY/);
  } finally {
    if (oldKey !== undefined) process.env.DEEPSEEK_API_KEY = oldKey;
    if (oldHome !== undefined) process.env.HOME = oldHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("web-search：零结果是空数组", async () => {
  await withFetch(okJson({ results: [] }), async () => {
    assert.deepEqual(await searchWeb("找不到的东西"), []);
  });
});

test("web-search：网络异常原样抛出", async () => {
  await withFetch(async () => { throw new Error("boom"); }, async () => {
    await assert.rejects(() => searchWeb("x"), /boom/);
  });
});

test("web-search：坏数据（缺 title/url）被过滤掉", async () => {
  await withFetch(okJson({ results: [{ title: "有标题没链接" }, { url: "https://ok.com", title: "完整", summary: "S" }] }), async () => {
    const rs = await searchWeb("x");
    assert.equal(rs.length, 1);
    assert.equal(rs[0].title, "完整");
  });
});
