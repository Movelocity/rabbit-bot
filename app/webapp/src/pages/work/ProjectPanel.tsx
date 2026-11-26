import { useState } from "react";
import { useApi } from "../../lib/api-context.tsx";
import { cx } from "../../lib/cx.ts";
import { friendlyError } from "../../lib/format.ts";
import { nextStepOf } from "../../lib/plan.ts";
import type { Project } from "../../lib/types.ts";
import { Button, Chip, Empty, Segmented, StatusText, Textarea } from "../../components/ui.tsx";
import { MarkdownBlock } from "./FilePreview.tsx";
import {
  PROJECT_GROUPS,
  isMissingDoc,
  progressPct,
  projectGroup,
  type ProjectGroupKey,
  type TaskSummary,
} from "./shared.ts";

const EMPTY_SUMMARY: TaskSummary = { total: 0, running: 0, pending: 0, blocked: 0, done: 0 };

export function ProgressRing({
  summary,
  missing,
  size = 46,
}: {
  summary: TaskSummary;
  missing: boolean;
  size?: number;
}) {
  const pct = progressPct(summary);
  const color = summary.blocked ? "var(--rb-amber)" : missing ? "var(--rb-rose)" : "var(--rb-accent)";
  return (
    <div
      className="grid flex-none place-items-center rounded-full"
      style={{ width: size, height: size, background: `conic-gradient(${color} ${pct}%, var(--rb-surface-3) 0)` }}
      title={`${summary.done}/${summary.total} 个任务已结束`}
    >
      <span
        className={cx(
          "grid place-items-center rounded-full bg-surface text-[9.5px] font-bold tabular-nums",
          summary.blocked ? "text-amber" : missing ? "text-bad" : "text-accent-ink",
        )}
        style={{ width: size - 12, height: size - 12 }}
      >
        {pct}%
      </span>
    </div>
  );
}

/** 任务状态分布条：一眼看出项目里各状态占比 */
export function StatusBar({ summary }: { summary: TaskSummary }) {
  if (!summary.total) return <div className="h-1.5 rounded-full bg-surface3" />;
  const seg = (n: number, cls: string, label: string) =>
    n ? <span className={cls} style={{ flexGrow: n }} title={`${label} ${n}`} /> : null;
  return (
    <div className="flex h-1.5 gap-px overflow-hidden rounded-full bg-surface3">
      {seg(summary.done, "bg-ok", "已结束")}
      {seg(summary.running, "bg-accent", "进行中")}
      {seg(summary.pending, "bg-amber", "待审批")}
      {seg(summary.blocked, "bg-rose", "阻塞")}
    </div>
  );
}

function SummaryChips({ summary }: { summary: TaskSummary }) {
  if (!summary.total) return <Chip>暂无任务</Chip>;
  return (
    <>
      {summary.running ? <Chip tone="accent">进行中 {summary.running}</Chip> : null}
      {summary.pending ? <Chip tone="amber">待审批 {summary.pending}</Chip> : null}
      {summary.blocked ? <Chip tone="rose">阻塞 {summary.blocked}</Chip> : null}
      {summary.done ? <Chip tone="ok">结束 {summary.done}</Chip> : null}
    </>
  );
}

