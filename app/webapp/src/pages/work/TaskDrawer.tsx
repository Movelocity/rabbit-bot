import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useApi, useApiBlob } from "../../lib/api-context.tsx";
import { cx } from "../../lib/cx.ts";
import { badgeVariant, duration, formatTs, friendlyError } from "../../lib/format.ts";
import type { OutputFile, OutputNode, Project, TaskSnapshot, TaskView } from "../../lib/types.ts";
import { Badge, Button, Field, Input, Segmented, StatusText, Textarea } from "../../components/ui.tsx";
import { Drawer } from "../../components/Drawer.tsx";
import { Modal } from "../../components/Modal.tsx";
import { DetailRows, type DetailRow } from "../../components/DetailRows.tsx";
import { FilePreview, IMAGE_EXTS, extOf, flattenFiles, formatBytes } from "./FilePreview.tsx";
import { STATUS_LABEL } from "./shared.ts";

type DrawerTab = "detail" | "events" | "outputs";

function executorConfirmText(executor: string): string {
  if (executor === "mimo") return "mimo";
  if (executor === "codex") return "codex（带 --dangerously-bypass-approvals-and-sandbox）";
  if (executor === "claude") return "claude（带 --permission-mode bypassPermissions）";
  return "opencode（带 --dangerously-skip-permissions）";
}

function buildDetailRows(t: TaskView): DetailRow[] {
  const rows: DetailRow[] = [];
  const add = (label: string, value: ReactNode, mono = false) => {
    if (value === null || value === undefined || String(value).trim() === "") return;
    rows.push({ label, value, mono });
  };
  add("goal", t.goal);
  add("deliverable", t.deliverable);
  add("constraints", t.constraints);
  add("acceptance", t.acceptance);
  add("result", t.result);
  add("artifact", t.artifact, true);
  add("work_dir", t.work_dir, true);
  add("model", t.model, true);
  add("stage", t.stage);
  add("attempt", t.attempt ? `第 ${t.attempt} 次` : "");
  add("eta", t.eta_ms ? `${Math.round(t.eta_ms / 60_000)} 分钟（超时在任务群提醒）` : "");
  add("executor", t.executor || "opencode");
  add("worker_id", t.worker_id, true);
  add("start_at", t.start_at_local || formatTs(t.start_at));
  add("end_at", t.end_at_local || (t.end_at ? formatTs(t.end_at) : ""));
  add("updated", t.updated_at_local || formatTs(t.updated_at));
  add("session_id", t.session_id, true);
  add("doc_path", t.doc_path, true);
  add("note", t.note);
  const ctx = t.context || {};
  const ctxLines = [
    ctx.objects?.length ? `objects: ${ctx.objects.join(", ")}` : "",
    ctx.relations?.length ? `relations: ${ctx.relations.join(", ")}` : "",
    ctx.forbidden?.length ? `forbidden: ${ctx.forbidden.join(", ")}` : "",
  ].filter(Boolean);
  if (ctxLines.length) add("context", ctxLines.join("\n"));
  if (t.files && t.files !== "[]") {
    let files: string = t.files;
    try {
      files = (JSON.parse(t.files) as string[]).join("\n");
    } catch {}
    add("files", files, true);
  }
  return rows;
}

