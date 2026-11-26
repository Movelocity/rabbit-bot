import { useEffect, useMemo, useRef, useState } from "react";
import { cx } from "../../lib/cx.ts";
import { badgeVariant, formatTs, noteSummary } from "../../lib/format.ts";
import type { ExecutorInfo, Project, TaskView } from "../../lib/types.ts";
import { Badge, Button, Empty, Select, TableWrap, inputClass } from "../../components/ui.tsx";
import { STATUS_GROUPS, STATUS_LABEL, statusGroupOf, type StatusGroupKey } from "./shared.ts";

const BOARD_PAGE_SIZE = 10;

function taskMatches(t: TaskView, executor: string, search: string): boolean {
  if (executor && String(t.executor || "") !== executor) return false;
  const q = search.trim().toLowerCase();
  if (!q) return true;
  const hay = [
    t.id, t.name, t.goal, t.deliverable, t.constraints, t.acceptance, t.result, t.artifact,
    t.files, t.status, t.stage, t.worker_id, t.executor, t.model, t.note, ...(t.projects ?? []),
  ]
    .map((v) => String(v ?? ""))
    .join(" ")
    .toLowerCase();
  return hay.includes(q);
}

function FileIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="size-3">
      <path d="M4 1.75h5.2L12.5 5v9.25H4z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M9 1.9V5.2h3.3" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

function TaskMeta({
  task,
  projects,
  outputCount,
  showProjects,
}: {
  task: TaskView;
  projects: Map<string, Project>;
  outputCount: number;
  showProjects: boolean;
}) {
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-faint">
      {showProjects
        ? (task.projects ?? []).map((slug) => (
            <span
              key={slug}
              className="max-w-[140px] truncate rounded-full border border-accent/30 bg-accent-soft px-1.5 py-px text-accent-ink"
              title={projects.get(slug)?.title || slug}
            >
              {projects.get(slug)?.title || slug}
            </span>
          ))
        : null}
      {outputCount ? (
        <span className="inline-flex items-center gap-0.5 text-muted" title={`${outputCount} 个产出文件`}>
          <FileIcon />
          {outputCount}
        </span>
      ) : null}
      <span>{task.executor || "—"}</span>
      <span className="ml-auto tabular-nums">{task.updated_at_local || formatTs(task.updated_at)}</span>
    </div>
  );
}