function ProjectCard({
  project,
  summary,
  outputs,
  onOpen,
}: {
  project: Project;
  summary: TaskSummary;
  outputs: number;
  onOpen: () => void;
}) {
  const next = nextStepOf(project.plan);
  const missing = isMissingDoc(project);
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cx(
        "group flex flex-col gap-2.5 rounded-[14px] border border-border bg-surface p-4 text-left shadow-[var(--rb-shadow)] transition",
        "hover:-translate-y-px hover:border-accent/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/35",
      )}
    >
      <div className="flex w-full items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="rb-display m-0 text-[16px] leading-snug wrap-anywhere">{project.title}</h3>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[10.5px] text-faint">
            <span className="font-mono">{project.slug}</span>
            {project.status ? <span>· {project.status}</span> : null}
          </div>
        </div>
        <ProgressRing summary={summary} missing={missing} />
      </div>

      <div className="w-full">
        <StatusBar summary={summary} />
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <SummaryChips summary={summary} />
        {missing ? <Chip tone="amber">缺文档</Chip> : null}
      </div>

      <div className="w-full border-l-2 border-accent/45 pl-2.5">
        <div className="text-[9.5px] font-semibold uppercase tracking-[0.08em] text-faint">下一步</div>
        <p className={cx("m-0 mt-0.5 line-clamp-2 text-[11.5px] leading-relaxed", next ? "text-muted" : "text-faint")}>
          {next || "plan.md 还没有内容。"}
        </p>
      </div>

      <div className="mt-auto flex w-full flex-wrap items-center gap-x-2 gap-y-1 border-t border-border pt-2 text-[10.5px] text-faint">
        <span>{summary.total} 个任务</span>
        <span>·</span>
        <span>{outputs} 个产出</span>
        <span>·</span>
        <span>更新 {project.updated_at_local || "—"}</span>
        <span className="ml-auto text-accent-ink opacity-0 transition group-hover:opacity-100">进入 →</span>
      </div>
    </button>
  );
}

