import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { useApi } from "../lib/api-context.tsx";
import { cx } from "../lib/cx.ts";
import { formatTs, friendlyError } from "../lib/format.ts";
import { delimiterFor, parseDelimited } from "../lib/csv.ts";
import type { OutputFile, OutputNode } from "../lib/types.ts";
import { Button, Chip, Empty, Input, Segmented, StatusText } from "../components/ui.tsx";

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

type TypeFilter = "all" | "md" | "csv" | "html";

const TYPE_OPTIONS: { value: TypeFilter; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "md", label: "md" },
  { value: "csv", label: "csv" },
  { value: "html", label: "html" },
];

function formatBytes(bytes: number | undefined): string {
  const n = Number(bytes ?? 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function extOf(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return ext === name.toLowerCase() ? "" : ext;
}

function countFiles(nodes: OutputNode[]): number {
  return nodes.reduce(
    (n, node) => n + (node.kind === "file" ? 1 : countFiles(node.children ?? [])),
    0,
  );
}

function firstFile(nodes: OutputNode[]): OutputNode | null {
  for (const node of nodes) {
    if (node.kind === "file") return node;
    const child = firstFile(node.children ?? []);
    if (child) return child;
  }
  return null;
}

function filterTree(nodes: OutputNode[], query: string, type: TypeFilter): OutputNode[] {
  if (!query && type === "all") return nodes;
  const out: OutputNode[] = [];
  for (const node of nodes) {
    if (node.kind === "file") {
      const nameMatch = !query || node.name.toLowerCase().includes(query);
      const typeMatch = type === "all" || extOf(node.name) === type;
      if (nameMatch && typeMatch) out.push(node);
      continue;
    }
    const children = filterTree(node.children ?? [], query, type);
    if (children.length) out.push({ ...node, children });
  }
  return out;
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className={cx("size-3 flex-none text-faint transition-transform", open && "rotate-90")}
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

function FilePreview({ file }: { file: OutputFile }) {
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
        <MarkdownPreview text={file.content} />
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
  return (
    <div>
      {header}
      <pre className="rb-thin-scroll max-h-[calc(100dvh-260px)] overflow-auto whitespace-pre-wrap wrap-anywhere rounded-[12px] border border-border bg-surface p-3.5 font-mono text-[11.5px] leading-[1.7]">
        {file.content}
      </pre>
    </div>
  );
}

function MarkdownPreview({ text }: { text: string }) {
  const html = useMemo(() => {
    const raw = marked.parse(text, { gfm: true, async: false }) as string;
    return DOMPurify.sanitize(raw);
  }, [text]);
  return (
    <div
      className="rb-markdown rounded-[12px] border border-border bg-surface px-5 py-4 text-[13.5px]"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function CsvPreview({ text, ext }: { text: string; ext: string }) {
  const table = useMemo(
    () => parseDelimited(text, delimiterFor(ext, text)),
    [text, ext],
  );
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
      {table.truncated && (
        <p className="mt-2 text-xs text-muted">文件较大，仅预览前 5000 行。</p>
      )}
    </div>
  );
}

export function OutputsPage({ reloadSignal }: { reloadSignal: number }) {
  const request = useApi();
  const [tree, setTree] = useState<OutputNode[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
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

  const expandParents = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i++) next.add(parts.slice(0, i).join("/"));
      return next;
    });
  };

  useEffect(() => {
    if (selected || !tree.length) return;
    const first = firstFile(tree);
    if (first) {
      setSelected(first.path);
      expandParents(first.path);
      void loadFile(first.path);
    }
  }, [tree, selected, loadFile]);

  const query = filter.trim().toLowerCase();
  const visible = useMemo(
    () => filterTree(tree, query, typeFilter),
    [tree, query, typeFilter],
  );
  const files = useMemo(() => countFiles(tree), [tree]);
  const filtering = !!query || typeFilter !== "all";

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
    expandParents(path);
    void loadFile(path);
  };

  const copyPath = async () => {
    if (!selected) return;
    try {
      await navigator.clipboard?.writeText(selected);
      setStatus({ text: `已复制路径：${selected}` });
    } catch {
      setStatus({ text: `复制失败，路径：${selected}`, error: true });
    }
  };

  const renderNodes = (nodes: OutputNode[], depth: number) =>
    nodes.map((node) => {
      const isDir = node.kind === "dir";
      const open = isDir && (filtering ? true : expanded.has(node.path));
      const ext = isDir ? "" : extOf(node.name);
      return (
        <li key={node.path} className="min-w-0">
          <button
            type="button"
            title={node.path}
            className={cx(
              "flex w-full min-w-0 items-center gap-1.5 rounded-[7px] py-1.5 pr-2 text-left text-[12px] transition",
              node.path === selected
                ? "bg-accent-soft font-semibold text-accent-ink"
                : "text-text hover:bg-surface2",
            )}
            style={{ paddingLeft: 6 + depth * 13 }}
            onClick={() => (isDir ? toggleDir(node.path) : selectFile(node.path))}
          >
            {isDir ? (
              <Chevron open={open} />
            ) : (
              <span className="w-3 flex-none" />
            )}
            {isDir ? (
              <span className="w-[30px] flex-none rounded-[4px] border border-transparent bg-accent-soft py-px text-center font-mono text-[8.5px] font-bold text-accent-ink">
                DIR
              </span>
            ) : (
              <span className="w-[30px] flex-none rounded-[4px] border border-border bg-surface2 py-px text-center font-mono text-[8.5px] font-bold uppercase text-muted">
                {(ext || "file").slice(0, 4)}
              </span>
            )}
            <span className="min-w-0 flex-1 truncate">{node.name}</span>
            <span className="flex-none text-[10px] tabular-nums text-faint">
              {isDir ? countFiles(node.children ?? []) : formatBytes(node.bytes)}
            </span>
          </button>
          {open && node.children?.length ? (
            <ul className="m-0 grid min-w-0 list-none gap-0.5 p-0">
              {renderNodes(node.children, depth + 1)}
            </ul>
          ) : null}
        </li>
      );
    });

  const segments = selected.split("/");

  return (
    <div className="flex h-full min-h-0 max-[820px]:flex-col">
      <aside className="flex w-[352px] flex-none flex-col border-r border-border bg-surface max-[820px]:h-[45%] max-[820px]:w-full max-[820px]:border-b max-[820px]:border-r-0">
        <div className="flex-none border-b border-border px-3.5 pb-2.5 pt-3.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[13px] font-bold">产出目录</span>
            <span className="text-[11px] text-muted">{files} 个文件</span>
          </div>
        </div>
        <div className="px-2.5 pb-1.5 pt-2.5">
          <Input
            aria-label="搜索产出文件"
            type="search"
            placeholder="搜索文件名…"
            className="py-1.5 text-[12px]"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        <div className="px-2.5 pb-2">
          <Segmented
            value={typeFilter}
            options={TYPE_OPTIONS}
            onChange={setTypeFilter}
            label="文件类型"
          />
        </div>

        <StatusText text={status.text} error={status.error} />

        <div className="rb-thin-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1.5 pb-3">
          {treeLoading ? (
            <p className="px-2 text-[12px] text-muted">加载中…</p>
          ) : !visible.length ? (
            <Empty>{filtering ? "没有匹配的文件。" : "这里还没有产出。"}</Empty>
          ) : (
            <ul className="m-0 grid list-none gap-0.5 p-0">{renderNodes(visible, 0)}</ul>
          )}
        </div>
      </aside>

      <section className="rb-thin-scroll min-w-0 flex-1 overflow-y-auto bg-bg px-[clamp(14px,3vw,32px)] pb-12 pt-4">
        <div className="mx-auto w-full max-w-[880px]">
          {!selected ? (
            <Empty>选择左侧文件预览。支持 Markdown、CSV / TSV 和纯文本。</Empty>
          ) : (
            <>
              <header className="mb-3.5 flex flex-wrap items-start gap-3 border-b border-border pb-2.5">
                <div className="min-w-0">
                  <div className="mb-1 flex flex-wrap gap-1 font-mono text-[10.5px] text-faint">
                    {segments.map((segment, i) => (
                      <span key={`${segment}-${i}`} className="flex gap-1">
                        <span>{segment}</span>
                        {i < segments.length - 1 ? <span>/</span> : null}
                      </span>
                    ))}
                  </div>
                  <h2 className="rb-display m-0 text-[19px] wrap-anywhere">
                    {segments[segments.length - 1] || selected}
                  </h2>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-muted">
                    {file ? (
                      <>
                        <span>{formatBytes(file.bytes)}</span>
                        <span>{formatTs(file.mtime)}</span>
                        <Chip className="px-1.5 py-0 font-mono text-[10px]">
                          {file.ext || "file"}
                        </Chip>
                      </>
                    ) : null}
                  </div>
                </div>
                <div className="ml-auto flex flex-wrap gap-1.5">
                  <Button variant="ghost" size="sm" onClick={() => void copyPath()}>
                    复制路径
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => void loadFile(selected)}>
                    重新加载
                  </Button>
                </div>
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
