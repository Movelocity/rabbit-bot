import { useCallback, useEffect, useMemo, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { useApi } from "../lib/api-context.tsx";
import { cx } from "../lib/cx.ts";
import { badgeVariant, formatTs, friendlyError } from "../lib/format.ts";
import type { Project, TaskView } from "../lib/types.ts";
import {
  Badge,
  Button,
  Chip,
  Empty,
  Input,
  Page,
  PageHead,
  Segmented,
  StatusText,
  Textarea,
} from "../components/ui.tsx";
import { Drawer } from "../components/Drawer.tsx";

type DocTab = "plan" | "context" | "tasks";
type ProjectFilter = "all" | "active" | "tasks" | "missing";

const DOC_OPTIONS: { value: DocTab; label: string }[] = [
  { value: "plan", label: "计划" },
  { value: "context", label: "上下文" },
  { value: "tasks", label: "关联任务" },
];

const FILTER_OPTIONS: { value: ProjectFilter; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "active", label: "进行中" },
  { value: "tasks", label: "有任务" },
  { value: "missing", label: "缺文档" },
];

interface TaskSummary {
  total: number;
  running: number;
  pending: number;
  blocked: number;
  done: number;
}

function summarizeTasks(tasks: TaskView[]): TaskSummary {
  const s: TaskSummary = { total: tasks.length, running: 0, pending: 0, blocked: 0, done: 0 };
  for (const t of tasks) {
    if (t.status === "running") s.running++;
    else if (t.status === "pending_approval" || t.status === "pending") s.pending++;
    else if (t.status === "blocked" || t.status === "failed") s.blocked++;
    else if (t.status === "done" || t.status === "cancelled") s.done++;
  }
  return s;
}

function isMissingDoc(project: Project): boolean {
  return !project.plan.trim() || !project.context.trim();
}