function TaskApprovalForm({
  task,
  onDone,
  setStatus,
}: {
  task: TaskView;
  onDone: () => Promise<void> | void;
  setStatus: (status: { text: string; error?: boolean }) => void;
}) {
  const request = useApi();
  const [name, setName] = useState(task.name || "");
  const [goal, setGoal] = useState(task.goal || "");
  const [deliverable, setDeliverable] = useState(task.deliverable || "");
  const [constraints, setConstraints] = useState(task.constraints || "");
  const [acceptance, setAcceptance] = useState(task.acceptance || "");
  const [etaMin, setEtaMin] = useState(task.eta_ms ? String(Math.round(task.eta_ms / 60_000)) : "");
  const [rejectReason, setRejectReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const approve = async () => {
    const body: Record<string, string> = {};
    const collect = (key: keyof TaskView, value: string) => {
      if (value !== String(task[key] ?? "")) body[key] = value;
    };
    collect("name", name);
    collect("goal", goal);
    collect("deliverable", deliverable);
    collect("constraints", constraints);
    collect("acceptance", acceptance);
    const origEta = task.eta_ms ? String(Math.round(task.eta_ms / 60_000)) : "";
    if (etaMin.trim() !== origEta) body.eta = etaMin.trim() || "0";

    setConfirming(false);
    setBusy(true);
    setStatus({ text: "审批通过，正在启动…" });
    try {
      await request(`/v1/tasks/${task.id}/approve`, { method: "POST", body });
      setStatus({ text: `任务 #${task.id} 已通过并启动。` });
      await onDone();
    } catch (e) {
      setStatus({ text: `审批失败：${friendlyError(e)}`, error: true });
      setBusy(false);
    }
  };

  const reject = async () => {
    const reason = rejectReason.trim();
    if (!reason) {
      setStatus({ text: "驳回原因必填：写清楚为什么不通过。", error: true });
      return;
    }
    setBusy(true);
    setStatus({ text: "正在驳回…" });
    try {
      await request(`/v1/tasks/${task.id}/reject`, { method: "POST", body: { reason, by: "web" } });
      setStatus({ text: `任务 #${task.id} 已驳回，未执行。` });
      await onDone();
    } catch (e) {
      setStatus({ text: `驳回失败：${friendlyError(e)}`, error: true });
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-amber/40 bg-amber-soft/50 p-3.5">
      <h3 className="m-0 mb-2.5 text-sm font-semibold">审批并执行</h3>
      <div className="grid gap-2.5">
        <Field label="name">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="goal">
          <Textarea className="min-h-[72px]" value={goal} onChange={(e) => setGoal(e.target.value)} />
        </Field>
        <Field label="deliverable">
          <Textarea className="min-h-[60px]" value={deliverable} onChange={(e) => setDeliverable(e.target.value)} />
        </Field>
        <Field label="constraints">
          <Textarea className="min-h-[60px]" value={constraints} onChange={(e) => setConstraints(e.target.value)} />
        </Field>
        <Field label="acceptance">
          <Textarea className="min-h-[60px]" value={acceptance} onChange={(e) => setAcceptance(e.target.value)} />
        </Field>
        <Field label="预估耗时（分钟，超时在任务群提醒）">
          <Input value={etaMin} onChange={(e) => setEtaMin(e.target.value)} placeholder="30（留空用默认 10 分钟）" />
        </Field>
        <Field label="驳回原因（驳回时必填）">
          <Textarea rows={2} value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} placeholder="写清楚为什么不通过" />
        </Field>
      </div>
      <p className="mt-2.5 text-xs text-muted">
        优先在飞书审批房给任务提示贴 OK；这里是备用入口。work_dir / executor / model 只读。
      </p>
      <div className="mt-2.5 flex gap-2">
        <Button variant="primary" size="sm" disabled={busy} onClick={() => setConfirming(true)}>
          通过并执行
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void reject()}>
          驳回
        </Button>
      </div>

      {confirming && (
        <Modal title={`通过并执行 #${task.id}？`} onClose={() => setConfirming(false)}>
          <p className="m-0 text-sm leading-relaxed text-muted">
            通过后会立即以无审批模式启动 {executorConfirmText(task.executor)}，可能执行任意命令。请确认你已经了解风险。
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              取消
            </Button>
            <Button variant="primary" size="sm" onClick={() => void approve()}>
              确认通过
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** 任务产出：直接在抽屉里列文件 + 预览，不用跳页 */
function TaskOutputs({
  files,
  onOpenInBrowser,
}: {
  files: OutputNode[];
  onOpenInBrowser: (path: string) => void;
}) {
  const request = useApi();
  const requestBlob = useApiBlob();
  const [selected, setSelected] = useState("");
  const [file, setFile] = useState<OutputFile | null>(null);
  const [imageUrl, setImageUrl] = useState("");
  const [error, setError] = useState("");
  const seq = useRef(0);

  useEffect(() => () => {
    if (imageUrl) URL.revokeObjectURL(imageUrl);
  }, [imageUrl]);

  const open = useCallback(
    async (path: string) => {
      const n = ++seq.current;
      setSelected(path);
      setFile(null);
      setImageUrl("");
      setError("");
      try {
        const data = await request<OutputFile>(`/v1/outputs/file?path=${encodeURIComponent(path)}`);
        if (n !== seq.current) return;
        setFile(data);
        if (IMAGE_EXTS.has(data.ext)) {
          const blob = await requestBlob(`/v1/outputs/raw?path=${encodeURIComponent(path)}`);
          if (n !== seq.current) return;
          setImageUrl(URL.createObjectURL(blob));
        }
      } catch (e) {
        if (n === seq.current) setError(`预览失败：${friendlyError(e)}`);
      }
    },
    [request, requestBlob],
  );

  if (!files.length) {
    return (
      <p className="text-[13px] leading-relaxed text-muted">
        这个任务还没有产出。执行器完成后会把交付物写到 <code className="font-mono">outputs/task-&lt;id&gt;/</code>。
      </p>
    );
  }

  if (selected) {
    return (
      <div>
        <div className="mb-2.5 flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setSelected("")}>
            ← 文件列表
          </Button>
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-faint" title={selected}>
            {selected}
          </span>
          <Button variant="ghost" size="sm" onClick={() => onOpenInBrowser(selected)}>
            在产出中打开
          </Button>
        </div>
        {error ? <StatusText text={error} error /> : file ? <FilePreview file={file} imageUrl={imageUrl} /> : (
          <p className="text-[13px] text-muted">加载中…</p>
        )}
      </div>
    );
  }

  return (
    <ul className="m-0 grid list-none gap-1.5 p-0">
      {files.map((f) => {
        const rel = f.path.split("/").slice(1).join("/");
        return (
          <li key={f.path}>
            <button
              type="button"
              className="flex w-full items-center gap-2.5 rounded-[10px] border border-border bg-surface px-2.5 py-2 text-left transition hover:border-accent/45 hover:bg-accent-soft/30"
              onClick={() => void open(f.path)}
            >
              <span className="w-[34px] flex-none rounded-[4px] border border-border bg-surface2 py-px text-center font-mono text-[9px] font-bold uppercase text-muted">
                {(extOf(f.name) || "file").slice(0, 4)}
              </span>
              <span className="min-w-0 flex-1 truncate text-[12.5px]" title={rel}>
                {rel}
              </span>
              <span className="flex-none text-[10.5px] tabular-nums text-faint">{formatBytes(f.bytes)}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function TaskDrawer({
  task,
  outputs,
  projects,
  initialTab = "detail",
  onClose,
  onChanged,
  onOpenProject,
  onOpenOutput,
}: {
  task: TaskView;
  /** outputs/task-<id> 子树 */
  outputs: OutputNode | null;
  projects: Map<string, Project>;
  initialTab?: DrawerTab;
  onClose: () => void;
  onChanged: () => Promise<void> | void;
  onOpenProject: (slug: string) => void;
  onOpenOutput: (path: string) => void;
}) {
  const request = useApi();
  const [tab, setTab] = useState<DrawerTab>(initialTab);
  const [snap, setSnap] = useState<TaskSnapshot | null>(null);
  const [snapError, setSnapError] = useState("");
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: "" });

  const loadSnap = useCallback(async () => {
    try {
      setSnap(await request<TaskSnapshot>(`/v1/tasks/${task.id}/snapshot`));
      setSnapError("");
    } catch (e) {
      setSnapError(`任务快照加载失败：${friendlyError(e)}`);
    }
  }, [request, task.id]);

  // 任务每次更新（列表 3 秒轮询带来新的 updated_at）顺带刷新事件
  useEffect(() => {
    void loadSnap();
  }, [loadSnap, task.updated_at]);

  const files = outputs ? flattenFiles(outputs.children ?? []) : [];
  const events = snap?.recent_events ?? [];
  const elapsed = task.start_at ? duration(Number(task.end_at ?? Date.now()) - Number(task.start_at)) : "";

  return (
    <Drawer
      title={
        <span className="inline-flex flex-wrap items-baseline gap-2">
          <span className="font-mono text-[13px] font-normal text-faint">#{task.id}</span>
          {task.name || "任务详情"}
        </span>
      }
      onClose={onClose}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant={badgeVariant(task.status)}>{STATUS_LABEL[task.status] || task.status}</Badge>
        {task.stage ? (
          <span className="rounded-[5px] border border-border bg-surface2 px-1.5 py-px font-mono text-[10.5px] text-muted">
            {task.stage}
          </span>
        ) : null}
        <span className="text-[11px] text-faint">{task.executor || "opencode"}</span>
        {elapsed ? <span className="text-[11px] text-faint">· 用时 {elapsed}</span> : null}
      </div>

      {task.projects?.length ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
          <span>项目</span>
          {task.projects.map((slug) => (
            <button
              key={slug}
              type="button"
              className="rounded-full border border-accent/35 bg-accent-soft px-2 py-0.5 text-[11px] text-accent-ink transition hover:border-accent"
              onClick={() => onOpenProject(slug)}
            >
              {projects.get(slug)?.title || slug} →
            </button>
          ))}
        </div>
      ) : null}

      {task.goal ? (
        <p className="mb-0 mt-3 rounded-[10px] border border-border bg-surface2 px-3 py-2.5 text-[12.5px] leading-relaxed">
          {task.goal}
        </p>
      ) : null}

      {task.status === "pending_approval" ? (
        <div className="mt-3">
          <TaskApprovalForm
            key={task.id}
            task={task}
            setStatus={setStatus}
            onDone={async () => {
              await onChanged();
            }}
          />
        </div>
      ) : null}
      <StatusText text={status.text} error={status.error} />

      <div className="mb-3 mt-1">
        <Segmented
          value={tab}
          onChange={setTab}
          label="任务抽屉视图"
          options={[
            { value: "detail", label: "详情" },
            { value: "events", label: `事件 ${events.length || ""}`.trim() },
            { value: "outputs", label: `产出 ${files.length || ""}`.trim() },
          ]}
        />
      </div>

      {tab === "detail" ? (
        <DetailRows className="mt-0 border-t-0 pt-0" rows={buildDetailRows(task)} />
      ) : tab === "events" ? (
        snapError ? (
          <StatusText text={snapError} error />
        ) : !snap ? (
          <p className="text-[13px] text-muted">正在加载任务快照…</p>
        ) : !events.length ? (
          <p className="text-[13px] text-muted">还没收到任务事件。</p>
        ) : (
          <ol className="m-0 grid list-none gap-0 p-0">
            {events.map((ev) => (
              <li
                key={ev.seq}
                className={cx(
                  "relative pb-3 pl-4 text-[11.5px] text-muted",
                  "before:absolute before:left-0.5 before:top-1.5 before:size-[7px] before:rounded-full before:bg-line-strong",
                  "after:absolute after:bottom-0 after:left-[5px] after:top-4 after:w-px after:bg-border last:after:hidden",
                )}
              >
                <b className="text-text">
                  {ev.local || formatTs(ev.ts)} · {ev.sender || "task"}
                </b>
                <div className="mt-0.5 whitespace-pre-wrap wrap-anywhere">{ev.text || ""}</div>
              </li>
            ))}
          </ol>
        )
      ) : (
        <TaskOutputs key={task.id} files={files} onOpenInBrowser={onOpenOutput} />
      )}
    </Drawer>
  );
}
