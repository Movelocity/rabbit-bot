import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useApi } from "../lib/api-context.tsx";
import { usePolling } from "../lib/use-polling.ts";
import { cx } from "../lib/cx.ts";
import { friendlyError } from "../lib/format.ts";
import type { ExecutorInfo, OutputNode, Project, TaskView } from "../lib/types.ts";
import { Empty, StatusText } from "../components/ui.tsx";
import { TaskBoard } from "./work/TaskBoard.tsx";
import { TaskDrawer } from "./work/TaskDrawer.tsx";
import { OutputsBrowser } from "./work/OutputsBrowser.tsx";
import { ProjectHeader, ProjectsOverview } from "./work/ProjectPanel.tsx";
import { countFiles, taskIdOfOutput } from "./work/FilePreview.tsx";
import {
  parseScope,
  projectGroup,
  scopeKey,
  summarizeTasks,
  type TaskSummary,
  type WorkScope,
} from "./work/shared.ts";

const EMPTY_SUMMARY: TaskSummary = { total: 0, running: 0, pending: 0, blocked: 0, done: 0 };

/** 旧链接 ?tab=outputs / ?tab=projects 落到对应范围 */
function scopeFromUrl(): WorkScope {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get("scope");
  if (raw) return parseScope(raw);
  const tab = params.get("tab");
  if (tab === "outputs") return { kind: "outputs" };
  if (tab === "projects" || tab === "plans") return { kind: "projects" };
  return { kind: "tasks" };
}

function writeScope(scope: WorkScope, replace = false) {
  const params = new URLSearchParams(window.location.search);
  params.set("tab", "work");
  params.set("scope", scopeKey(scope));
  const url = `${window.location.pathname}?${params.toString()}${window.location.hash}`;
  const now = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (url === now) return;
  if (replace) window.history.replaceState({ tab: "work" }, "", url);
  else window.history.pushState({ tab: "work" }, "", url);
}

function NavItem({
  active,
  onClick,
  icon,
  label,
  count,
  alert,
  title,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: ReactNode;
  count?: ReactNode;
  alert?: number;
  title?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      className={cx(
        "flex w-full min-w-0 items-center gap-2 rounded-[8px] px-2.5 py-1.5 text-left text-[12.5px] outline-none transition",
        "focus-visible:ring-2 focus-visible:ring-accent/35 max-[820px]:w-auto max-[820px]:flex-none",
        active ? "bg-accent-soft font-semibold text-accent-ink" : "text-muted hover:bg-surface2 hover:text-text",
      )}
    >
      <span className="flex size-4 flex-none items-center justify-center">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {alert ? (
        <span className="flex-none rounded-full bg-amber px-1.5 text-[10px] font-bold leading-[16px] text-white" title="待审批">
          {alert}
        </span>
      ) : null}
      {count !== undefined ? <span className="flex-none text-[10.5px] tabular-nums text-faint">{count}</span> : null}
    </button>
  );
}

const ICON_CLS = "size-3.5";

function TasksIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={ICON_CLS}>
      <rect x="2" y="2.5" width="12" height="11" rx="2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5 6h6M5 8.5h6M5 11h3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function OutputsIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={ICON_CLS}>
      <path d="M2 4.5c0-.8.7-1.5 1.5-1.5h3l1.5 1.5h4.5c.8 0 1.5.7 1.5 1.5v5.5c0 .8-.7 1.5-1.5 1.5h-9c-.8 0-1.5-.7-1.5-1.5z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

function ProjectsIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={ICON_CLS}>
      <rect x="2" y="2" width="5" height="5" rx="1.2" stroke="currentColor" strokeWidth="1.4" />
      <rect x="9" y="2" width="5" height="5" rx="1.2" stroke="currentColor" strokeWidth="1.4" />
      <rect x="2" y="9" width="5" height="5" rx="1.2" stroke="currentColor" strokeWidth="1.4" />
      <rect x="9" y="9" width="5" height="5" rx="1.2" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function ProjectDot({ summary }: { summary: TaskSummary }) {
  const cls = summary.blocked
    ? "bg-rose"
    : summary.pending
      ? "bg-amber"
      : summary.running
        ? "bg-accent"
        : summary.total && summary.done === summary.total
          ? "bg-ok"
          : "bg-line-strong";
  return <span className={cx("size-2 rounded-full", cls)} />;
}

