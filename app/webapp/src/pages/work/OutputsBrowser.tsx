import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApi, useApiBlob } from "../../lib/api-context.tsx";
import { cx } from "../../lib/cx.ts";
import { badgeVariant, formatTs, friendlyError } from "../../lib/format.ts";
import type { OutputFile, OutputNode, TaskView } from "../../lib/types.ts";
import { Badge, Button, Chip, Empty, Input, Segmented, StatusText } from "../../components/ui.tsx";
import {
  FilePreview,
  IMAGE_EXTS,
  countFiles,
  extOf,
  firstFile,
  formatBytes,
  taskIdOfOutput,
} from "./FilePreview.tsx";
import { STATUS_LABEL } from "./shared.ts";

type TypeFilter = "all" | "md" | "csv" | "html";

const TYPE_OPTIONS: { value: TypeFilter; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "md", label: "md" },
  { value: "csv", label: "csv" },
  { value: "html", label: "html" },
];

/** 顶层目录每页数量（task-<id> 文件夹） */
const PAGE_SIZE = 12;

function filterTree(
  nodes: OutputNode[],
  query: string,
  type: TypeFilter,
  dirLabel: (node: OutputNode) => string,
): OutputNode[] {
  if (!query && type === "all") return nodes;
  const out: OutputNode[] = [];
  for (const node of nodes) {
    if (node.kind === "file") {
      const nameMatch = !query || node.path.toLowerCase().includes(query);
      const typeMatch = type === "all" || extOf(node.name) === type;
      if (nameMatch && typeMatch) out.push(node);
      continue;
    }
    // 目录名（含任务名）命中时，整个目录按类型过滤后保留
    const dirHit = !!query && dirLabel(node).toLowerCase().includes(query);
    const children = filterTree(node.children ?? [], dirHit ? "" : query, type, dirLabel);
    if (children.length) out.push({ ...node, children });
  }
  return out;
}

