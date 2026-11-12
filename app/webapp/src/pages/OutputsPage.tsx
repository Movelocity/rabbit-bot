import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { useApi } from "../lib/api-context.tsx";
import { formatTs, friendlyError } from "../lib/format.ts";
import { delimiterFor, parseDelimited } from "../lib/csv.ts";
import type { OutputFile, OutputNode } from "../lib/types.ts";
import { Button, Empty, Input, StatusText } from "../components/ui.tsx";

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

function formatBytes(bytes: number | undefined): string {
  const n = Number(bytes ?? 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function countFiles(nodes: OutputNode[]): number {
  return nodes.reduce(
    (n, node) => n + (node.kind === "file" ? 1 : countFiles(node.children ?? [])),
    0,
  );
}

function filterTree(nodes: OutputNode[], query: string): OutputNode[] {
  if (!query) return nodes;
  const out: OutputNode[] = [];
  for (const node of nodes) {
    const nameMatch = node.name.toLowerCase().includes(query);
    if (node.kind === "file") {
      if (nameMatch) out.push(node);
      continue;
    }
    const children = filterTree(node.children ?? [], query);
    if (nameMatch) out.push(node);
    else if (children.length) out.push({ ...node, children });
  }
  return out;
}

function EntryIcon({ node }: { node: OutputNode }) {
  if (node.kind === "dir") {
    return (
      <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="size-4 flex-none text-accent">
        <path
          d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.2 1.5h5.2A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5v-7Z"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  const ext = node.name.split(".").pop()?.toLowerCase() ?? "";
  return (
    <span className="w-8 flex-none rounded-[4px] border border-border bg-surface2 px-0.5 text-center text-[9px] font-semibold uppercase leading-4 text-muted">
      {(ext || "file").slice(0, 4)}
    </span>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className={
        "size-3.5 flex-none text-muted transition-transform " + (open ? "rotate-90" : "")
      }
    >
      <path
        d="m6 4 4 4-4 4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function MarkdownPreview({ text }: { text: string }) {
  const html = useMemo(() => {
    const raw = marked.parse(text, { gfm: true, async: false }) as string;
    return DOMPurify.sanitize(raw);
  }, [text]);
  return (
    <div
      className="rb-markdown text-[16px]"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function CsvPreview({ text, ext }: { text: string; ext: string }) {
  const table = useMemo(
    () => parseDelimited(text, delimiterFor(ext, text)),
    [text, ext],
  );
  if (!table.rows.length) return <p className="text-[14px] text-muted">空文件。</p>;
  const [header, ...body] = table.rows;
  return (
    <div className="min-w-0">
      <div className="max-h-[calc(100dvh-260px)] overflow-auto rounded-[10px] border border-border">
        <table className="min-w-full border-collapse text-[14px]">
          <thead className="sticky top-0 z-[1] bg-surface2">
            <tr>
              {header.map((cell, i) => (
                <th
                  key={i}
                  className="whitespace-nowrap border-b border-r border-border px-2.5 py-2 text-left font-semibold last:border-r-0"
                >
                  {cell || "—"}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((row, ri) => (
              <tr key={ri} className="align-top even:bg-surface2/40">
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
      {table.truncated && (
        <p className="mt-2 text-xs text-muted">文件较大，仅预览前 5000 行。</p>
      )}
    </div>
  );
}

function FilePreview({ file }: { file: OutputFile }) {
  if (file.binary) {
    return (
      <div className="rounded-[10px] border border-border bg-surface2 px-4 py-8 text-center text-[14px] text-muted">
        二进制文件，暂不支持预览（{formatBytes(file.bytes)}）。
      </div>
    );
  }
  const ext = file.ext;
  return (
    <div className="min-w-0">
      {file.truncated && (
        <p className="mb-2 rounded-[8px] border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-700 dark:text-amber-300">
          文件较大，仅预览前 2 MB。
        </p>
      )}
      {ext === "md" || ext === "markdown" ? (
        <MarkdownPreview text={file.content} />
      ) : ext === "csv" || ext === "tsv" ? (
        <CsvPreview text={file.content} ext={ext} />
      ) : (
        <pre className="max-h-[calc(100dvh-260px)] overflow-auto whitespace-pre-wrap break-words rounded-[10px] border border-border bg-surface2 p-3 text-[14px] leading-relaxed">
          {file.content}
        </pre>
      )}
    </div>
  );
}

export function OutputsPage({ reloadSignal }: { reloadSignal: number }) {
  const request = useApi();
  const [tree, setTree] = useState<OutputNode[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState("");
  const [file, setFile] = useState<OutputFile | null>(null);
  const [treeLoading, setTreeLoading] = useState(true);
  const [fileLoading, setFileLoading] = useState(false);
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: "" });
  const fileRequest = useRef(0);

  const loadTree = useCallback(
    async (silent = false) => {
      if (!silent) {
        setTreeLoading(true);
        setStatus({ text: "加载中…" });
      }
      try {
        const rows = await request<OutputNode[]>("/v1/outputs/tree");
        setTree(rows);
        setStatus({ text: "" });
      } catch (e) {
        setTree([]);
        setStatus({ text: `加载失败：${friendlyError(e)}`, error: true });
      } finally {
        setTreeLoading(false);
      }
    },
    [request],
  );

  const loadFile = useCallback(
    async (path: string) => {
      const seq = ++fileRequest.current;
      setFileLoading(true);
      setFile(null);
      try {
        const data = await request<OutputFile>(
          `/v1/outputs/file?path=${encodeURIComponent(path)}`,
        );
        if (seq !== fileRequest.current) return;
        setFile(data);
        setStatus({ text: "" });
      } catch (e) {
        if (seq !== fileRequest.current) return;
        setStatus({ text: `预览失败：${friendlyError(e)}`, error: true });
      } finally {
        if (seq === fileRequest.current) setFileLoading(false);
      }
    },
    [request],
  );

  useEffect(() => {
    void loadTree();
  }, [loadTree]);

  useEffect(() => {
    if (reloadSignal === 0) return;
    void loadTree(true);
    if (selected) void loadFile(selected);
  }, [reloadSignal]);

  const query = filter.trim().toLowerCase();
  const visible = useMemo(() => filterTree(tree, query), [tree, query]);
  const files = useMemo(() => countFiles(tree), [tree]);

  const toggleDir = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const selectFile = (path: string) => {
    setSelected(path);
    void loadFile(path);
  };

  const renderNodes = (nodes: OutputNode[], depth: number) =>
    nodes.map((node) => {
      const isDir = node.kind === "dir";
      const open = isDir && (query ? true : expanded.has(node.path));
      return (
        <li key={node.path} className="min-w-0">
          <button
            type="button"
            title={node.path}
            className={
              "flex w-full min-w-0 items-center gap-1.5 rounded-[8px] py-1.5 pr-2 text-left text-[14px] transition " +
              (node.path === selected
                ? "bg-accent-soft font-semibold text-accent"
                : "text-text hover:bg-surface2")
            }
            style={{ paddingLeft: 6 + depth * 14 }}
            onClick={() => (isDir ? toggleDir(node.path) : selectFile(node.path))}
          >
            {isDir ? <Chevron open={open} /> : <span className="w-3.5 flex-none" />}
            <EntryIcon node={node} />
            <span className="min-w-0 flex-1 truncate">{node.name}</span>
            {!isDir && (
              <span className="flex-none text-[11px] text-muted">{formatBytes(node.bytes)}</span>
            )}
          </button>
          {open && node.children?.length ? (
            <ul className="m-0 grid min-w-0 list-none gap-0.5 p-0">
              {renderNodes(node.children, depth + 1)}
            </ul>
          ) : null}
        </li>
      );
    });

  return (
    <div className="flex h-full min-h-0 max-[820px]:flex-col">
      <aside className="flex w-[360px] flex-none flex-col border-r border-border bg-surface max-[820px]:h-[45%] max-[820px]:w-full max-[820px]:border-b max-[820px]:border-r-0">
        <div className="flex-none border-b border-border px-3 py-2.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-sm font-semibold">产出目录</span>
            <span className="text-xs text-muted">{files} 个文件</span>
          </div>
          <Input
            aria-label="搜索产出文件"
            type="search"
            placeholder="搜索文件名…"
            className="mt-2 py-1.5 text-[13px]"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>

        <StatusText text={status.text} error={status.error} />

        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2 pb-3">
          {treeLoading ? (
            <p className="px-2 text-[13px] text-muted">加载中…</p>
          ) : !visible.length ? (
            <Empty>{query ? "没有匹配的文件。" : "这里还没有产出。"}</Empty>
          ) : (
            <ul className="m-0 grid list-none gap-0.5 p-0">{renderNodes(visible, 0)}</ul>
          )}
        </div>
      </aside>

      <section className="min-w-0 flex-1 overflow-y-auto px-[clamp(14px,3vw,32px)] py-4">
        <div className="mx-auto w-full max-w-[860px]">
          {!selected ? (
            <Empty>选择左侧文件预览。支持 Markdown、CSV / TSV 和纯文本。</Empty>
          ) : (
            <>
              <header className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border pb-2">
                <h2 className="m-0 min-w-0 break-words text-[17px] font-semibold">{selected}</h2>
                {file && (
                  <span className="text-xs text-muted">
                    {formatBytes(file.bytes)} · {formatTs(file.mtime)}
                  </span>
                )}
                <span className="flex-1" />
                <Button variant="ghost" size="sm" onClick={() => void loadFile(selected)}>
                  重新加载
                </Button>
              </header>
              {fileLoading ? (
                <p className="text-[13px] text-muted">加载中…</p>
              ) : file ? (
                <FilePreview file={file} />
              ) : (
                <Empty>文件读取失败。</Empty>
              )}
            </>
          )}
        </div>
      </section>
    </div>
  );
}
