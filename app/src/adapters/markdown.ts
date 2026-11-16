/**
 * 出站文本 → Matrix 富文本。
 *
 * 为什么需要：Matrix 的 `m.text` 只认 `body`，Element 不会替我们渲染 markdown——
 * 于是 `**加粗**` 会原样显示成星号。飞书那条通道早就做了「命中 markdown 才走富文本」
 * 的判断（`adapters/feishu.ts` 的 `looksLikeMarkdown`），这里把同一套判断搬到 Matrix：
 * 命中就带 `format: org.matrix.custom.html` + `formatted_body`，没命中保持纯文本
 * （纯文本里出现 `*`、`_`、`#` 这类字符时不会被误伤）。
 *
 * 覆盖聊天里真的会出现的语法：粗体 / 斜体 / 删除线 / 行内代码 / 代码块 /
 * 标题 / 无序与有序列表 / 引用 / 链接。表格不转（Element 对 tables 支持不稳，
 * 原样留成文本比转坏更安全）。
 */

export { looksLikeMarkdown } from "./feishu.ts";

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;");
}

const FENCE = /```([^\n`]*)\n([\s\S]*?)```/g;
const INLINE_CODE = /`([^`\n]+)`/g;
const BLOCK_MARK = /^\u0000B(\d+)\u0000$/;

/** 行内语法 → HTML。输入已转义，占位符（\u0000 包围）不会被转义破坏。 */
function inline(segment: string): string {
  let out = segment.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label: string, url: string) =>
    `<a href="${escapeAttr(url)}">${escapeHtml(label)}</a>`,
  );
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
  out = out.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
  out = out.replace(/(^|[^\w*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  out = out.replace(/(^|[^\w_])_([^_\n]+)_(?![\w])/g, "$1<em>$2</em>");
  return out;
}

function renderLines(text: string, blocks: string[]): string {
  const out: string[] = [];
  let para: string[] = [];
  let list: { kind: "ul" | "ol"; items: string[] } | null = null;

  const flushPara = () => {
    if (!para.length) return;
    out.push(`<p>${para.map(inline).join("<br/>")}</p>`);
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    out.push(`<${list.kind}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list.kind}>`);
    list = null;
  };

  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    const block = BLOCK_MARK.exec(line);
    if (block) {
      flushPara();
      flushList();
      out.push(blocks[Number(block[1])]);
      continue;
    }
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      flushList();
      const level = Math.min(heading[1].length + 2, 6); // # → h3，别在聊天里放大到 h1
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      flushPara();
      flushList();
      out.push(`<blockquote>${inline(quote[1])}</blockquote>`);
      continue;
    }
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (ul || ol) {
      flushPara();
      const kind = ul ? "ul" : "ol";
      if (!list || list.kind !== kind) {
        flushList();
        list = { kind, items: [] };
      }
      list.items.push((ul ?? ol)![1]);
      continue;
    }
    if (list) flushList();
    para.push(escapeHtml(line));
  }
  flushPara();
  flushList();
  return out.join("");
}

export function markdownToHtml(text: string): string {
  const blocks: string[] = [];
  const spans: string[] = [];
  let src = text.replace(FENCE, (_m, lang: string, code: string) => {
    const cls = lang.trim() ? ` class="language-${escapeAttr(lang.trim())}"` : "";
    blocks.push(`<pre><code${cls}>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`);
    return `\u0000B${blocks.length - 1}\u0000`;
  });
  src = src.replace(INLINE_CODE, (_m, code: string) => {
    spans.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000S${spans.length - 1}\u0000`;
  });

  return renderLines(src, blocks).replace(/\u0000S(\d+)\u0000/g, (_m, i: string) => spans[Number(i)]);
}
