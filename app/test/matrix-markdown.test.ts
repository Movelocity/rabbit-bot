/**
 * 出站 markdown → Matrix 富文本。
 *
 * 两条边界最要紧：
 * ①只有命中标记才带 formatted_body，纯文本绝不被改写（正文里有 * _ # 是常态）；
 * ②HTML 必须转义，`<script>` 这类东西不能原样进 formatted_body。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { markdownToHtml, escapeHtml, looksLikeMarkdown } from "../src/adapters/markdown.ts";
import { MatrixAdapter } from "../src/adapters/matrix.ts";

const logger = { info() {}, warn() {}, error() {}, debug() {} } as any;

function fakeFetch(handler: (url: string, init: any) => any) {
  const calls: { url: string; method: string; body: any }[] = [];
  (globalThis as any).fetch = async (url: string, init: any = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init.method ?? "GET", body });
    const out = handler(url, init) ?? {};
    const status = out.__status ?? 200;
    return { ok: status < 400, status, text: async () => JSON.stringify(out) } as any;
  };
  return calls;
}

function adapter() {
  const calls = fakeFetch((url) => (url.includes("/send/m.room.message/") ? { event_id: "$sent" } : {}));
  const a = new MatrixAdapter(
    { homeserver: "https://mx.test", userId: "@xiaoyu:mx.test", accessToken: "t", stateFile: "/tmp/mx-md-state.json" },
    logger,
  );
  return { a, calls };
}

test("markdown：粗体/斜体/行内代码", () => {
  assert.equal(markdownToHtml("**加粗**"), "<p><strong>加粗</strong></p>");
  assert.equal(markdownToHtml("*斜*"), "<p><em>斜</em></p>");
  assert.equal(markdownToHtml("按 `npm test` 跑"), "<p>按 <code>npm test</code> 跑</p>");
});

test("markdown：代码块独占一块，里面的星号不当粗体", () => {
  const html = markdownToHtml("先看\n```bash\nnpm run build **x**\n```\n再看");
  assert.match(html, /<pre><code class="language-bash">npm run build \*\*x\*\*<\/code><\/pre>/);
  assert.match(html, /<p>先看<\/p>/);
  assert.match(html, /<p>再看<\/p>/);
});

test("markdown：列表、引用、标题、链接", () => {
  assert.equal(markdownToHtml("- 甲\n- 乙"), "<ul><li>甲</li><li>乙</li></ul>");
  assert.equal(markdownToHtml("1. 甲\n2. 乙"), "<ol><li>甲</li><li>乙</li></ol>");
  assert.equal(markdownToHtml("> 引用"), "<blockquote>引用</blockquote>");
  assert.equal(markdownToHtml("## 小节"), "<h4>小节</h4>");
  assert.equal(
    markdownToHtml("看[文档](https://example.com/a?b=1)"),
    '<p>看<a href="https://example.com/a?b=1">文档</a></p>',
  );
});

test("markdown：HTML 必须转义", () => {
  assert.equal(escapeHtml('<script>"&"'), "&lt;script&gt;\"&amp;\"");
  const html = markdownToHtml("**<img src=x onerror=alert(1)>**");
  assert.ok(!html.includes("<img"), html);
  assert.match(html, /&lt;img/);
});

test("markdown：纯文本保持原样，不进 <p> 以外的结构", () => {
  assert.equal(markdownToHtml("今天降温了，多穿点"), "<p>今天降温了，多穿点</p>");
  assert.equal(looksLikeMarkdown("12 * 3 = 36"), false);
  assert.equal(looksLikeMarkdown("**真的**"), true);
});

test("Matrix：命中 markdown 才带 formatted_body，纯文本只发 body", async () => {
  const { a, calls } = adapter();
  await a.sendText("!r:mx.test", "**加粗**");
  await a.sendText("!r:mx.test", "普通一句话");
  const sends = calls.filter((c) => c.url.includes("/send/m.room.message/"));
  assert.equal(sends.length, 2);
  assert.deepEqual(sends[0].body, {
    msgtype: "m.text",
    body: "**加粗**",
    format: "org.matrix.custom.html",
    formatted_body: "<p><strong>加粗</strong></p>",
  });
  assert.deepEqual(sends[1].body, { msgtype: "m.text", body: "普通一句话" });
  // body 必须保留原文：客户端不支持 HTML 时靠它兜底
  assert.equal(sends[0].body.body, "**加粗**");
});
