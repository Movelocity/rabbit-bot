import { useState } from "react";
import { useApi } from "../../lib/api-context.tsx";
import { cx } from "../../lib/cx.ts";
import { friendlyError } from "../../lib/format.ts";
import { nextStepOf } from "../../lib/plan.ts";
import type { Project } from "../../lib/types.ts";
import { Button, Chip, Segmented, StatusText, Textarea } from "../../components/ui.tsx";
import { MarkdownBlock } from "./FilePreview.tsx";
import { isMissingDoc } from "./shared.ts";

/** 项目页顶部：只放身份和下一步，说明书收到右侧栏。 */
export function ProjectHeader({ project, outputs }: { project: Project; outputs: number }) {
  const missing = isMissingDoc(project);
  const next = nextStepOf(project.plan);
  return (
    <div className="mb-5">
      <div className="flex flex-wrap items-center gap-1.5">
        {project.status ? <Chip>{project.status}</Chip> : null}
        {missing ? <Chip tone="amber">缺说明书</Chip> : null}
        {outputs ? <Chip>产出 {outputs}</Chip> : null}
      </div>
      <h1 className="rb-display mb-0 mt-1.5 text-[23px] leading-tight wrap-anywhere">{project.title}</h1>
      <p className="mb-0 mt-1 max-w-[620px] text-[12px] leading-relaxed text-muted">
        项目长期存在，可能按里程碑推进；任务是当前切片的索引，任务全部结束也不代表项目结束。
      </p>
      <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-border pt-2.5">
        <span className="flex-none text-[10px] font-semibold uppercase tracking-[0.08em] text-faint">下一步</span>
        <span className={cx("min-w-0 flex-1 text-[12px] leading-relaxed", next ? "text-text" : "text-faint")}>
          {next || "plan.md 还没有内容。"}
        </span>
      </div>
    </div>
  );
}

type DocTab = "plan" | "context";

/** 项目说明书：右侧窄栏，默认只露一段，展开后可滚动看全文。 */
export function ProjectDocs({ project, onSaved }: { project: Project; onSaved: (project: Project) => void }) {
  const request = useApi();
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
    <aside className="min-w-0 xl:sticky xl:top-4 xl:h-[calc(100dvh-10rem)]">
      <div className="flex h-full flex-col rounded-[10px] border border-border bg-surface p-3">
        <div className="flex-none">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="m-0 text-[13px] font-semibold">项目说明书</h2>
          <Segmented
            value={tab}
            onChange={selectTab}
            label="项目文件"
            options={[
              { value: "plan", label: "计划" },
              { value: "context", label: "上下文" },
            ]}
          />
        </div>
        <div className="mt-1.5 flex items-center gap-1">
          <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-faint" title={file}>
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
        </div>

        {error ? (
          <div className="flex-none">
            <StatusText text={error} error />
          </div>
        ) : null}
        {editing ? (
          <>
            <Textarea
              rows={12}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "s") {
                  e.preventDefault();
                  void save();
                }
              }}
              className="mt-2 min-h-0 flex-1 font-mono text-[12px] leading-relaxed"
            />
            <div className="mt-2 flex flex-none items-center justify-end gap-2">
              <span className="text-[10.5px] text-faint">⌘/Ctrl + S</span>
              <Button variant="primary" size="sm" onClick={() => void save()} disabled={busy}>
                {busy ? "保存中…" : "保存"}
              </Button>
            </div>
          </>
        ) : text.trim() ? (
          <div className="rb-thin-scroll mt-2 min-h-0 flex-1 overflow-y-auto max-h-[50dvh] xl:max-h-none">
            <MarkdownBlock
              text={text}
              className="rb-markdown rounded-[8px] border border-border bg-bg px-3 py-2.5 text-[12.5px]"
            />
          </div>
        ) : (
          <p className="mb-0 mt-2 flex-none text-[12.5px] text-muted">这个文件还没有内容。</p>
        )}
      </div>
    </aside>
  );
}