export function TaskBoard({
  tasks,
  projects,
  outputCounts,
  executors,
  activeTaskId,
  showProjects = true,
  emptyHint,
  onOpenTask,
}: {
  tasks: TaskView[];
  projects: Map<string, Project>;
  outputCounts: Map<number, number>;
  executors: ExecutorInfo[];
  activeTaskId: number | null;
  showProjects?: boolean;
  emptyHint?: string;
  onOpenTask: (id: number) => void;
}) {
  const [group, setGroup] = useState<"" | StatusGroupKey>("");
  const [executorFilter, setExecutorFilter] = useState("");
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<"board" | "list">(() =>
    window.localStorage.getItem("rb.work.view") === "list" ? "list" : "board",
  );
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [boardLimits, setBoardLimits] = useState<Record<string, number>>({});
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    window.localStorage.setItem("rb.work.view", viewMode);
  }, [viewMode]);

  useEffect(() => {
    setBoardLimits({});
    setPage(1);
  }, [group, executorFilter, search]);

  // "/" 聚焦搜索
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (document.querySelector("[role=dialog]")) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const matched = useMemo(
    () =>
      tasks
        .filter((t) => taskMatches(t, executorFilter, search))
        .sort((a, b) => b.updated_at - a.updated_at || b.id - a.id),
    [tasks, executorFilter, search],
  );

  const counts = useMemo(() => {
    const c: Record<StatusGroupKey, number> = { pending: 0, running: 0, blocked: 0, done: 0 };
    for (const t of matched) c[statusGroupOf(t.status)]++;
    return c;
  }, [matched]);

  const filtered = group ? matched.filter((t) => statusGroupOf(t.status) === group) : matched;
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pages);
  const start = (currentPage - 1) * pageSize;
  const pageRows = filtered.slice(start, start + pageSize);
  const end = Math.min(filtered.length, currentPage * pageSize);
  const boardGroups = group ? STATUS_GROUPS.filter((g) => g.key === group) : STATUS_GROUPS;

  const cardClass = (id: number) =>
    cx(
      "mb-1.5 block w-full rounded-[10px] border bg-surface p-2.5 text-left transition hover:-translate-y-px hover:border-accent/45 hover:shadow-[var(--rb-shadow)]",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/35",
      id === activeTaskId ? "border-accent shadow-[0_0_0_3px_var(--rb-accent-soft)]" : "border-border",
    );

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="inline-flex flex-wrap rounded-full border border-border bg-surface p-0.5" role="group" aria-label="状态筛选">
          {[{ key: "" as const, title: "全部", dot: "", n: matched.length }, ...STATUS_GROUPS.map((g) => ({ key: g.key, title: g.title, dot: g.dot, n: counts[g.key] }))].map(
            (item) => (
              <button
                key={item.key || "all"}
                type="button"
                aria-pressed={group === item.key}
                className={cx(
                  "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs outline-none transition focus-visible:ring-2 focus-visible:ring-accent/35",
                  group === item.key ? "bg-accent font-semibold text-[color:var(--rb-surface)]" : "text-muted hover:text-text",
                )}
                onClick={() => setGroup(item.key)}
              >
                {item.dot ? <span className={cx("size-1.5 rounded-full", group === item.key ? "bg-current" : item.dot)} /> : null}
                {item.title}
                <span className="tabular-nums opacity-75">{item.n}</span>
              </button>
            ),
          )}
        </div>

        <div className="relative min-w-[200px] flex-1">
          <input
            ref={searchRef}
            type="search"
            aria-label="搜索任务"
            placeholder="搜索 id / 任务名 / 目标 / 项目 / note"
            className={cx(inputClass, "py-1.5 pr-8 text-[12.5px]")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {!search ? (
            <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border border-border bg-surface2 px-1 font-mono text-[10px] text-faint">
              /
            </kbd>
          ) : null}
        </div>

        <Select
          className="!w-auto py-1.5 text-[12.5px]"
          ariaLabel="执行器"
          value={executorFilter}
          onValueChange={setExecutorFilter}
          options={[
            { value: "", label: "全部执行器" },
            ...(executors.length
              ? executors.map((e) => ({ value: e.name, label: e.available ? e.name : `${e.name}（未安装）` }))
              : ["opencode", "mimo", "codex", "claude"].map((v) => ({ value: v, label: v }))),
          ]}
        />

        <div className="inline-flex rounded-[8px] border border-border bg-surface2 p-0.5" role="group" aria-label="视图">
          {(["board", "list"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className={
                viewMode === mode
                  ? "rounded-[6px] bg-surface px-2.5 py-1 text-[11.5px] font-semibold text-accent-ink shadow-sm"
                  : "rounded-[6px] px-2.5 py-1 text-[11.5px] text-muted hover:text-text"
              }
              aria-pressed={viewMode === mode}
              onClick={() => setViewMode(mode)}
            >
              {mode === "board" ? "看板" : "列表"}
            </button>
          ))}
        </div>
      </div>

      {!filtered.length ? (
        <Empty>{tasks.length ? "没有匹配的任务。" : emptyHint || "没有任务。"}</Empty>
      ) : viewMode === "board" ? (
        <div
          className={cx(
            "grid items-start gap-2.5",
            boardGroups.length === 1
              ? "grid-cols-[repeat(auto-fill,minmax(260px,1fr))]"
              : "grid-cols-4 max-[1280px]:grid-cols-2 max-[640px]:grid-cols-1",
          )}
        >
          {boardGroups.map((g) => {
            const list = filtered.filter((t) => g.statuses.includes(t.status));
            const limit = boardLimits[g.key] ?? (group ? Infinity : BOARD_PAGE_SIZE);
            const shown = list.slice(0, limit);
            const cards = shown.map((t) => (
              <button key={t.id} type="button" className={cardClass(t.id)} onClick={() => onOpenTask(t.id)}>
                <div className="mb-1 flex flex-wrap items-center gap-1.5">
                  <span className="font-mono text-[10.5px] text-faint">#{t.id}</span>
                  <Badge variant={badgeVariant(t.status)}>{STATUS_LABEL[t.status] || t.status}</Badge>
                  {t.stage ? (
                    <span className="max-w-[120px] truncate rounded-[5px] border border-border bg-surface2 px-1.5 py-px font-mono text-[10px] text-muted">
                      {t.stage}
                    </span>
                  ) : null}
                </div>
                <div className="line-clamp-2 text-[12.5px] font-medium leading-snug">{t.name || t.goal || "（无目标）"}</div>
                {t.name && t.goal ? (
                  <div className="mt-0.5 line-clamp-1 text-[11px] text-muted">{t.goal}</div>
                ) : null}
                {noteSummary(t.note) && (g.key === "blocked" || g.key === "running") ? (
                  <div className="mt-1.5 truncate border-t border-dashed border-border pt-1.5 text-[10.5px] text-muted">
                    {noteSummary(t.note)}
                  </div>
                ) : null}
                <TaskMeta task={t} projects={projects} outputCount={outputCounts.get(t.id) ?? 0} showProjects={showProjects} />
              </button>
            ));
            return (
              <div key={g.key} className="min-h-[120px] rounded-[12px] border border-border bg-surface2 p-2">
                <div className="flex items-center gap-2 px-1 pb-2 pt-0.5 text-[11.5px] font-bold text-muted">
                  <span className={cx("size-2 rounded-full", g.dot)} />
                  {g.title}
                  <span className="ml-auto font-mono text-[10px] font-normal text-faint">{list.length}</span>
                </div>
                {shown.length ? (
                  group ? (
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-x-2">{cards}</div>
                  ) : (
                    cards
                  )
                ) : (
                  <div className="px-1 py-3 text-center text-[11px] text-faint">没有任务</div>
                )}
                {list.length > shown.length ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full"
                    onClick={() =>
                      setBoardLimits((prev) => ({ ...prev, [g.key]: (prev[g.key] ?? BOARD_PAGE_SIZE) + BOARD_PAGE_SIZE }))
                    }
                  >
                    再显示 {Math.min(BOARD_PAGE_SIZE, list.length - shown.length)} 条（共剩 {list.length - shown.length}）
                  </Button>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <>
          <TableWrap>
            <table className="w-full border-collapse text-[12.5px]">
              <thead>
                <tr>
                  {["#", "状态", "任务", showProjects ? "项目" : "", "产出", "执行器", "更新"].filter(Boolean).map((label) => (
                    <th
                      key={label}
                      className="whitespace-nowrap border-b border-border bg-surface2 px-2.5 py-2 text-left text-[10.5px] font-semibold uppercase tracking-[0.05em] text-muted"
                    >
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pageRows.map((t) => (
                  <tr
                    key={t.id}
                    tabIndex={0}
                    className={cx(
                      "cursor-pointer align-top outline-none transition hover:bg-accent-soft/30 focus-visible:bg-accent-soft/40",
                      t.id === activeTaskId && "bg-accent-soft/40",
                    )}
                    onClick={() => onOpenTask(t.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") onOpenTask(t.id);
                    }}
                  >
                    <td className="whitespace-nowrap border-b border-border px-2.5 py-2 font-mono text-[11px] text-muted">#{t.id}</td>
                    <td className="whitespace-nowrap border-b border-border px-2.5 py-2">
                      <Badge variant={badgeVariant(t.status)}>{STATUS_LABEL[t.status] || t.status}</Badge>
                    </td>
                    <td className="max-w-[420px] border-b border-border px-2.5 py-2">
                      <span className="line-clamp-1 font-medium">{t.name || t.goal || "（无目标）"}</span>
                      {t.name && t.goal ? <span className="line-clamp-1 text-[11px] text-muted">{t.goal}</span> : null}
                    </td>
                    {showProjects ? (
                      <td className="max-w-[180px] border-b border-border px-2.5 py-2 text-[11.5px] text-muted">
                        <span className="line-clamp-1">
                          {(t.projects ?? []).map((s) => projects.get(s)?.title || s).join("、") || "—"}
                        </span>
                      </td>
                    ) : null}
                    <td className="whitespace-nowrap border-b border-border px-2.5 py-2 tabular-nums text-muted">
                      {outputCounts.get(t.id) || "—"}
                    </td>
                    <td className="whitespace-nowrap border-b border-border px-2.5 py-2">{t.executor || "—"}</td>
                    <td className="whitespace-nowrap border-b border-border px-2.5 py-2 tabular-nums text-muted">
                      {t.updated_at_local || formatTs(t.updated_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>

          <div className="mt-3.5 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted">
            <Button variant="ghost" size="sm" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>
              上一页
            </Button>
            <span>
              {start + 1}–{end} / 共 {filtered.length} 条 · 第 {currentPage} / {pages} 页
            </span>
            <Button variant="ghost" size="sm" disabled={currentPage >= pages} onClick={() => setPage(currentPage + 1)}>
              下一页
            </Button>
            <span className="flex-1" />
            <Select
              className="!w-auto py-1.5"
              ariaLabel="每页条数"
              value={String(pageSize)}
              onValueChange={(value) => {
                setPageSize(Number(value) || 20);
                setPage(1);
              }}
              options={[10, 20, 50, 100].map((n) => ({ value: String(n), label: `${n} 条/页` }))}
            />
          </div>
        </>
      )}
    </div>
  );
}