function topSegment(path: string): string {
  return path.split("/")[0] ?? path;
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className={cx("size-3 flex-none text-faint transition-transform", open && "rotate-90")}
    >
      <path d="m6 4 4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function OutputsBrowser({
  tree,
  treeLoading,
  tasks,
  path,
  onSelectPath,
  onOpenTask,
  reloadSignal,
}: {
  tree: OutputNode[];
  treeLoading: boolean;
  tasks: Map<number, TaskView>;
  /** 当前预览文件（来自 URL，可深链） */
  path: string | null;
  onSelectPath: (path: string) => void;
  onOpenTask: (id: number) => void;
  reloadSignal: number;
}) {
  const request = useApi();
  const requestBlob = useApiBlob();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [page, setPage] = useState(0);
  const [file, setFile] = useState<OutputFile | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [imageUrl, setImageUrl] = useState("");
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: "" });
  const fileRequest = useRef(0);
  const imageUrlRef = useRef("");

  const replaceImageUrl = useCallback((url: string) => {
    if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
    imageUrlRef.current = url;
    setImageUrl(url);
  }, []);

  useEffect(
    () => () => {
      if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
    },
    [],
  );

  const loadFile = useCallback(
    async (target: string) => {
      const seq = ++fileRequest.current;
      setFileLoading(true);
      setFile(null);
      replaceImageUrl("");
      try {
        const data = await request<OutputFile>(`/v1/outputs/file?path=${encodeURIComponent(target)}`);
        if (seq !== fileRequest.current) return;
        setFile(data);
        setStatus({ text: "" });
        if (IMAGE_EXTS.has(data.ext)) {
          try {
            const blob = await requestBlob(`/v1/outputs/raw?path=${encodeURIComponent(target)}`);
            if (seq !== fileRequest.current) return;
            replaceImageUrl(URL.createObjectURL(blob));
          } catch (e) {
            if (seq !== fileRequest.current) return;
            setStatus({ text: `图片加载失败：${friendlyError(e)}`, error: true });
          }
        }
      } catch (e) {
        if (seq !== fileRequest.current) return;
        setStatus({ text: `预览失败：${friendlyError(e)}`, error: true });
      } finally {
        if (seq === fileRequest.current) setFileLoading(false);
      }
    },
    [replaceImageUrl, request, requestBlob],
  );

  // 选中文件完全由 URL 驱动：展开父目录 + 加载内容
  useEffect(() => {
    if (!path) {
      setFile(null);
      setStatus({ text: "" });
      return;
    }
    setExpanded((prev) => {
      const next = new Set(prev);
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i++) next.add(parts.slice(0, i).join("/"));
      return next;
    });
    void loadFile(path);
  }, [path, loadFile]);

  // 树刷新后重新读当前文件
  useEffect(() => {
    if (reloadSignal === 0 || !path) return;
    void loadFile(path);
  }, [reloadSignal]);

  const dirLabel = useCallback(
    (node: OutputNode) => {
      const id = taskIdOfOutput(node.path);
      const t = id !== null && !node.path.includes("/") ? tasks.get(id) : undefined;
      return t ? `${node.name} ${t.name} ${t.goal}` : node.name;
    },
    [tasks],
  );

  const query = filter.trim().toLowerCase();
  const visible = useMemo(() => filterTree(tree, query, typeFilter, dirLabel), [tree, query, typeFilter, dirLabel]);
  const files = useMemo(() => countFiles(tree), [tree]);
  const filtering = !!query || typeFilter !== "all";

  useEffect(() => {
    setPage(0);
  }, [query, typeFilter]);

  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);

  // 当前文件所在目录在哪一页，翻到那一页
  useEffect(() => {
    if (!path) return;
    const top = topSegment(path);
    const idx = visible.findIndex((n) => n.path === top || topSegment(n.path) === top);
    if (idx >= 0) setPage(Math.floor(idx / PAGE_SIZE));
  }, [path, visible]);

  // 没有任何选中时，默认打开第一个文件
  useEffect(() => {
    if (path || !tree.length) return;
    const first = firstFile(tree);
    if (first) onSelectPath(first.path);
  }, [tree, path, onSelectPath]);

  const pageNodes = visible.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  const toggleDir = (target: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(target)) next.delete(target);
      else next.add(target);
      return next;
    });
  };

  const copyPath = async () => {
    if (!path) return;
    try {
      await navigator.clipboard?.writeText(path);
      setStatus({ text: `已复制路径：${path}` });
    } catch {
      setStatus({ text: `复制失败，路径：${path}`, error: true });
    }
  };

  const renderNodes = (nodes: OutputNode[], depth: number) =>
    nodes.map((node) => {
      const isDir = node.kind === "dir";
      const open = isDir && (filtering ? true : expanded.has(node.path));
      const ext = isDir ? "" : extOf(node.name);
      const taskId = isDir && depth === 0 ? taskIdOfOutput(node.path) : null;
      const task = taskId !== null ? tasks.get(taskId) : undefined;
      return (
        <li key={node.path} className="min-w-0">
          <button
            type="button"
            title={task ? `${node.path} · ${task.name || task.goal}` : node.path}
            className={cx(
              "flex w-full min-w-0 items-center gap-1.5 rounded-[7px] py-1.5 pr-2 text-left text-[12px] transition",
              node.path === path ? "bg-accent-soft font-semibold text-accent-ink" : "text-text hover:bg-surface2",
            )}
            style={{ paddingLeft: 6 + depth * 13 }}
            onClick={() => (isDir ? toggleDir(node.path) : onSelectPath(node.path))}
          >
            {isDir ? <Chevron open={open} /> : <span className="w-3 flex-none" />}
            {isDir ? (
              taskId !== null ? (
                <span className="w-[30px] flex-none rounded-[4px] bg-accent-soft py-px text-center font-mono text-[8.5px] font-bold text-accent-ink">
                  #{taskId}
                </span>
              ) : (
                <span className="w-[30px] flex-none rounded-[4px] bg-surface2 py-px text-center font-mono text-[8.5px] font-bold text-muted">
                  DIR
                </span>
              )
            ) : (
              <span className="w-[30px] flex-none rounded-[4px] border border-border bg-surface2 py-px text-center font-mono text-[8.5px] font-bold uppercase text-muted">
                {(ext || "file").slice(0, 4)}
              </span>
            )}
            <span className="min-w-0 flex-1 truncate">
              {task ? task.name || task.goal || node.name : node.name}
            </span>
            <span className="flex-none text-[10px] tabular-nums text-faint">
              {isDir ? countFiles(node.children ?? []) : formatBytes(node.bytes)}
            </span>
          </button>
          {open && node.children?.length ? (
            <ul className="m-0 grid min-w-0 list-none gap-0.5 p-0">{renderNodes(node.children, depth + 1)}</ul>
          ) : null}
        </li>
      );
    });

  const segments = path ? path.split("/") : [];
  const selectedTaskId = path ? taskIdOfOutput(path) : null;
  const selectedTask = selectedTaskId !== null ? tasks.get(selectedTaskId) : undefined;

  return (
    <div className="flex h-full min-h-0 max-[820px]:flex-col">
      <aside className="flex w-[320px] flex-none flex-col border-r border-border bg-surface max-[820px]:h-[45%] max-[820px]:w-full max-[820px]:border-b max-[820px]:border-r-0">
        <div className="flex-none px-2.5 pb-1.5 pt-3">
          <div className="mb-2 flex items-baseline justify-between gap-2 px-1">
            <span className="text-[13px] font-bold">产出目录</span>
            <span className="text-[11px] text-muted">{files} 个文件</span>
          </div>
          <Input
            aria-label="搜索产出文件"
            type="search"
            placeholder="搜文件名 / 任务名…"
            className="py-1.5 text-[12px]"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        <div className="px-2.5 pb-2">
          <Segmented value={typeFilter} options={TYPE_OPTIONS} onChange={setTypeFilter} label="文件类型" />
        </div>

        <div className="rb-thin-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1.5 pb-3">
          {treeLoading && !tree.length ? (
            <p className="px-2 text-[12px] text-muted">加载中…</p>
          ) : !visible.length ? (
            <Empty>{filtering ? "没有匹配的文件。" : "这里还没有产出。"}</Empty>
          ) : (
            <ul className="m-0 grid list-none gap-0.5 p-0">{renderNodes(pageNodes, 0)}</ul>
          )}
        </div>

        {pageCount > 1 ? (
          <div className="flex flex-none items-center gap-1.5 border-t border-border px-2.5 py-2 text-[11px] text-muted">
            <Button
              variant="ghost"
              size="sm"
              disabled={safePage <= 0}
              onClick={() => setPage(Math.max(0, safePage - 1))}
            >
              上一页
            </Button>
            <span className="flex-1 text-center tabular-nums">
              {safePage + 1} / {pageCount}
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={safePage >= pageCount - 1}
              onClick={() => setPage(Math.min(pageCount - 1, safePage + 1))}
            >
              下一页
            </Button>
          </div>
        ) : null}
      </aside>

      <section className="rb-thin-scroll min-w-0 flex-1 overflow-y-auto bg-bg px-[clamp(14px,3vw,32px)] pb-12 pt-4">
        <div className="mx-auto w-full max-w-[880px]">
          <StatusText text={status.text} error={status.error} />
          {!path ? (
            <Empty>选择左侧文件预览。支持 Markdown、CSV / TSV、HTML、图片和纯文本。</Empty>
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
                  <h2 className="rb-display m-0 text-[19px] wrap-anywhere">{segments[segments.length - 1] || path}</h2>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted">
                    {file ? (
                      <>
                        <span>{formatBytes(file.bytes)}</span>
                        <span>{formatTs(file.mtime)}</span>
                        <Chip className="px-1.5 py-0 font-mono text-[10px]">{file.ext || "file"}</Chip>
                      </>
                    ) : null}
                  </div>
                </div>
                <div className="ml-auto flex flex-wrap gap-1.5">
                  <Button variant="ghost" size="sm" onClick={() => void copyPath()}>
                    复制路径
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => void loadFile(path)}>
                    重新加载
                  </Button>
                </div>
              </header>
              {selectedTaskId !== null ? (
                <button
                  type="button"
                  className="mb-3.5 flex w-full items-center gap-2 rounded-[10px] border border-border bg-surface px-3 py-2 text-left text-[12px] transition hover:border-accent/45 hover:bg-accent-soft/30"
                  onClick={() => onOpenTask(selectedTaskId)}
                >
                  <span className="text-faint">来自任务</span>
                  <span className="font-mono text-[11px] text-faint">#{selectedTaskId}</span>
                  {selectedTask ? (
                    <>
                      <Badge variant={badgeVariant(selectedTask.status)}>
                        {STATUS_LABEL[selectedTask.status] || selectedTask.status}
                      </Badge>
                      <span className="min-w-0 flex-1 truncate font-medium">
                        {selectedTask.name || selectedTask.goal}
                      </span>
                    </>
                  ) : (
                    <span className="flex-1" />
                  )}
                  <span className="text-accent-ink">查看任务 →</span>
                </button>
              ) : null}
              {fileLoading ? (
                <p className="text-[13px] text-muted">加载中…</p>
              ) : file ? (
                <FilePreview file={file} imageUrl={imageUrl} />
              ) : status.error ? null : (
                <Empty>文件读取失败。</Empty>
              )}
            </>
          )}
        </div>
      </section>
    </div>
  );
}