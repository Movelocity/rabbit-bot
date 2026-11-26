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
  focusPath,
  onFocusHandled,
  onOpenTask,
  reloadSignal,
}: {
  tree: OutputNode[];
  treeLoading: boolean;
  tasks: Map<number, TaskView>;
  /** 外部要求定位到某个文件（如任务抽屉里「在产出中打开」） */
  focusPath: string | null;
  onFocusHandled: () => void;
  onOpenTask: (id: number) => void;
  reloadSignal: number;
}) {
  const request = useApi();
  const requestBlob = useApiBlob();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [selected, setSelected] = useState("");
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
    async (path: string) => {
      const seq = ++fileRequest.current;
      setFileLoading(true);
      setFile(null);
      replaceImageUrl("");
      try {
        const data = await request<OutputFile>(`/v1/outputs/file?path=${encodeURIComponent(path)}`);
        if (seq !== fileRequest.current) return;
        setFile(data);
        setStatus({ text: "" });
        if (IMAGE_EXTS.has(data.ext)) {
          try {
            const blob = await requestBlob(`/v1/outputs/raw?path=${encodeURIComponent(path)}`);
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

  const expandParents = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i++) next.add(parts.slice(0, i).join("/"));
      return next;
    });
  };

  const selectFile = useCallback(
    (path: string) => {
      setSelected(path);
      expandParents(path);
      void loadFile(path);
    },
    [loadFile],
  );

  useEffect(() => {
    if (reloadSignal === 0 || !selected) return;
    void loadFile(selected);
  }, [reloadSignal]);

  useEffect(() => {
    if (!focusPath) return;
    setFilter("");
    setTypeFilter("all");
    selectFile(focusPath);
    onFocusHandled();
  }, [focusPath, selectFile, onFocusHandled]);

  useEffect(() => {
    if (selected || focusPath || !tree.length) return;
    const first = firstFile(tree);
    if (first) selectFile(first.path);
  }, [tree, selected, focusPath, selectFile]);

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

  const toggleDir = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
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
      const taskId = isDir && depth === 0 ? taskIdOfOutput(node.path) : null;
      const task = taskId !== null ? tasks.get(taskId) : undefined;
      return (
        <li key={node.path} className="min-w-0">
          <button
            type="button"
            title={task ? `${node.path} · ${task.name || task.goal}` : node.path}
            className={cx(
              "flex w-full min-w-0 items-center gap-1.5 rounded-[7px] py-1.5 pr-2 text-left text-[12px] transition",
              node.path === selected ? "bg-accent-soft font-semibold text-accent-ink" : "text-text hover:bg-surface2",
            )}
            style={{ paddingLeft: 6 + depth * 13 }}
            onClick={() => (isDir ? toggleDir(node.path) : selectFile(node.path))}
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

  const segments = selected.split("/");
  const selectedTaskId = selected ? taskIdOfOutput(selected) : null;
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
            <ul className="m-0 grid list-none gap-0.5 p-0">{renderNodes(visible, 0)}</ul>
          )}
        </div>
      </aside>

      <section className="rb-thin-scroll min-w-0 flex-1 overflow-y-auto bg-bg px-[clamp(14px,3vw,32px)] pb-12 pt-4">
        <div className="mx-auto w-full max-w-[880px]">
          <StatusText text={status.text} error={status.error} />
          {!selected ? (
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
                  <h2 className="rb-display m-0 text-[19px] wrap-anywhere">{segments[segments.length - 1] || selected}</h2>
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
                  <Button variant="ghost" size="sm" onClick={() => void loadFile(selected)}>
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
