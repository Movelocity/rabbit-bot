/** 抓网页正文（ops/web）：API 和沙盒 rb 客户端共用。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchWeb } from "../src/ops/web.ts";

process.env.DEEPSEEK_API_KEY ||= "sk-test-placeholder";

async function withFetch<T>(impl: (url: string, init: any) => Promise<any>, fn: (last: () => any) => Promise<T>): Promise<T> {
  const orig = (globalThis as any).fetch;
  let last: any = null;
  (globalThis as any).fetch = async (url: string, init: any) => { last = { url, init, body: JSON.parse(init.body) }; return impl(url, init); };
  try { return await fn(() => last); } finally { (globalThis as any).fetch = orig; }
}

const ok = (body: any, status = 200) => async () => ({
  ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body),
});

test("web-fetch：返回标题和正文，打到 /v1/tools/fetch", async () => {
  await withFetch(ok({ title: "示例标题", content: "# 正文\n\n第一段\n\n\n\n第二段" }), async (last) => {
    const r = await fetchWeb("https://ex.com/a");
    assert.equal(r.title, "示例标题");
    assert.match(r.content, /第一段/);
    assert.match(r.content, /第二段/);
    assert.equal(r.truncated, false);
    const req = last();
    assert.equal(req.url, "https://api.deepseek.com/v1/tools/fetch");
    assert.equal(req.body.url, "https://ex.com/a");
  });
});

test("web-fetch：超长正文截断到 6000 并标注", async () => {
  await withFetch(ok({ title: "长文", content: "字".repeat(9000) }), async () => {
    const r = await fetchWeb("https://ex.com/long");
    assert.equal(r.content.length, 6000);
    assert.equal(r.chars, 9000);
    assert.equal(r.truncated, true);
  });
});

test("web-fetch：非法链接本地就拦掉，不发请求", async () => {
  let called = false;
  await withFetch(async () => { called = true; throw new Error("should not"); }, async () => {
    for (const bad of ["not-a-url", "ftp://ex.com/a", "https://user:pw@ex.com/a", ""]) {
      await assert.rejects(() => fetchWeb(bad), /链接不合法|缺少 url/, `应当拒绝 ${JSON.stringify(bad)}`);
    }
  });
  assert.equal(called, false);
});

test("web-fetch：HTTP 错误抛出", async () => {
  await withFetch(ok({ error: "nope" }, 404), async () => {
    await assert.rejects(() => fetchWeb("https://ex.com/404"), /抓取失败 HTTP 404/);
  });
});

test("web-fetch：没有正文时返回空内容而不是编造", async () => {
  await withFetch(ok({ title: "空页", content: "" }), async () => {
    const r = await fetchWeb("https://ex.com/empty");
    assert.equal(r.content, "");
    assert.equal(r.chars, 0);
  });
});

test("web-fetch：网络异常原样抛出", async () => {
  await withFetch(async () => { throw new Error("net down"); }, async () => {
    await assert.rejects(() => fetchWeb("https://ex.com/x"), /net down/);
  });
});