export function ProjectsOverview({
  projects,
  summaries,
  outputsByProject,
  onOpen,
}: {
  projects: Project[];
  summaries: Map<string, TaskSummary>;
  outputsByProject: Map<string, number>;
  onOpen: (slug: string) => void;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const visible = projects.filter(
    (p) => !q || [p.slug, p.title, p.status, p.plan, p.context].some((x) => x.toLowerCase().includes(q)),
  );
  const grouped: Record<ProjectGroupKey, Project[]> = { active: [], planned: [], done: [] };
  for (const p of visible) grouped[projectGroup(p, summaries.get(p.slug) ?? EMPTY_SUMMARY)].push(p);

  if (!projects.length) {
    return (
      <Empty>
        没有项目。Agent 在 shared/projects/&lt;slug&gt;/ 下建 context.md 和 plan.md 后，这里会自动出现。
      </Empty>
    );
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          type="search"
          aria-label="搜索项目"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜项目 / 计划 / 上下文"
          className="w-[260px] rounded-[9px] border border-border bg-surface px-3 py-1.5 text-[12.5px] outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/25 max-sm:w-full"
        />
        <span className="text-[11.5px] text-muted">
          {visible.length} / {projects.length}
        </span>
      </div>
      {!visible.length ? (
        <Empty>没有匹配的项目。</Empty>
      ) : (
        <div className="grid gap-5">
          {PROJECT_GROUPS.map((group) => {
            const list = grouped[group.key];
            if (!list.length) return null;
            return (
              <section key={group.key}>
                <div className="mb-2.5 flex items-center gap-2">
                  <h2 className="rb-display m-0 text-[16px]">{group.label}</h2>
                  <Chip tone={group.tone}>{list.length}</Chip>
                  <span className="h-px flex-1 bg-border" />
                </div>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] items-stretch gap-3">
                  {list.map((p) => (
                    <ProjectCard
                      key={p.slug}
                      project={p}
                      summary={summaries.get(p.slug) ?? EMPTY_SUMMARY}
                      outputs={outputsByProject.get(p.slug) ?? 0}
                      onOpen={() => onOpen(p.slug)}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

type DocTab = "plan" | "context";

/** 项目视图顶部：概要 + 可折叠的 plan / context 文档（可编辑） */
export function ProjectHeader({
  project,
  summary,
  outputs,
  onSaved,
}: {
  project: Project;
  summary: TaskSummary;
  outputs: number;
  onSaved: (project: Project) => void;
}) {
  const request = useApi();
  const missing = isMissingDoc(project);
  const next = nextStepOf(project.plan);
  const [docOpen, setDocOpen] = useState(() => summary.total === 0);
  const [tab, setTab] = useState<DocTab>("plan");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const text = tab === "plan" ? project.plan : project.context;
  const file = `${project.path}/${tab === "plan" ? "plan.md" : "context.md"}`;

  const selectTab = (next: DocTab) => {
    setTab(next);
    setEditing(false);
    setError("");
  };

  const save = async () => {
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

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(file);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {}
  };

  return (
    <section className="mb-4 rounded-[14px] border border-border bg-surface shadow-[var(--rb-shadow)]">
      <div className="flex flex-wrap items-start gap-4 p-4">
        <ProgressRing summary={summary} missing={missing} size={54} />
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-faint">Project · {project.slug}</div>
          <h1 className="rb-display m-0 mt-0.5 text-[22px] leading-tight wrap-anywhere">{project.title}</h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {project.status ? <Chip>{project.status}</Chip> : null}
            <SummaryChips summary={summary} />
            {outputs ? <Chip>产出 {outputs}</Chip> : null}
            {missing ? <Chip tone="amber">缺文档</Chip> : null}
          </div>
          <div className="mt-2.5 max-w-[640px]">
            <StatusBar summary={summary} />
          </div>
        </div>
        <div className="max-w-[360px] flex-1 basis-[240px] border-l-2 border-accent/45 pl-3">
          <div className="text-[9.5px] font-semibold uppercase tracking-[0.08em] text-faint">下一步</div>
          <p className={cx("m-0 mt-0.5 line-clamp-3 text-[12px] leading-relaxed", next ? "text-text" : "text-faint")}>
            {next || "plan.md 还没有内容。"}
          </p>
        </div>
      </div>

      <div className="border-t border-border">
        <button
          type="button"
          aria-expanded={docOpen}
          className="flex w-full items-center gap-2 px-4 py-2 text-left text-[12px] text-muted transition hover:text-text"
          onClick={() => setDocOpen((v) => !v)}
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
            className={cx("size-3 transition-transform", docOpen && "rotate-90")}
          >
            <path d="m6 4 4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          项目文档
          <span className="text-faint">plan.md · context.md</span>
          <span className="ml-auto text-[11px] text-faint">{docOpen ? "收起" : "展开"}</span>
        </button>
        {docOpen ? (
          <div className="px-4 pb-4">
            <div className="mb-2.5 flex flex-wrap items-center gap-2">
              <Segmented
                value={tab}
                onChange={selectTab}
                label="项目文件"
                options={[
                  { value: "plan", label: "计划" },
                  { value: "context", label: "上下文" },
                ]}
              />
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-faint" title={file}>
                {file}
              </span>
              <Button variant="ghost" size="sm" onClick={() => void copy()}>
                {copied ? "已复制" : "复制路径"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => {
                  if (editing) setEditing(false);
                  else {
                    setDraft(text);
                    setEditing(true);
                    setError("");
                  }
                }}
              >
                {editing ? "取消编辑" : "编辑"}
              </Button>
            </div>
            {error ? <StatusText text={error} error /> : null}
            {editing ? (
              <>
                <Textarea
                  rows={18}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
                      e.preventDefault();
                      void save();
                    }
                  }}
                  className="font-mono text-[12px] leading-relaxed"
                />
                <div className="mt-2.5 flex items-center justify-end gap-2">
                  <span className="text-[11px] text-faint">⌘/Ctrl + S 保存</span>
                  <Button variant="primary" size="sm" onClick={() => void save()} disabled={busy}>
                    {busy ? "保存中…" : `保存 ${tab === "plan" ? "plan.md" : "context.md"}`}
                  </Button>
                </div>
              </>
            ) : text.trim() ? (
              <div className="rb-thin-scroll max-h-[420px] overflow-y-auto">
                <MarkdownBlock
                  text={text}
                  className="rb-markdown rounded-[12px] border border-border bg-bg px-4 py-3.5 text-[13px]"
                />
              </div>
            ) : (
              <p className="text-[13px] text-muted">这个文件还没有内容。</p>
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
}
