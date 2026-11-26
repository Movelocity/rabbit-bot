import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useApi } from "../lib/api-context.tsx";
import { usePolling } from "../lib/use-polling.ts";
import { cx } from "../lib/cx.ts";
import { friendlyError } from "../lib/format.ts";
import { useRoute } from "../lib/use-route.tsx";
import type { ExecutorInfo, OutputNode, Project, TaskView } from "../lib/types.ts";
import { Empty, StatusText } from "../components/ui.tsx";
import { SideNav, SideNavGroup, SideNavItem } from "../components/SideNav.tsx";
import { TaskBoard } from "./work/TaskBoard.tsx";
import { TaskDetail } from "./work/TaskDetail.tsx";
import { OutputsBrowser } from "./work/OutputsBrowser.tsx";
import { ProjectHeader } from "./work/ProjectPanel.tsx";
import { countFiles, flattenFiles, taskIdOfOutput } from "./work/FilePreview.tsx";
import {
  PROJECT_GROUPS,
  projectGroup,
  summarizeTasks,
  type ProjectGroupKey,
  type TaskSummary,
} from "./work/shared.ts";

const EMPTY_SUMMARY: TaskSummary = { total: 0, running: 0, pending: 0, blocked: 0, done: 0 };

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

export function WorkPage({ reloadSignal }: { reloadSignal: number }) {
  const request = useApi();
  const { route, navigate, back } = useRoute();
  const work = route.tab === "work" ? route : null;
  const view = work?.view ?? "tasks";
  const taskId = work?.task;
  const projectSlug = work?.view === "project" ? work.slug : undefined;
  const outputPath = work?.view === "outputs" ? work.path ?? null : null;

  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [tree, setTree] = useState<OutputNode[]>([]);
  const [executors, setExecutors] = useState<ExecutorInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [treeLoading, setTreeLoading] = useState(true);
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: "" });
  const [doneOpen, setDoneOpen] = useState(false);

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

  const sortedProjects = useMemo(() => {
    const rank = { active: 0, planned: 1, done: 2 } as const;
    return [...projects].sort((a, b) => {
      const ga = rank[projectGroup(a, summaries.get(a.slug) ?? EMPTY_SUMMARY)];
      const gb = rank[projectGroup(b, summaries.get(b.slug) ?? EMPTY_SUMMARY)];
      return ga - gb || (b.updated_at ?? 0) - (a.updated_at ?? 0) || a.slug.localeCompare(b.slug);
    });
  }, [projects, summaries]);

  const groupedProjects = useMemo(() => {
    const out: Record<ProjectGroupKey, Project[]> = { active: [], planned: [], done: [] };
    for (const project of sortedProjects) {
      out[projectGroup(project, summaries.get(project.slug) ?? EMPTY_SUMMARY)].push(project);
    }
    return out;
  }, [sortedProjects, summaries]);

  const pendingAll = tasks.filter((t) => t.status === "pending_approval").length;
  const totalFiles = useMemo(() => countFiles(tree), [tree]);

  const openTask = (id: number) => {
    if (view === "project" && work?.slug) {
      navigate({ tab: "work", view: "project", slug: work.slug, task: id });
    } else {
      navigate({ tab: "work", view: "tasks", task: id });
    }
  };

  /** 任务产出目录里的第一个文件，用于「在产出目录中查看」 */
  const firstFileInDir = (id: number): string | undefined => {
    const dir = outputDirs.get(id);
    return dir ? flattenFiles(dir.children ?? [])[0]?.path : undefined;
  };

  // ---------- 主区内容 ----------
  let main: ReactNode;
  if (view === "outputs") {
    main = (
      <OutputsBrowser
        tree={tree}
        treeLoading={treeLoading}
        tasks={tasksById}
        path={outputPath}
        onSelectPath={(path) =>
          navigate({ tab: "work", view: "outputs", path }, { replace: true })
        }
        onOpenTask={(id) => openTask(id)}
        reloadSignal={reloadSignal}
      />
    );
  } else {
    let body: ReactNode;
    if (taskId !== undefined) {
      const task = tasksById.get(taskId);
      body = !task ? (
        loaded ? (
          <div className="mx-auto w-full max-w-[980px]">
            <Empty>找不到任务 #{taskId}，可能已被移除。</Empty>
          </div>
        ) : (
          <p className="text-[13px] text-muted">加载中…</p>
        )
      ) : (
        <TaskDetail
          key={task.id}
          task={task}
          outputs={outputDirs.get(task.id) ?? null}
          projects={projectsBySlug}
          backLabel={
            view === "project" && projectSlug
              ? projectsBySlug.get(projectSlug)?.title || projectSlug
              : "全部任务"
          }
          onBack={() =>
            back(
              view === "project" && projectSlug
                ? { tab: "work", view: "project", slug: projectSlug }
                : { tab: "work", view: "tasks" },
            )
          }
          onChanged={() => loadTasks(true)}
          onOpenProject={(slug) => navigate({ tab: "work", view: "project", slug })}
          onOpenOutput={(path) => navigate({ tab: "work", view: "outputs", path })}
          onOpenOutputDir={() => {
            const first = firstFileInDir(task.id);
            navigate(
              first
                ? { tab: "work", view: "outputs", path: first }
                : { tab: "work", view: "outputs" },
            );
          }}
        />
      );
    } else if (view === "project" && projectSlug) {
      const project = projectsBySlug.get(projectSlug);
      body = !project ? (
        loaded ? (
          <Empty>找不到项目「{projectSlug}」，可能已被移除。</Empty>
        ) : (
          <p className="text-[13px] text-muted">加载中…</p>
        )
      ) : (
        <Fragment key={project.slug}>
          <ProjectHeader
            project={project}
            summary={summaries.get(project.slug) ?? EMPTY_SUMMARY}
            outputs={tasksByProject
              .get(project.slug)
              ?.reduce((n, t) => n + (outputCounts.get(t.id) ?? 0), 0) ?? 0}
            onSaved={(updated) => setProjects((prev) => prev.map((p) => (p.slug === updated.slug ? updated : p)))}
          />
          <h2 className="rb-display mb-2.5 mt-0 text-[16px]">关联任务</h2>
          <TaskBoard
            tasks={tasksByProject.get(project.slug) ?? []}
            projects={projectsBySlug}
            outputCounts={outputCounts}
            executors={executors}
            activeTaskId={null}
            showProjects={false}
            emptyHint={`还没有任务关联到这个项目。创建任务时带上 objects=["project:${project.slug}"] 即可在这里聚合。`}
            onOpenTask={(id) => openTask(id)}
          />
        </Fragment>
      );
    } else {
      body = (
        <>
          <WorkHead
            title="全部任务"
            sub="按状态扫任务；点卡片进入任务详情，审批不离开工作台。"
          />
          <TaskBoard
            tasks={tasks}
            projects={projectsBySlug}
            outputCounts={outputCounts}
            executors={executors}
            activeTaskId={null}
            emptyHint={loaded ? "没有任务。" : "加载中…"}
            onOpenTask={(id) => openTask(id)}
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
      <SideNav ariaLabel="工作台范围">
        <SideNavItem
          active={view === "tasks"}
          onClick={() => navigate({ tab: "work", view: "tasks" }, { replace: true })}
          icon={<TasksIcon />}
          label="全部任务"
          alert={pendingAll}
          count={tasks.length}
        />
        <SideNavItem
          active={view === "outputs"}
          onClick={() => navigate({ tab: "work", view: "outputs" }, { replace: true })}
          icon={<OutputsIcon />}
          label="产出文件"
          count={totalFiles}
        />

        {PROJECT_GROUPS.map((group) => {
          const list = groupedProjects[group.key];
          if (!list.length) return null;
          const collapsible = group.key === "done";
          return (
            <SideNavGroup
              key={group.key}
              label={group.label}
              count={list.length}
              collapsible={collapsible}
              collapsed={collapsible && !doneOpen}
              onToggle={() => setDoneOpen((open) => !open)}
            >
              {list.map((project) => {
                const summary = summaries.get(project.slug) ?? EMPTY_SUMMARY;
                return (
                  <SideNavItem
                    key={project.slug}
                    active={view === "project" && projectSlug === project.slug}
                    onClick={() =>
                      navigate(
                        { tab: "work", view: "project", slug: project.slug },
                        { replace: true },
                      )
                    }
                    icon={<ProjectDot summary={summary} />}
                    label={project.title}
                    title={`${project.title}（${project.slug}）`}
                    alert={summary.pending}
                    count={summary.total || undefined}
                  />
                );
              })}
            </SideNavGroup>
          );
        })}
        {loaded && !projects.length ? (
          <p className="px-2.5 text-[11px] text-faint max-[820px]:hidden">还没有项目</p>
        ) : null}
      </SideNav>

      <main className="min-h-0 min-w-0 flex-1 bg-bg">{main}</main>
    </div>
  );
}

function WorkHead({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="mb-3.5">
      <h1 className="rb-display m-0 mt-1 text-[23px] leading-[1.15]">{title}</h1>
      <p className="mt-1 max-w-[62ch] text-[12.5px] leading-relaxed text-muted">{sub}</p>
    </div>
  );
}