import { useState } from "react";
import { useApi } from "../../lib/api-context.tsx";
import { cx } from "../../lib/cx.ts";
import { friendlyError } from "../../lib/format.ts";
import { nextStepOf } from "../../lib/plan.ts";
import type { Project } from "../../lib/types.ts";
import { Button, Chip, Segmented, StatusText, Textarea } from "../../components/ui.tsx";
import { MarkdownBlock } from "./FilePreview.tsx";
import { isMissingDoc, progressPct, type TaskSummary } from "./shared.ts";

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
          <h1 className="rb-display m-0 text-[22px] leading-tight wrap-anywhere">{project.title}</h1>
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