function MarkdownBlock({ text }: { text: string }) {
  const html = useMemo(() => {
    const raw = marked.parse(text, { gfm: true, async: false }) as string;
    return DOMPurify.sanitize(raw);
  }, [text]);
  return (
    <div
      className="rb-markdown rounded-[12px] border border-border bg-surface px-4 py-3.5 text-[13px]"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function cleanPlanLine(line: string): string {
  return line
    .replace(/^[-*]\s+/, "")
    .replace(/^\d+\.\s+/, "")
    .replace(/`/g, "")
    .replace(/\*\*/g, "")
    .trim();
}

function nextStepOf(plan: string): string {
  const lines = plan.split("\n");
  const index = lines.findIndex((line) => /下一步/.test(line));
  if (index >= 0) {
    const inline = cleanPlanLine(
      lines[index].replace(/^#{1,6}\s*/, "").replace(/下一步[:：\s]*/, ""),
    );
    if (inline) return inline;
    for (let i = index + 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      if (/^#{1,6}\s/.test(line)) break;
      return cleanPlanLine(line);
    }
  }
  const first = lines
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#"));
  return first ? cleanPlanLine(first) : "";
}

type ProjectGroupKey = "active" | "planned" | "done";

const PROJECT_GROUPS: { key: ProjectGroupKey; label: string; tone: "accent" | "default" | "ok" }[] = [
  { key: "active", label: "推进中", tone: "accent" },
  { key: "planned", label: "计划中", tone: "default" },
  { key: "done", label: "已完成", tone: "ok" },
];

function projectGroup(project: Project, summary: TaskSummary): ProjectGroupKey {
  const status = project.status.trim();
  if (/完成|已上线|已结项|\bdone\b|\bclosed\b/i.test(status)) return "done";
  if (summary.running + summary.pending + summary.blocked > 0) return "active";
  if (/推进|进行中|执行中|卡住|阻塞|等审批|待审|\bactive\b|\brunning\b/i.test(status)) return "active";
  if (summary.total > 0 && summary.done === summary.total) return "done";
  return "planned";
}

function CopyPathButton({ value, label = "复制路径" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Button variant="ghost" size="sm" onClick={() => void copy()} title={value}>
      {copied ? "已复制" : label}
    </Button>
  );
}

function TaskSummaryChips({ summary }: { summary: TaskSummary }) {
  if (!summary.total) {
    return <Chip>暂无关联任务</Chip>;
  }
  return (
    <>
      {summary.running ? <Chip tone="accent">进行中 {summary.running}</Chip> : null}
      {summary.pending ? <Chip tone="amber">待办 {summary.pending}</Chip> : null}
      {summary.blocked ? <Chip tone="rose">阻塞 {summary.blocked}</Chip> : null}
      {summary.done ? <Chip tone="ok">结束 {summary.done}</Chip> : null}
    </>
  );
}

function ProgressRing({ summary, missing }: { summary: TaskSummary; missing: boolean }) {
  const pct = summary.total ? Math.round((summary.done / summary.total) * 100) : 0;
  const color = summary.blocked
    ? "var(--rb-amber)"
    : missing
      ? "var(--rb-rose)"
      : "var(--rb-accent)";
  return (
    <div
      className="grid size-[46px] flex-none place-items-center rounded-full"
      style={{ background: `conic-gradient(${color} ${pct}%, var(--rb-surface-3) 0)` }}
      title={`${summary.done}/${summary.total} 个任务已结束`}
    >
      <span
        className={cx(
          "grid size-[34px] place-items-center rounded-full bg-surface text-[9.5px] font-bold tabular-nums",
          summary.blocked ? "text-amber" : missing ? "text-bad" : "text-accent-ink",
        )}
      >
        {pct}%
      </span>
    </div>
  );
}

function ProjectCard({
  project,
  summary,
  onOpen,
}: {
  project: Project;
  summary: TaskSummary;
  onOpen: () => void;
}) {
  const next = nextStepOf(project.plan);
  const missing = isMissingDoc(project);
  return (
    <article className="flex flex-col gap-2.5 rounded-[14px] border border-border bg-surface p-4 shadow-[var(--rb-shadow)] transition hover:border-accent/45">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="rb-display m-0 text-[16.5px] leading-snug wrap-anywhere">{project.title}</h3>
            <span className="rounded-[5px] border border-border bg-surface2 px-1.5 py-px font-mono text-[10px] text-muted">
              {project.slug}
            </span>
          </div>
          {project.status ? (
            <p className="m-0 mt-1 text-[11px] text-faint">{project.status}</p>
          ) : null}
        </div>
        <ProgressRing summary={summary} missing={missing} />
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <TaskSummaryChips summary={summary} />
        {missing ? <Chip tone="amber">缺文档</Chip> : null}
      </div>

      <div className="border-l-2 border-accent/45 pl-2.5">
        <div className="text-[9.5px] font-semibold uppercase tracking-[0.08em] text-faint">
          下一步
        </div>
        <p
          className={cx(
            "m-0 mt-0.5 line-clamp-2 text-[11.5px] leading-relaxed",
            next ? "text-muted" : "text-faint",
          )}
        >
          {next || "plan.md 还没有内容。"}
        </p>
      </div>

      <div className="mt-auto flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border pt-2 text-[10.5px] text-faint">
        <span>{summary.total} 个任务</span>
        <span>·</span>
        <span>更新 {project.updated_at_local || "—"}</span>
        <div className="ml-auto flex gap-1.5">
          <Button variant="ghost" size="sm" onClick={onOpen}>
            查看
          </Button>
        </div>
      </div>
    </article>
  );
}

function ProjectDrawer({
  project,
  tasks,
  onClose,
  onSaved,
  onOpenTask,
}: {
  project: Project;
  tasks: TaskView[];
  onClose: () => void;
  onSaved: (project: Project) => void;
  onOpenTask?: (id: number) => void;
}) {
  const request = useApi();
  const [tab, setTab] = useState<DocTab>("plan");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(project.plan);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const isDoc = tab !== "tasks";
  const text = tab === "plan" ? project.plan : project.context;
  const file = isDoc ? `${project.path}/${tab === "plan" ? "plan.md" : "context.md"}` : project.path;
  const summary = summarizeTasks(tasks);

  const selectTab = (next: DocTab) => {
    setTab(next);
    setEditing(false);
    setError("");
    if (next !== "tasks") setDraft(next === "plan" ? project.plan : project.context);
  };

  const startEdit = () => {
    setDraft(text);
    setEditing(true);
    setError("");
  };

  const save = async () => {
    if (tab === "tasks") return;
    setBusy(true);
    setError("");
    try {
      const updated = await request<Project>(`/v1/projects/${encodeURIComponent(project.slug)}`, {
        method: "PATCH",
        body: { [tab]: draft },
      });
      onSaved(updated);
      setEditing(false);
    } catch (e) {
      setError(`保存失败：${friendlyError(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      title={
        <span className="inline-flex flex-wrap items-baseline gap-2">
          <span className="rounded-[5px] border border-border bg-surface2 px-1.5 py-px font-mono text-[11px] font-normal text-muted">
            {project.slug}
          </span>
          {project.title}
        </span>
      }
      onClose={onClose}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <Segmented value={tab} options={DOC_OPTIONS} onChange={selectTab} label="项目文件" />
        {isDoc ? (
          <Button variant="ghost" size="sm" onClick={() => (editing ? setEditing(false) : startEdit())} disabled={busy}>
            {editing ? "取消编辑" : "编辑"}
          </Button>
        ) : (
          <Chip>{summary.total} 个关联任务</Chip>
        )}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-faint" title={file}>
          {file}
        </span>
        <CopyPathButton value={file} label="复制路径" />
      </div>

      {project.status ? <p className="mb-2 text-[12px] text-muted">状态：{project.status}</p> : null}
      {error ? <StatusText text={error} error /> : null}

      {tab === "tasks" ? (
        tasks.length ? (
          <div className="grid gap-1.5">
            {tasks.map((t) => (
              <button
                key={t.id}
                type="button"
                className="block w-full rounded-[10px] border border-border bg-surface p-2.5 text-left transition hover:border-accent/45 hover:bg-accent-soft/30"
                onClick={() => {
                  onClose();
                  onOpenTask?.(t.id);
                }}
              >
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-[10.5px] text-faint">#{t.id}</span>
                  <Badge variant={badgeVariant(t.status)}>{t.status}</Badge>
                  <span className="ml-auto text-[10.5px] text-faint">
                    {t.updated_at_local || formatTs(t.updated_at)}
                  </span>
                </div>
                <div className="mt-1 line-clamp-2 text-[12px] leading-snug">{t.name || t.goal || "（无目标）"}</div>
              </button>
            ))}
          </div>
        ) : (
          <p className="text-[13px] text-muted">
            还没有任务关联到这个项目。创建任务时带上 <code className="font-mono">objects=["project:{project.slug}"]</code> 即可在这里聚合。
          </p>
        )
      ) : editing ? (
        <>
          <Textarea
            rows={20}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="font-mono text-[12px] leading-relaxed"
          />
          <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
            <span className="min-w-0 truncate font-mono text-[11px] text-faint" title={file}>
              {file}
            </span>
            <Button variant="primary" size="sm" onClick={() => void save()} disabled={busy}>
              {busy ? "保存中…" : `保存 ${tab === "plan" ? "plan.md" : "context.md"}`}
            </Button>
          </div>
        </>
      ) : text.trim() ? (
        <MarkdownBlock text={text} />
      ) : (
        <p className="text-[13px] text-muted">这个文件还没有内容。</p>
      )}
    </Drawer>
  );
}

export function ProjectsPage({
  reloadSignal,
  onOpenTask,
}: {
  reloadSignal: number;
  onOpenTask?: (id: number) => void;
}) {
  const request = useApi();
  const [rows, setRows] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ProjectFilter>("all");
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: "" });
  const [openSlug, setOpenSlug] = useState<string | null>(null);

  const load = useCallback(async () => {
    setStatus({ text: "加载中…" });
    try {
      const [projects, taskRows] = await Promise.all([
        request<Project[]>("/v1/projects"),
        request<TaskView[]>("/v1/tasks"),
      ]);
      setRows(projects);
      setTasks(taskRows);
      setStatus({ text: "" });
    } catch (e) {
      setStatus({ text: `加载失败：${friendlyError(e)}`, error: true });
    }
  }, [request]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (reloadSignal === 0) return;
    void load();
  }, [reloadSignal, load]);

  const tasksByProject = useMemo(() => {
    const map = new Map<string, TaskView[]>();
    for (const t of tasks) {
      for (const slug of t.projects ?? []) {
        const list = map.get(slug) ?? [];
        list.push(t);
        map.set(slug, list);
      }
    }
    for (const list of map.values()) {
      list.sort((a, b) => b.updated_at - a.updated_at || b.id - a.id);
    }
    return map;
  }, [tasks]);

  const summaries = useMemo(() => {
    const map = new Map<string, TaskSummary>();
    for (const [slug, list] of tasksByProject) map.set(slug, summarizeTasks(list));
    return map;
  }, [tasksByProject]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = rows.filter((p) => {
      const summary = summaries.get(p.slug) ?? summarizeTasks([]);
      if (filter === "active" && projectGroup(p, summary) !== "active") return false;
      if (filter === "tasks" && summary.total === 0) return false;
      if (filter === "missing" && !isMissingDoc(p)) return false;
      if (!q) return true;
      return [p.slug, p.title, p.status, p.plan, p.context].some((x) => x.toLowerCase().includes(q));
    });
    return matched.sort((a, b) => {
      const sa = summaries.get(a.slug);
      const sb = summaries.get(b.slug);
      const activeA = sa ? sa.running + sa.pending + sa.blocked : 0;
      const activeB = sb ? sb.running + sb.pending + sb.blocked : 0;
      return activeB - activeA || (b.updated_at ?? 0) - (a.updated_at ?? 0) || a.slug.localeCompare(b.slug);
    });
  }, [rows, query, filter, summaries]);

  const current = openSlug ? rows.find((p) => p.slug === openSlug) ?? null : null;

  const onSaved = (updated: Project) => {
    setRows((prev) => prev.map((p) => (p.slug === updated.slug ? updated : p)));
    setStatus({ text: "" });
  };

  const groupedAll = useMemo(() => {
    const groups: Record<ProjectGroupKey, Project[]> = { active: [], planned: [], done: [] };
    for (const p of rows) {
      groups[projectGroup(p, summaries.get(p.slug) ?? summarizeTasks([]))].push(p);
    }
    return groups;
  }, [rows, summaries]);

  const groupedVisible = useMemo(() => {
    const groups: Record<ProjectGroupKey, Project[]> = { active: [], planned: [], done: [] };
    for (const p of visible) {
      groups[projectGroup(p, summaries.get(p.slug) ?? summarizeTasks([]))].push(p);
    }
    return groups;
  }, [visible, summaries]);

  const missing = rows.filter(isMissingDoc).length;
  const blockedTasks = rows.reduce(
    (sum, p) => sum + (summaries.get(p.slug)?.blocked ?? 0),
    0,
  );

  return (
    <Page>
      <PageHead
        eyebrow="Projects"
        title="项目"
        sub="按推进状态分组；卡片给出下一步与任务分布，点开可读、改 plan.md 与 context.md。"
        actions={
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜项目 / 计划 / 上下文"
            className="w-[220px] max-sm:w-[180px]"
          />
        }
      />

      <div className="mb-3.5 flex flex-wrap gap-1.5">
        <Chip>项目 {rows.length}</Chip>
        <Chip tone="accent">推进中 {groupedAll.active.length}</Chip>
        <Chip>计划中 {groupedAll.planned.length}</Chip>
        <Chip tone="ok">已完成 {groupedAll.done.length}</Chip>
        {missing ? <Chip tone="amber">缺文档 {missing}</Chip> : null}
        {blockedTasks ? <Chip tone="rose">阻塞任务 {blockedTasks}</Chip> : null}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2.5">
        <Segmented value={filter} options={FILTER_OPTIONS} onChange={setFilter} label="项目筛选" />
        <span className="text-[11.5px] text-muted">{visible.length} / {rows.length}</span>
        <Chip className="ml-auto">活跃优先</Chip>
      </div>

      <StatusText text={status.text} error={status.error} />

      {!rows.length && !status.text ? (
        <Empty>
          没有项目。Agent 在 shared/projects/&lt;slug&gt;/ 下建 context.md 和 plan.md 后，这里会自动出现。
        </Empty>
      ) : !visible.length ? (
        <Empty>没有匹配的项目。</Empty>
      ) : (
        <div className="grid gap-5">
          {PROJECT_GROUPS.map((group) => {
            const list = groupedVisible[group.key];
            if (!list.length) return null;
            return (
              <section key={group.key}>
                <div className="mb-2.5 flex items-center gap-2">
                  <h2 className="rb-display m-0 text-[17px]">{group.label}</h2>
                  <Chip tone={group.tone}>{list.length}</Chip>
                  <span className="h-px flex-1 bg-border" />
                </div>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] items-stretch gap-3">
                  {list.map((p) => (
                    <ProjectCard
                      key={p.slug}
                      project={p}
                      summary={summaries.get(p.slug) ?? summarizeTasks([])}
                      onOpen={() => setOpenSlug(p.slug)}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {current ? (
        <ProjectDrawer
          key={current.slug}
          project={current}
          tasks={tasksByProject.get(current.slug) ?? []}
          onClose={() => setOpenSlug(null)}
          onSaved={onSaved}
          onOpenTask={onOpenTask}
        />
      ) : null}
    </Page>
  );
}