export function WorkPage({
  reloadSignal,
  focusTaskId,
  onFocusHandled,
}: {
  reloadSignal: number;
  focusTaskId?: number | null;
  onFocusHandled?: () => void;
}) {
  const request = useApi();
  const [scope, setScopeState] = useState<WorkScope>(scopeFromUrl);
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [tree, setTree] = useState<OutputNode[]>([]);
  const [executors, setExecutors] = useState<ExecutorInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [treeLoading, setTreeLoading] = useState(true);
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: "" });
  const [openTaskId, setOpenTaskId] = useState<number | null>(null);
  const [drawerTab, setDrawerTab] = useState<"detail" | "outputs">("detail");
  const [focusPath, setFocusPath] = useState<string | null>(null);

  useEffect(() => {
    writeScope(scope, true);
    const onPop = () => setScopeState(scopeFromUrl());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
    // 只在挂载时规范一次 URL
  }, []);

  const setScope = useCallback((next: WorkScope) => {
    setScopeState(next);
    writeScope(next);
  }, []);

  const loadTasks = useCallback(
    async (silent: boolean) => {
      try {
        setTasks(await request<TaskView[]>("/v1/tasks"));
        if (!silent) setStatus({ text: "" });
      } catch (e) {
        setStatus({ text: `任务加载失败：${friendlyError(e)}`, error: true });
      }
    },
    [request],
  );

  const loadProjects = useCallback(async () => {
    try {
      setProjects(await request<Project[]>("/v1/projects"));
    } catch (e) {
      setStatus({ text: `项目加载失败：${friendlyError(e)}`, error: true });
    }
  }, [request]);

  const loadTree = useCallback(async () => {
    try {
      setTree(await request<OutputNode[]>("/v1/outputs/tree"));
    } catch (e) {
      setStatus({ text: `产出加载失败：${friendlyError(e)}`, error: true });
    } finally {
      setTreeLoading(false);
    }
  }, [request]);

  const loadAll = useCallback(async () => {
    await Promise.all([loadTasks(false), loadProjects(), loadTree()]);
    setLoaded(true);
  }, [loadTasks, loadProjects, loadTree]);

  useEffect(() => {
    void loadAll();
    let alive = true;
    void request<ExecutorInfo[]>("/v1/executors")
      .then((list) => {
        if (alive) setExecutors(list);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [loadAll, request]);

  useEffect(() => {
    if (reloadSignal === 0) return;
    void loadAll();
  }, [reloadSignal, loadAll]);

  usePolling(() => loadTasks(true), 3000);
  usePolling(() => loadTree(), 20000);

  useEffect(() => {
    if (focusTaskId === null || focusTaskId === undefined) return;
    setOpenTaskId(focusTaskId);
    setDrawerTab("detail");
    onFocusHandled?.();
  }, [focusTaskId, onFocusHandled]);

  // ---------- 派生数据：任务 ↔ 项目 ↔ 产出 ----------
  const tasksById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const projectsBySlug = useMemo(() => new Map(projects.map((p) => [p.slug, p])), [projects]);

  const outputDirs = useMemo(() => {
    const map = new Map<number, OutputNode>();
    for (const node of tree) {
      if (node.kind !== "dir") continue;
      const id = taskIdOfOutput(node.path);
      if (id !== null) map.set(id, node);
    }
    return map;
  }, [tree]);

  const outputCounts = useMemo(() => {
    const map = new Map<number, number>();
    for (const [id, node] of outputDirs) map.set(id, countFiles(node.children ?? []));
    return map;
  }, [outputDirs]);

  const tasksByProject = useMemo(() => {
    const map = new Map<string, TaskView[]>();
    for (const t of tasks) {
      for (const slug of t.projects ?? []) {
        const list = map.get(slug) ?? [];
        list.push(t);
        map.set(slug, list);
      }
    }
    return map;
  }, [tasks]);

  const summaries = useMemo(() => {
    const map = new Map<string, TaskSummary>();
    for (const [slug, list] of tasksByProject) map.set(slug, summarizeTasks(list));
    return map;
  }, [tasksByProject]);

  const outputsByProject = useMemo(() => {
    const map = new Map<string, number>();
    for (const [slug, list] of tasksByProject) {
      map.set(slug, list.reduce((n, t) => n + (outputCounts.get(t.id) ?? 0), 0));
    }
    return map;
  }, [tasksByProject, outputCounts]);

  const sortedProjects = useMemo(() => {
    const rank = { active: 0, planned: 1, done: 2 } as const;
    return [...projects].sort((a, b) => {
      const ga = rank[projectGroup(a, summaries.get(a.slug) ?? EMPTY_SUMMARY)];
      const gb = rank[projectGroup(b, summaries.get(b.slug) ?? EMPTY_SUMMARY)];
      return ga - gb || (b.updated_at ?? 0) - (a.updated_at ?? 0) || a.slug.localeCompare(b.slug);
    });
  }, [projects, summaries]);

  const pendingAll = tasks.filter((t) => t.status === "pending_approval").length;
  const totalFiles = useMemo(() => countFiles(tree), [tree]);
  const openTask = openTaskId !== null ? tasksById.get(openTaskId) : undefined;

  const openTaskDrawer = (id: number, tab: "detail" | "outputs" = "detail") => {
    setOpenTaskId(id);
    setDrawerTab(tab);
  };

  // ---------- 主区内容 ----------
  let main: ReactNode;
  if (scope.kind === "outputs") {
    main = (
      <OutputsBrowser
        tree={tree}
        treeLoading={treeLoading}
        tasks={tasksById}
        focusPath={focusPath}
        onFocusHandled={() => setFocusPath(null)}
        onOpenTask={(id) => openTaskDrawer(id)}
        reloadSignal={reloadSignal}
      />
    );
  } else {
    let body: ReactNode;
    if (scope.kind === "projects") {
      body = (
        <>
          <WorkHead eyebrow="Projects" title="项目" sub="按推进状态分组；点卡片进入项目，任务和产出都在里面。" />
          <ProjectsOverview
            projects={projects}
            summaries={summaries}
            outputsByProject={outputsByProject}
            onOpen={(slug) => setScope({ kind: "project", slug })}
          />
        </>
      );
    } else if (scope.kind === "project") {
      const project = projectsBySlug.get(scope.slug);
      body = !project ? (
        loaded ? (
          <Empty>找不到项目「{scope.slug}」，可能已被移除。</Empty>
        ) : (
          <p className="text-[13px] text-muted">加载中…</p>
        )
      ) : (
        <>
          <ProjectHeader
            key={project.slug}
            project={project}
            summary={summaries.get(project.slug) ?? EMPTY_SUMMARY}
            outputs={outputsByProject.get(project.slug) ?? 0}
            onSaved={(updated) => setProjects((prev) => prev.map((p) => (p.slug === updated.slug ? updated : p)))}
          />
          <h2 className="rb-display mb-2.5 mt-0 text-[16px]">关联任务</h2>
          <TaskBoard
            key={project.slug}
            tasks={tasksByProject.get(project.slug) ?? []}
            projects={projectsBySlug}
            outputCounts={outputCounts}
            executors={executors}
            activeTaskId={openTaskId}
            showProjects={false}
            emptyHint={`还没有任务关联到这个项目。创建任务时带上 objects=["project:${project.slug}"] 即可在这里聚合。`}
            onOpenTask={(id) => openTaskDrawer(id)}
          />
        </>
      );
    } else {
      body = (
        <>
          <WorkHead
            eyebrow="Task Pool"
            title="全部任务"
            sub="按状态扫任务；点卡片在右侧看详情、事件与产出，审批不离开列表。"
          />
          <TaskBoard
            tasks={tasks}
            projects={projectsBySlug}
            outputCounts={outputCounts}
            executors={executors}
            activeTaskId={openTaskId}
            emptyHint={loaded ? "没有任务。" : "加载中…"}
            onOpenTask={(id) => openTaskDrawer(id)}
          />
        </>
      );
    }
    main = (
      <div className="rb-thin-scroll h-full overflow-y-auto px-[clamp(16px,3vw,36px)] pb-16 pt-5 max-[820px]:px-3.5 max-[820px]:pt-3.5">
        {status.text ? <StatusText text={status.text} error={status.error} /> : null}
        {body}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 max-[820px]:flex-col">
      <nav
        aria-label="工作台范围"
        className="rb-thin-scroll flex w-[228px] flex-none flex-col gap-0.5 overflow-y-auto border-r border-border bg-surface px-2 py-3 max-[820px]:w-full max-[820px]:flex-row max-[820px]:overflow-x-auto max-[820px]:border-b max-[820px]:border-r-0 max-[820px]:py-2"
      >
        <NavItem
          active={scope.kind === "tasks"}
          onClick={() => setScope({ kind: "tasks" })}
          icon={<TasksIcon />}
          label="全部任务"
          alert={pendingAll}
          count={tasks.length}
        />
        <NavItem
          active={scope.kind === "outputs"}
          onClick={() => setScope({ kind: "outputs" })}
          icon={<OutputsIcon />}
          label="产出文件"
          count={totalFiles}
        />
        <NavItem
          active={scope.kind === "projects"}
          onClick={() => setScope({ kind: "projects" })}
          icon={<ProjectsIcon />}
          label="项目总览"
          count={projects.length}
        />

        <div className="mb-1 mt-3 px-2.5 text-[10px] font-bold uppercase tracking-[0.1em] text-faint max-[820px]:hidden">
          项目
        </div>
        <span className="mx-1 hidden w-px flex-none self-stretch bg-border max-[820px]:block" aria-hidden="true" />
        {sortedProjects.map((p) => {
          const summary = summaries.get(p.slug) ?? EMPTY_SUMMARY;
          return (
            <NavItem
              key={p.slug}
              active={scope.kind === "project" && scope.slug === p.slug}
              onClick={() => setScope({ kind: "project", slug: p.slug })}
              icon={<ProjectDot summary={summary} />}
              label={p.title}
              title={`${p.title}（${p.slug}）`}
              alert={summary.pending}
              count={summary.total || undefined}
            />
          );
        })}
        {loaded && !projects.length ? (
          <p className="px-2.5 text-[11px] text-faint max-[820px]:hidden">还没有项目</p>
        ) : null}
      </nav>

      <main className="min-h-0 min-w-0 flex-1 bg-bg">{main}</main>

      {openTask ? (
        <TaskDrawer
          key={`${openTask.id}-${drawerTab}`}
          task={openTask}
          outputs={outputDirs.get(openTask.id) ?? null}
          projects={projectsBySlug}
          initialTab={drawerTab}
          onClose={() => setOpenTaskId(null)}
          onChanged={() => loadTasks(true)}
          onOpenProject={(slug) => {
            setOpenTaskId(null);
            setScope({ kind: "project", slug });
          }}
          onOpenOutput={(path) => {
            setOpenTaskId(null);
            setFocusPath(path);
            setScope({ kind: "outputs" });
          }}
        />
      ) : null}
    </div>
  );
}

function WorkHead({ eyebrow, title, sub }: { eyebrow: string; title: string; sub: string }) {
  return (
    <div className="mb-3.5">
      <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-faint">{eyebrow}</div>
      <h1 className="rb-display m-0 mt-1 text-[23px] leading-[1.15]">{title}</h1>
      <p className="mt-1 max-w-[62ch] text-[12.5px] leading-relaxed text-muted">{sub}</p>
    </div>
  );
}
