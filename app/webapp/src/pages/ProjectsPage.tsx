import { useCallback, useEffect, useMemo, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { useApi } from "../lib/api-context.tsx";
import { friendlyError } from "../lib/format.ts";
import type { Project } from "../lib/types.ts";
import { Button, Empty, Input, Page, PageHead, Segmented, StatusText, Textarea } from "../components/ui.tsx";
import { Drawer } from "../components/Drawer.tsx";

type DocTab = "plan" | "context";

const DOC_OPTIONS: { value: DocTab; label: string }[] = [
  { value: "plan", label: "计划" },
  { value: "context", label: "上下文" },
];

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

function summaryOf(plan: string): string {
  const lines = plan
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  return lines.slice(0, 5).join("\n");
}

function ProjectCard({ project, onOpen }: { project: Project; onOpen: () => void }) {
  const summary = summaryOf(project.plan);
  return (
    <article className="rounded-[14px] border border-border bg-surface p-4 shadow-[var(--rb-shadow)]">
      <div className="flex items-start justify-between gap-2.5">
        <div className="min-w-0 text-[14px] font-semibold wrap-anywhere">
          <span className="mr-1 inline-block rounded-[5px] border border-border bg-surface2 px-1.5 py-px align-middle font-mono text-[10.5px] font-normal text-muted">
            {project.slug}
          </span>
          {project.title}
        </div>
        <span
          className="max-w-[45%] flex-none truncate rounded-full border border-border bg-surface2 px-2 py-0.5 text-[11px] text-muted"
          title={project.status || "未登记"}
        >
          {project.status || "未登记"}
        </span>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-muted">
        <span>更新 {project.updated_at_local || "—"}</span>
        <span>计划 {project.plan ? `${project.plan.split("\n").length} 行` : "缺"}</span>
        <span>上下文 {project.context ? `${project.context.split("\n").length} 行` : "缺"}</span>
      </div>
      {summary ? (
        <p className="mb-0 mt-2.5 max-h-[5.6em] overflow-hidden whitespace-pre-wrap text-[12px] leading-relaxed text-muted">
          {summary}
        </p>
      ) : (
        <p className="mb-0 mt-2.5 text-[12px] text-faint">plan.md 还没有内容。</p>
      )}
      <div className="mt-3 flex gap-1.5">
        <Button variant="ghost" size="sm" onClick={onOpen}>
          查看 / 编辑
        </Button>
      </div>
    </article>
  );
}

function ProjectDrawer({
  project,
  onClose,
  onSaved,
}: {
  project: Project;
  onClose: () => void;
  onSaved: (project: Project) => void;
}) {
  const request = useApi();
  const [tab, setTab] = useState<DocTab>("plan");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(project.plan);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const text = tab === "plan" ? project.plan : project.context;
  const file = `${project.path}/${tab === "plan" ? "plan.md" : "context.md"}`;

  const selectTab = (next: DocTab) => {
    setTab(next);
    setDraft(next === "plan" ? project.plan : project.context);
    setEditing(false);
    setError("");
  };

  const startEdit = () => {
    setDraft(text);
    setEditing(true);
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
        {editing ? (
          <Button variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={busy}>
            取消编辑
          </Button>
        ) : (
          <Button variant="ghost" size="sm" onClick={startEdit}>
            编辑
          </Button>
        )}
      </div>
      {project.status ? (
        <p className="mb-2 text-[12px] text-muted">状态：{project.status}</p>
      ) : null}
      {error ? <StatusText text={error} error /> : null}
      {editing ? (
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

export function ProjectsPage({ reloadSignal }: { reloadSignal: number }) {
  const request = useApi();
  const [rows, setRows] = useState<Project[]>([]);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: "" });
  const [openSlug, setOpenSlug] = useState<string | null>(null);

  const load = useCallback(async () => {
    setStatus({ text: "加载中…" });
    try {
      setRows(await request<Project[]>("/v1/projects"));
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

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((p) =>
      [p.slug, p.title, p.status, p.plan, p.context].some((x) => x.toLowerCase().includes(q)),
    );
  }, [rows, query]);

  const current = openSlug ? rows.find((p) => p.slug === openSlug) ?? null : null;

  const onSaved = (updated: Project) => {
    setRows((prev) => prev.map((p) => (p.slug === updated.slug ? updated : p)));
    setStatus({ text: "" });
  };

  return (
    <Page>
      <PageHead
        eyebrow="Projects"
        title="项目"
        sub="直接读 shared/projects/<slug>/：context.md 是项目上下文，plan.md 是当前目标、进行中和下一步。"
        actions={
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜项目 / 计划 / 上下文"
            className="w-[220px] max-sm:w-[180px]"
          />
        }
      />

      <StatusText text={status.text} error={status.error} />

      {!rows.length && !status.text ? (
        <Empty>
          没有项目。Agent 在 shared/projects/&lt;slug&gt;/ 下建 context.md 和 plan.md 后，这里会自动出现。
        </Empty>
      ) : !visible.length ? (
        <Empty>没有匹配的项目。</Empty>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(330px,1fr))] items-start gap-3">
          {visible.map((p) => (
            <ProjectCard key={p.slug} project={p} onOpen={() => setOpenSlug(p.slug)} />
          ))}
        </div>
      )}

      {current ? (
        <ProjectDrawer
          key={current.slug}
          project={current}
          onClose={() => setOpenSlug(null)}
          onSaved={onSaved}
        />
      ) : null}
    </Page>
  );
}
