import { useMemo } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { delimiterFor, parseDelimited } from "../../lib/csv.ts";
import type { OutputFile, OutputNode } from "../../lib/types.ts";

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

export const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "avif", "svg", "ico"]);

export function formatBytes(bytes: number | undefined): string {
  const n = Number(bytes ?? 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function extOf(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return ext === name.toLowerCase() ? "" : ext;
}

export function countFiles(nodes: OutputNode[]): number {
  return nodes.reduce(
    (n, node) => n + (node.kind === "file" ? 1 : countFiles(node.children ?? [])),
    0,
  );
}

export function firstFile(nodes: OutputNode[]): OutputNode | null {
  for (const node of nodes) {
    if (node.kind === "file") return node;
    const child = firstFile(node.children ?? []);
    if (child) return child;
  }
  return null;
}

export function flattenFiles(nodes: OutputNode[], out: OutputNode[] = []): OutputNode[] {
  for (const node of nodes) {
    if (node.kind === "file") out.push(node);
    else flattenFiles(node.children ?? [], out);
  }
  return out;
}

/** outputs/task-<id>/... 归属的任务 id；不是任务目录返回 null */
export function taskIdOfOutput(path: string): number | null {
  const m = /^task-(\d+)(?:\/|$)/.exec(path);
  return m ? Number(m[1]) : null;
}

export function MarkdownBlock({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => {
    const raw = marked.parse(text, { gfm: true, async: false }) as string;
    return DOMPurify.sanitize(raw);
  }, [text]);
  return (
    <div
      className={
        className ?? "rb-markdown rounded-[12px] border border-border bg-surface px-5 py-4 text-[13.5px]"
      }
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function CsvPreview({ text, ext }: { text: string; ext: string }) {
  const table = useMemo(() => parseDelimited(text, delimiterFor(ext, text)), [text, ext]);
  if (!table.rows.length) return <p className="text-[13px] text-muted">空文件。</p>;
  const [header, ...body] = table.rows;
  return (
    <div className="min-w-0">
      <div className="rb-thin-scroll max-h-[calc(100dvh-260px)] overflow-auto rounded-[12px] border border-border bg-surface">
        <table className="w-full border-collapse text-[12.5px]">
          <thead className="sticky top-0 z-[1] bg-surface2">
            <tr>
              {header.map((cell, i) => (
                <th
                  key={i}
                  className="whitespace-nowrap border-b border-r border-border px-2.5 py-2 text-left text-[10.5px] font-semibold uppercase tracking-[0.05em] text-muted last:border-r-0"
                >
                  {cell || "—"}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((row, ri) => (
              <tr key={ri} className="align-top transition hover:bg-accent-soft/30">
                {row.map((cell, ci) => (
                  <td
                    key={ci}
                    title={cell}
                    className="max-w-[420px] whitespace-pre-wrap break-words border-b border-r border-border px-2.5 py-1.5 last:border-r-0"
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {table.truncated && <p className="mt-2 text-xs text-muted">文件较大，仅预览前 5000 行。</p>}
    </div>
  );
}

export function FilePreview({ file, imageUrl }: { file: OutputFile; imageUrl?: string }) {
  if (IMAGE_EXTS.has(file.ext)) {
    if (!imageUrl) return <p className="text-[13px] text-muted">图片加载中…</p>;
    return (
      <div className="overflow-hidden rounded-[12px] border border-border bg-surface p-2">
        <img
          src={imageUrl}
          alt={file.name}
          className="mx-auto max-h-[calc(100dvh-260px)] max-w-full rounded-[8px] object-contain"
        />
      </div>
    );
  }
  if (file.binary) {
    return (
      <div className="rounded-[10px] border border-border bg-surface2 px-4 py-8 text-center text-[13px] text-muted">
        二进制文件，暂不支持预览（{formatBytes(file.bytes)}）。
      </div>
    );
  }
  const ext = file.ext;
  const header = file.truncated ? (
    <p className="mb-2 rounded-[8px] border border-amber/40 bg-amber-soft px-2.5 py-1.5 text-xs text-amber">
      文件较大，仅预览前 2 MB。
    </p>
  ) : null;

  if (ext === "md" || ext === "markdown") {
    return (
      <div>
        {header}
        <MarkdownBlock text={file.content} />
      </div>
    );
  }
  if (ext === "csv" || ext === "tsv") {
    return (
      <div>
        {header}
        <CsvPreview text={file.content} ext={ext} />
      </div>
    );
  }
  if (ext === "html" || ext === "htm") {
    return (
      <div>
        {header}
        <p className="mb-2 text-[11.5px] text-muted">
          iframe 沙箱预览：脚本在隔离环境里运行，不影响管理台。
        </p>
        <iframe
          title={`HTML 预览：${file.name}`}
          sandbox="allow-scripts allow-forms allow-popups"
          referrerPolicy="no-referrer"
          srcDoc={file.content}
          className="h-[calc(100dvh-260px)] min-h-[320px] w-full rounded-[12px] border border-border bg-white"
        />
      </div>
    );
  }
  return (
    <div>
      {header}
      <pre className="rb-thin-scroll max-h-[calc(100dvh-260px)] overflow-auto whitespace-pre-wrap wrap-anywhere rounded-[12px] border border-border bg-surface p-3.5 font-mono text-[11.5px] leading-[1.7]">
        {file.content}
      </pre>
    </div>
  );
}
