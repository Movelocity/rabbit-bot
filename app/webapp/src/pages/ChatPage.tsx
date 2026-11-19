import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { useApi } from "../lib/api-context.tsx";
import { usePolling } from "../lib/use-polling.ts";
import { cx } from "../lib/cx.ts";
import { badgeVariant, duration, formatTs, friendlyError, kindLabel, platformLabel } from "../lib/format.ts";
import type {
  OutputEntry,
  OutputFile,
  Pool,
  PoolMessage,
  PoolMessages,
  SendReviewSettingsResponse,
  TaskSnapshot,
  TaskStatus,
  TaskView,
} from "../lib/types.ts";
import { Badge, Button, Chip, Empty, Input, Notice, Segmented, StatusText, Textarea } from "../components/ui.tsx";
import { Drawer } from "../components/Drawer.tsx";
import { DetailRows, type DetailRow } from "../components/DetailRows.tsx";

type PoolReviewMode = "inherit" | "review" | "direct";

function mergeMessages(prev: PoolMessage[], incoming: PoolMessage[]): PoolMessage[] {
  const map = new Map(prev.map((m) => [m.seq, m]));
  for (const m of incoming) map.set(m.seq, m);
  return [...map.values()].sort((a, b) => a.seq - b.seq);
}

function initial(value: string | null | undefined): string {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, 1) : "?";
}

function poolBucketKind(pool: Pool): string {
  // 网页直聊单独成组：它不是 IM 私聊，交互也和管理台读别的池不一样
  if (pool.platform === "web") return "web";
  return pool.kind || "group";
}

const BUCKET_LABEL: Record<string, string> = {
  web: "网页直聊",
  private: "私聊",
  group: "群聊",
  task: "任务",
};

function taskIdOfPool(pool: Pool | undefined): number | null {
  if (!pool) return null;
  if (typeof pool.task_id === "number" && pool.task_id > 0) return pool.task_id;
  const m = /^task:task:(\d+)$/.exec(pool.pool_id);
  return m ? Number(m[1]) : null;
}

function poolDisplayName(p: Pool): string {
  return (p.task_name || p.title || p.alias).trim();
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

function TaskDetailPanel({ snap }: { snap: TaskSnapshot | null }) {
  if (!snap) return <p className="text-[13px] text-muted">正在加载任务快照…</p>;
  const t = snap.task;
  const rows: DetailRow[] = [];
  const add = (label: string, value: ReactNode, mono = false) => {
    if (value === null || value === undefined || String(value).trim() === "") return;
    rows.push({ label, value, mono });
  };
  add("status", t.status ? <Badge variant={badgeVariant(t.status)}>{t.status}</Badge> : "");
  add("goal", t.goal);
  add("deliverable", t.deliverable);
  add("result", t.result);
  add("artifact", t.artifact, true);
  add("work_dir", t.work_dir, true);
  add("executor", t.executor || "opencode");
  add("model", t.model, true);
  add("doc_path", t.doc_path, true);
  add("updated", t.updated_at_local || formatTs(t.updated_at));
  return (
    <>
      {rows.length ? (
        <DetailRows rows={rows} className="mt-0 border-t-0 pt-0" />
      ) : (
        <p className="text-[13px] text-muted">任务没有更多详情。</p>
      )}
      <h3 className="mb-2 mt-5 text-[13px] font-semibold">最近事件</h3>
      {snap.recent_events.length ? (
        <ol className="m-0 grid list-none gap-2 p-0">
          {snap.recent_events.map((ev) => (
            <li key={ev.seq} className="rounded-[9px] border border-border bg-surface2 px-2.5 py-2 text-[11.5px] text-muted">
              <b className="text-text">{ev.local || formatTs(ev.ts)} · {ev.sender || "task"}</b>
              <div className="mt-0.5 whitespace-pre-wrap wrap-anywhere">{ev.text || ""}</div>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-[13px] text-muted">还没有任务事件。</p>
      )}
    </>
  );
}

function TaskDocPanel({ taskId }: { taskId: number }) {
  const request = useApi();
  const [doc, setDoc] = useState<{ path: string; exists: boolean; content: string } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    setDoc(null);
    setError("");
    request<{ path: string; exists: boolean; content: string }>(`/v1/tasks/${taskId}/doc`)
      .then((d) => { if (alive) setDoc(d); })
      .catch((e) => { if (alive) setError(`读取任务指导文件失败：${friendlyError(e)}`); });
    return () => { alive = false; };
  }, [taskId, request]);

  if (error) return <StatusText text={error} error />;
  if (!doc) return <p className="text-[13px] text-muted">正在读取任务指导文件…</p>;
  if (!doc.exists) {
    return (
      <p className="text-[13px] text-muted">
        任务指导文件还没生成（审批通过后写入）。审批通过后可从任务页或这里查看。
      </p>
    );
  }
  return (
    <>
      <p className="m-0 mb-2.5 break-all font-mono text-[11px] text-faint">{doc.path}</p>
      <MarkdownBlock text={doc.content} />
    </>
  );
}

function TaskOutputsPanel({ taskId }: { taskId: number }) {
  const request = useApi();
  const base = `task-${taskId}`;
  const [dir, setDir] = useState(base);
  const [entries, setEntries] = useState<OutputEntry[]>([]);
  const [file, setFile] = useState<OutputFile | null>(null);
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: "" });

  const loadDir = useCallback(
    async (path: string) => {
      setStatus({ text: "加载中…" });
      try {
        setEntries(await request<OutputEntry[]>(`/v1/outputs?path=${encodeURIComponent(path)}`));
        setStatus({ text: "" });
      } catch (e) {
        setEntries([]);
        // 任务还没有产出时目录不存在，按空列表处理；子目录读取失败才报错
        setStatus(path === base ? { text: "" } : { text: `读取产出失败：${friendlyError(e)}`, error: true });
      }
    },
    [request, base],
  );

  useEffect(() => {
    setFile(null);
    setDir(base);
    void loadDir(base);
  }, [base, loadDir]);

  const openDir = (path: string) => {
    setFile(null);
    setDir(path);
    void loadDir(path);
  };

  const openFile = async (path: string) => {
    setStatus({ text: "加载中…" });
    try {
      setFile(await request<OutputFile>(`/v1/outputs/file?path=${encodeURIComponent(path)}`));
      setStatus({ text: "" });
    } catch (e) {
      setStatus({ text: `读取文件失败：${friendlyError(e)}`, error: true });
    }
  };

  const parent = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";

  if (file) {
    return (
      <>
        <div className="mb-2.5 flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setFile(null)}>
            返回列表
          </Button>
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-faint">{file.path}</span>
        </div>
        {file.binary ? (
          <p className="text-[13px] text-muted">二进制文件，暂不支持预览。</p>
        ) : file.ext === "md" ? (
          <MarkdownBlock text={file.content} />
        ) : (
          <pre className="rb-thin-scroll max-h-[calc(100dvh-220px)] overflow-auto rounded-[10px] border border-border bg-surface2 p-3 text-[12px] leading-relaxed">
            {file.content}
          </pre>
        )}
      </>
    );
  }

  return (
    <>
      <p className="m-0 mb-2.5 break-all font-mono text-[11px] text-faint">outputs/{dir}/</p>
      <StatusText text={status.text} error={status.error} />
      {dir !== base ? (
        <Button variant="ghost" size="sm" className="mb-2" onClick={() => openDir(parent || base)}>
          上一级
        </Button>
      ) : null}
      {entries.length ? (
        <div className="grid gap-1.5">
          {entries.map((e) =>
            e.kind === "dir" ? (
              <button
                key={e.path}
                type="button"
                className="flex items-center gap-2 rounded-[9px] border border-border bg-surface px-2.5 py-2 text-left text-[12.5px] transition hover:border-accent/45 hover:bg-accent-soft/30"
                onClick={() => openDir(e.path)}
              >
                <span className="text-faint">▸</span>
                <span className="min-w-0 flex-1 truncate">{e.name}/</span>
              </button>
            ) : (
              <button
                key={e.path}
                type="button"
                className="flex items-center gap-2 rounded-[9px] border border-border bg-surface px-2.5 py-2 text-left text-[12.5px] transition hover:border-accent/45 hover:bg-accent-soft/30"
                onClick={() => void openFile(e.path)}
              >
                <span className="min-w-0 flex-1 truncate">{e.name}</span>
                <span className="flex-none text-[10.5px] text-faint">{e.bytes ?? 0} B</span>
              </button>
            ),
          )}
        </div>
      ) : (
        <p className="text-[13px] text-muted">
          {dir === base ? "这个任务还没有产出。WA 完成后会把交付物写到 outputs/task-" + taskId + "/。" : "空目录。"}
        </p>
      )}
    </>
  );
}


const STATUS_LABEL: Record<string, string> = {
  pending_approval: "待审批",
  pending: "排队中",
  running: "执行中",
  blocked: "已阻塞",
  done: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

type StageState = "done" | "now" | "todo" | "bad";

function taskStages(
  status: TaskStatus | undefined,
  stage: string | undefined,
): { label: string; hint: string; state: StageState }[] {
  const queued = status === "pending";
  const waiting = status === "pending_approval";
  const active = status === "running" || status === "blocked";
  const finished = status === "done";
  const stopped = status === "failed" || status === "cancelled";
  const known = Boolean(status);
  return [
    { label: "创建", hint: "任务已入池", state: "done" },
    {
      label: "审批",
      hint: waiting ? "等待审批" : stopped ? "未启动" : known ? "已通过" : "—",
      state: waiting ? "now" : stopped || !known ? "todo" : "done",
    },
    {
      label: "执行",
      hint: active
        ? stage || STATUS_LABEL[status ?? ""] || "执行中"
        : finished
          ? "执行结束"
          : queued
            ? "排队中"
            : waiting
              ? "等待审批"
              : "—",
      state: active
        ? status === "blocked"
          ? "bad"
          : "now"
        : finished
          ? "done"
          : stopped
            ? "bad"
            : "todo",
    },
    {
      label: "交付",
      hint: finished ? "任务已结束" : stopped ? "已中止" : "等待产出",
      state: finished ? "done" : "todo",
    },
  ];
}

function eventClock(event: { local?: string; ts: number }): string {
  return (event.local || formatTs(event.ts)).match(/\d{2}:\d{2}/)?.[0] || "—";
}

function TaskExecBoard({
  taskId,
  pool,
  snap,
  total,
  pending,
  decidingId,
  rejectingId,
  rejectReason,
  onRejectReasonChange,
  onDecide,
  onStartReject,
  onCancelReject,
  onOpenPanel,
  onOpenTask,
}: {
  taskId: number;
  pool: Pool | undefined;
  snap: TaskSnapshot | null;
  total: number;
  pending: Set<number> | null;
  decidingId: number | null;
  rejectingId: number | null;
  rejectReason: string;
  onRejectReasonChange: (value: string) => void;
  onDecide: (id: number, action: "approve" | "reject", reason?: string) => void;
  onStartReject: (id: number) => void;
  onCancelReject: () => void;
  onOpenPanel: (panel: "detail" | "doc" | "outputs") => void;
  onOpenTask?: (id: number) => void;
}) {
  const task = snap?.task;
  const status = task?.status || pool?.task_status || undefined;
  const stages = taskStages(status, task?.stage);
  const isPending = pending?.has(taskId) ?? false;
  const busy = decidingId === taskId;
  const elapsed = task?.start_at
    ? duration(Number(task.end_at ?? Date.now()) - Number(task.start_at))
    : "—";
  const events = snap?.recent_events ?? [];
  const action = isPending
    ? "等待审批后启动"
    : (task?.note || "").trim() || (task?.stage || "").trim() || STATUS_LABEL[status ?? ""] || "—";
  const active = status === "running" || status === "pending_approval" || status === "blocked" || status === "pending";

  return (
    <>
      <section className="mb-2.5 rounded-[11px] border border-border bg-surface p-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-faint">执行台</div>
          <span className="font-mono text-[10.5px] text-faint">#{taskId}</span>
          {status ? <Badge variant={badgeVariant(status)}>{STATUS_LABEL[status] || status}</Badge> : null}
        </div>
        {task?.goal ? (
          <p className="mb-2.5 line-clamp-3 text-[11.5px] leading-relaxed text-muted">{task.goal}</p>
        ) : null}
        <ol className="m-0 grid list-none gap-0 p-0">
          {stages.map((step, index) => (
            <li
              key={step.label}
              className={cx(
                "relative grid grid-cols-[16px_minmax(0,1fr)] gap-2.5 pb-3 text-[11.5px] last:pb-0",
                step.state === "done" && "text-muted",
                step.state === "now" && "font-semibold text-accent-ink",
                step.state === "todo" && "text-faint",
                step.state === "bad" && "text-bad",
              )}
            >
              {index < stages.length - 1 ? (
                <span className="absolute bottom-0 left-[7px] top-[17px] w-px bg-border" aria-hidden="true" />
              ) : null}
              <span
                className={cx(
                  "relative z-[1] mt-0.5 size-[15px] rounded-full border",
                  step.state === "done" && "border-accent bg-accent",
                  step.state === "now" && "border-accent bg-accent ring-2 ring-accent-soft",
                  step.state === "bad" && "border-bad bg-rose-soft",
                  step.state === "todo" && "border-line-strong bg-surface",
                )}
              />
              <span className="min-w-0">
                {step.label}
                <small className="mt-0.5 block text-[10px] font-normal text-faint">{step.hint}</small>
              </span>
            </li>
          ))}
        </ol>
        <div className="mt-3 grid grid-cols-3 gap-1.5">
          <div className="rounded-[9px] border border-border bg-surface2 px-2 py-1.5">
            <b className="rb-display block text-[15px] leading-tight">{elapsed}</b>
            <span className="text-[9.5px] text-faint">用时</span>
          </div>
          <div className="rounded-[9px] border border-border bg-surface2 px-2 py-1.5">
            <b className="rb-display block text-[15px] leading-tight">{total || pool?.total || 0}</b>
            <span className="text-[9.5px] text-faint">消息</span>
          </div>
          <div className="rounded-[9px] border border-border bg-surface2 px-2 py-1.5">
            <b className="rb-display block text-[15px] leading-tight">{events.length}</b>
            <span className="text-[9.5px] text-faint">近期事件</span>
          </div>
        </div>
      </section>

      <section className="mb-2.5 rounded-[11px] border border-border bg-surface p-3">
        <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.1em] text-faint">当前动作</div>
        <div
          className={cx(
            "rounded-[9px] border px-2.5 py-2 text-[11.5px] leading-relaxed",
            active
              ? "border-amber/40 bg-amber-soft text-[color:var(--rb-amber)]"
              : "border-border bg-surface2 text-muted",
          )}
        >
          {action}
        </div>
      </section>

      {isPending ? (
        <section className="mb-2.5 rounded-[11px] border border-amber/40 bg-amber-soft p-3">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-amber">待处理</span>
            <span className="text-[11.5px] font-semibold">启动任务 #{taskId}</span>
          </div>
          {rejectingId === taskId ? (
            <div className="grid gap-2">
              <Input
                value={rejectReason}
                onChange={(e) => onRejectReasonChange(e.target.value)}
                placeholder="驳回原因（必填）"
                aria-label={`任务 #${taskId} 驳回原因`}
                className="h-8 py-1 text-[12px]"
              />
              <div className="flex flex-wrap gap-1.5">
                <Button
                  variant="primary"
                  size="sm"
                  disabled={!rejectReason.trim() || busy}
                  onClick={() => onDecide(taskId, "reject", rejectReason.trim())}
                >
                  {busy ? "驳回中…" : "确认驳回"}
                </Button>
                <Button variant="ghost" size="sm" disabled={busy} onClick={onCancelReject}>
                  取消
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              <Button variant="primary" size="sm" disabled={busy} onClick={() => onDecide(taskId, "approve")}>
                {busy ? "处理中…" : "同意并启动"}
              </Button>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => onStartReject(taskId)}>
                驳回
              </Button>
            </div>
          )}
        </section>
      ) : null}

      <section className="mb-2.5 rounded-[11px] border border-border bg-surface p-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-faint">产出</div>
          <span className="text-[10px] text-faint">outputs/task-{taskId}/</span>
        </div>
        <dl className="rb-kv">
          <dt>artifact</dt>
          <dd className="font-mono text-[10.5px]">{task?.artifact || "—"}</dd>
          <dt>work_dir</dt>
          <dd className="font-mono text-[10.5px]">{task?.work_dir || "—"}</dd>
          <dt>executor</dt>
          <dd>{task?.executor || "opencode"}</dd>
        </dl>
      </section>

      <section className="mb-2.5 rounded-[11px] border border-border bg-surface p-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-faint">最近事件</div>
          <span className="text-[10px] text-faint">{events.length ? `最近 ${events.length} 条` : ""}</span>
        </div>
        {events.length ? (
          <ol className="m-0 grid list-none gap-2 p-0 text-[11px]">
            {events.slice(0, 6).map((event) => (
              <li key={event.seq} className="grid grid-cols-[38px_minmax(0,1fr)] gap-2 text-muted">
                <time className="font-mono text-[10px] tabular-nums text-faint">{eventClock(event)}</time>
                <span className="min-w-0">
                  <b className="text-text">{event.sender || "task"}</b>
                  <span className="mt-0.5 line-clamp-2 block text-[11px]">{event.text || ""}</span>
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="m-0 text-[11.5px] text-muted">还没有任务事件。</p>
        )}
      </section>

      <section className="mb-2.5 rounded-[11px] border border-border bg-surface p-3">
        <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.1em] text-faint">会话信息</div>
        <dl className="rb-kv">
          <dt>pool_id</dt>
          <dd>
            <code className="font-mono text-[10.5px]">{pool?.pool_id || `task:task:${taskId}`}</code>
          </dd>
          <dt>消息</dt>
          <dd>{total || pool?.total || 0} 条</dd>
          <dt>更新</dt>
          <dd>{task?.updated_at_local || (task?.updated_at ? formatTs(task.updated_at) : "—")}</dd>
        </dl>
      </section>

      <div className="grid grid-cols-2 gap-1.5">
        <Button variant="ghost" size="sm" onClick={() => onOpenPanel("detail")}>
          任务详情
        </Button>
        <Button variant="ghost" size="sm" onClick={() => onOpenPanel("doc")}>
          指导文件
        </Button>
        <Button variant="ghost" size="sm" onClick={() => onOpenPanel("outputs")}>
          任务产出
        </Button>
        <Button variant="ghost" size="sm" disabled={!onOpenTask} onClick={() => onOpenTask?.(taskId)}>
          任务页
        </Button>
      </div>
    </>
  );
}

export function ChatPage({
  currentPool,
  onCurrentPoolChange,
  reloadSignal,
  onOpenTask,
}: {
  currentPool: string | null;
  onCurrentPoolChange: (alias: string | null) => void;
  reloadSignal: number;
  onOpenTask?: (id: number) => void;
}) {
  const request = useApi();
  const [pools, setPools] = useState<Pool[]>([]);
  const [messages, setMessages] = useState<PoolMessage[]>([]);
  const [total, setTotal] = useState(0);
  const [oldestSeq, setOldestSeq] = useState<number | null>(null);
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: "" });
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [reading, setReading] = useState(false);
  const [view, setView] = useState<"active" | "archived">("active");
  const [search, setSearch] = useState("");
  const [archiving, setArchiving] = useState(false);
  const [sendReview, setSendReview] = useState<SendReviewSettingsResponse | null>(null);
  const [reviewSaving, setReviewSaving] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  /** 网页直聊里的待审任务 id；null = 还没读到，按钮先不显示，避免把待审当成已处理 */
  const [pendingApprovals, setPendingApprovals] = useState<Set<number> | null>(null);
  const [decidingId, setDecidingId] = useState<number | null>(null);
  const [rejectingId, setRejectingId] = useState<number | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  /** 任务池：当前选中任务的快照与侧边抽屉 */
  const [taskSnap, setTaskSnap] = useState<TaskSnapshot | null>(null);
  const [taskPanel, setTaskPanel] = useState<"detail" | "doc" | "outputs" | null>(null);

  const messagesBox = useRef<HTMLDivElement>(null);
  const messagesData = useRef<PoolMessage[]>([]);
  const loadingLatest = useRef(false);
  const requestId = useRef(0);
  const pendingScroll = useRef<"bottom" | "preserve" | null>(null);
  const prevMetrics = useRef({ height: 0, top: 0 });
  const currentRef = useRef(currentPool);
  currentRef.current = currentPool;

  const applyMessages = useCallback(
    (updater: (prev: PoolMessage[]) => PoolMessage[]) => {
      const next = updater(messagesData.current);
      messagesData.current = next;
      setMessages(next);
    },
    [],
  );

  const loadPools = useCallback(
    async (silent = false) => {
      try {
        const rows = await request<Pool[]>(`/v1/pools${view === "archived" ? "?archived=1" : ""}`);
        const visible = view === "archived" ? rows.filter((p) => p.archived) : rows.filter((p) => !p.archived);
        setPools(visible);
        if (visible.some((p) => p.alias === currentRef.current)) return;
        onCurrentPoolChange(visible[0]?.alias ?? null);
      } catch (e) {
        if (!silent) setStatus({ text: `读取会话池失败：${friendlyError(e)}`, error: true });
      }
    },
    [request, onCurrentPoolChange, view],
  );

  const loadLatest = useCallback(
    async (silent = false) => {
      const alias = currentRef.current;
      if (!alias || loadingLatest.current) return;
      const box = messagesBox.current;
      const stickToBottom = box
        ? box.scrollHeight - box.scrollTop - box.clientHeight < 140
        : true;
      const id = ++requestId.current;
      loadingLatest.current = true;
      try {
        const data = await request<PoolMessages>(
          `/v1/pools/${encodeURIComponent(alias)}/messages?limit=${silent ? 40 : 25}`,
        );
        if (currentRef.current !== alias || id !== requestId.current) return;
        setStatus({ text: "" });
        setTotal(data.total || 0);
        if (data.oldest_seq !== null && data.oldest_seq !== undefined) {
          setOldestSeq(data.oldest_seq);
        }
        const next = mergeMessages(messagesData.current, data.messages || []);
        if (next.length > messagesData.current.length || !silent) {
          pendingScroll.current = stickToBottom || !silent ? "bottom" : null;
        }
        applyMessages(() => next);
      } catch (e) {
        const msg = friendlyError(e);
        if (msg && currentRef.current === alias) {
          setStatus({ text: "读取失败，请点击刷新重试。", error: true });
        }
      } finally {
        if (id === requestId.current) loadingLatest.current = false;
      }
    },
    [request, applyMessages],
  );

  const loadPendingApprovals = useCallback(async () => {
    try {
      const rows = await request<TaskView[]>("/v1/tasks?status=pending_approval&limit=200");
      setPendingApprovals(new Set(rows.map((t) => t.id)));
    } catch {
      // 任务接口不可用时保持上一轮结果；没读到过就继续隐藏按钮
    }
  }, [request]);

  const loadOlder = useCallback(async () => {
    const alias = currentRef.current;
    if (!alias || !messagesData.current.length || loadingOlder) return;
    setLoadingOlder(true);
    const box = messagesBox.current;
    prevMetrics.current = { height: box?.scrollHeight ?? 0, top: box?.scrollTop ?? 0 };
    const before = messagesData.current[0].seq;
    try {
      const data = await request<PoolMessages>(
        `/v1/pools/${encodeURIComponent(alias)}/messages?limit=25&before_seq=${before}`,
      );
      if (currentRef.current !== alias) return;
      setStatus({ text: "" });
      setTotal((t) => data.total || t);
      if (data.oldest_seq !== null && data.oldest_seq !== undefined) {
        setOldestSeq(data.oldest_seq);
      }
      pendingScroll.current = "preserve";
      applyMessages((prev) => mergeMessages(prev, data.messages || []));
    } catch (e) {
      const msg = friendlyError(e);
      if (msg && currentRef.current === alias) {
        setStatus({ text: `加载更早失败：${msg}`, error: true });
      }
    } finally {
      setLoadingOlder(false);
    }
  }, [request, loadingOlder, applyMessages]);

  const loadSendReview = useCallback(async () => {
    try {
      setSendReview(await request<SendReviewSettingsResponse>("/v1/send-review"));
    } catch {
      // 老后端没有这个接口时不影响聊天
    }
  }, [request]);

  useEffect(() => {
    void loadPools(false);
    void loadSendReview();
  }, [loadPools, loadSendReview]);

  useEffect(() => {
    requestId.current++;
    loadingLatest.current = false;
    messagesData.current = [];
    setMessages([]);
    setTotal(0);
    setOldestSeq(null);
    setLoadingOlder(false);
    setDraft("");
    if (currentPool) {
      setStatus({ text: "正在读取消息…" });
      void loadLatest(false);
    } else {
      setStatus({ text: "" });
    }
  }, [currentPool, loadLatest]);

  useEffect(() => {
    if (reloadSignal === 0) return;
    void loadSendReview();
    void loadPools(false).then(() => loadLatest(false));
  }, [reloadSignal, loadSendReview, loadPools, loadLatest]);

  useLayoutEffect(() => {
    const box = messagesBox.current;
    const action = pendingScroll.current;
    pendingScroll.current = null;
    if (!box || !action) return;
    if (action === "bottom") box.scrollTop = box.scrollHeight;
    else box.scrollTop = prevMetrics.current.top + (box.scrollHeight - prevMetrics.current.height);
  }, [messages]);

  usePolling(async () => {
    await loadPools(true);
    if (currentRef.current) await loadLatest(true);
  }, 3000);

  const pool = pools.find((p) => p.alias === currentPool);
  const isWebPool = pool?.platform === "web";
  const taskId = taskIdOfPool(pool);

  const loadTaskSnapshot = useCallback(async () => {
    if (taskId === null) return;
    try {
      setTaskSnap(await request<TaskSnapshot>(`/v1/tasks/${taskId}/snapshot`));
    } catch {
      // 任务接口偶发失败时不打断聊天；保留上一份快照
    }
  }, [request, taskId]);

  useEffect(() => {
    setTaskSnap(null);
    setTaskPanel(null);
    if (taskId !== null) void loadTaskSnapshot();
  }, [taskId, loadTaskSnapshot]);
  usePolling(loadTaskSnapshot, 5000, taskId !== null);

  useEffect(() => {
    if (isWebPool || taskId !== null) void loadPendingApprovals();
  }, [isWebPool, taskId, loadPendingApprovals]);
  usePolling(loadPendingApprovals, 3000, isWebPool || taskId !== null);

  const sendDraft = useCallback(async () => {
    const text = draft.trim();
    if (!text || !isWebPool || sending) return;
    setSending(true);
    try {
      await request("/v1/webchat/send", { method: "POST", body: { text } });
      setDraft("");
      pendingScroll.current = "bottom";
      await loadLatest(false);
    } catch (e) {
      setStatus({ text: `发送失败：${friendlyError(e)}`, error: true });
    } finally {
      setSending(false);
    }
  }, [draft, isWebPool, sending, request, loadLatest]);

  const decideTask = useCallback(
    async (id: number, action: "approve" | "reject", reason = "") => {
      if (decidingId !== null) return;
      setDecidingId(id);
      setStatus({
        text: action === "approve" ? `任务 #${id} 审批通过，正在启动…` : `任务 #${id} 正在驳回…`,
      });
      try {
        await request(`/v1/tasks/${id}/${action}`, {
          method: "POST",
          body: action === "reject" ? { reason, by: "web" } : { by: "web" },
        });
        setStatus({
          text: action === "approve" ? `任务 #${id} 已通过并启动。` : `任务 #${id} 已驳回。`,
        });
        setRejectingId(null);
        setRejectReason("");
        await Promise.all([loadLatest(false), loadPendingApprovals(), loadTaskSnapshot()]);
      } catch (e) {
        setStatus({ text: `审批操作失败：${friendlyError(e)}`, error: true });
        await loadPendingApprovals();
      } finally {
        setDecidingId(null);
      }
    },
    [decidingId, request, loadLatest, loadPendingApprovals, loadTaskSnapshot],
  );

  const toggleArchive = useCallback(async () => {
    if (!pool || archiving) return;
    setArchiving(true);
    try {
      await request(`/v1/pools/${encodeURIComponent(pool.alias)}/archive`, {
        method: "POST",
        body: { archived: !pool.archived },
      });
      await loadPools(false);
    } catch (e) {
      setStatus({ text: `归档失败：${friendlyError(e)}`, error: true });
    } finally {
      setArchiving(false);
    }
  }, [pool, archiving, request, loadPools]);

  const changePoolReview = useCallback(
    async (mode: PoolReviewMode) => {
      if (!pool || !sendReview || reviewSaving) return;
      setReviewSaving(true);
      try {
        const overrides = { ...sendReview.overrides };
        // 默认就是直接发时，「直接发」等于回到默认，不写死一条覆盖
        if (mode === "inherit" || (mode === "direct" && !sendReview.defaultReview)) {
          delete overrides[pool.pool_id];
        } else {
          overrides[pool.pool_id] = mode === "review";
        }
        const saved = await request<SendReviewSettingsResponse>("/v1/send-review", {
          method: "PUT",
          body: {
            // 给某个会话打开审批时顺手把总开关打开，省得再去设置页找
            enabled: mode === "review" ? true : sendReview.enabled,
            defaultReview: sendReview.defaultReview,
            primaryPoolId: sendReview.primaryPoolId,
            overrides,
          },
        });
        setSendReview(saved);
        setStatus({ text: "" });
      } catch (e) {
        setStatus({ text: `设置发送审核失败：${friendlyError(e)}`, error: true });
      } finally {
        setReviewSaving(false);
      }
    },
    [pool, sendReview, reviewSaving, request],
  );

  const isPrimary = !!pool && sendReview?.primaryPoolId === pool.pool_id;
  // 这个会话当前实际走不走审批：主对话永远免审；否则看单独覆盖，再退到全局默认
  const effectiveReview = !pool || isPrimary
    ? false
    : (sendReview?.overrides[pool.pool_id] ?? sendReview?.defaultReview ?? false);

  const setPrimaryPool = useCallback(
    async (makePrimary: boolean) => {
      if (!pool || !sendReview || reviewSaving) return;
      setReviewSaving(true);
      try {
        const saved = await request<SendReviewSettingsResponse>("/v1/send-review", {
          method: "PUT",
          body: {
            enabled: sendReview.enabled,
            defaultReview: sendReview.defaultReview,
            primaryPoolId: makePrimary ? pool.pool_id : null,
            overrides: sendReview.overrides,
          },
        });
        setSendReview(saved);
        setStatus({
          text: makePrimary
            ? "已设为主聊天：任务汇报只发这里，它发送的消息永不审批，审批消息也发到这里"
            : "已取消主聊天",
        });
      } catch (e) {
        setStatus({ text: `设置主聊天失败：${friendlyError(e)}`, error: true });
      } finally {
        setReviewSaving(false);
      }
    },
    [pool, sendReview, reviewSaving, request],
  );

  const canLoadOlder =
    oldestSeq !== null && messages.length > 0 && messages[0].seq > oldestSeq;

  const query = search.trim().toLowerCase();
  const visiblePools = pools.filter(
    (p) => !query || `${p.title} ${p.alias}`.toLowerCase().includes(query),
  );
  const buckets = new Map<string, Pool[]>();
  for (const p of visiblePools) {
    const key = poolBucketKind(p);
    const list = buckets.get(key) ?? [];
    list.push(p);
    buckets.set(key, list);
  }
  const bucketOrder = ["web", "private", "group", "task"];
  const orderedBuckets = [...buckets.entries()].sort(
    (a, b) =>
      (bucketOrder.indexOf(a[0]) === -1 ? 9 : bucketOrder.indexOf(a[0])) -
      (bucketOrder.indexOf(b[0]) === -1 ? 9 : bucketOrder.indexOf(b[0])),
  );
  const recentMessages = messages.slice(-3).reverse();

  let previous: PoolMessage | null = null;
  let previousDay = "";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="grid min-h-0 flex-1 grid-cols-[288px_minmax(0,1fr)_308px] max-[1200px]:grid-cols-[260px_minmax(0,1fr)] max-[820px]:grid-cols-1">
      <aside
        className={cx(
          "flex min-h-0 flex-col border-r border-border bg-surface max-[820px]:border-r-0",
          reading && "max-[820px]:hidden",
        )}
      >
        <div className="flex items-center justify-between gap-2 px-3.5 pb-2.5 pt-4">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-faint">
              会话池
            </div>
            <div className="mt-0.5 text-[11px] text-muted">{visiblePools.length} 个会话</div>
          </div>
          <Segmented
            value={view}
            options={[
              { value: "active", label: "活跃" },
              { value: "archived", label: "已归档" },
            ]}
            onChange={setView}
            label="会话池视图"
          />
        </div>
        <div className="px-3 pb-2.5">
          <Input
            type="search"
            aria-label="搜索会话或别名"
            placeholder="搜索会话或别名…"
            className="py-1.5 text-[12px]"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="rb-thin-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          {!visiblePools.length ? (
            <Empty>
              {view === "archived"
                ? "还没有已归档的会话。"
                : query
                  ? "没有匹配的会话。"
                  : "还没有会话池。"}
            </Empty>
          ) : (
            orderedBuckets.map(([kind, rows]) => (
              <div key={kind}>
                <div className="px-2 pb-1 pt-3 text-[10px] font-bold uppercase tracking-[0.1em] text-faint">
                  {BUCKET_LABEL[kind] ?? kindLabel(kind)} · {rows.length}
                </div>
                {rows.map((p) => {
                  const selected = p.alias === currentPool;
                  return (
                    <button
                      key={p.alias}
                      type="button"
                      title={poolDisplayName(p)}
                      aria-current={selected ? "true" : undefined}
                      className={cx(
                        "relative flex w-full items-start gap-2.5 rounded-[9px] px-2.5 py-2 text-left transition hover:bg-surface2",
                        selected && "bg-accent-soft",
                      )}
                      onClick={() => {
                        setReading(true);
                        if (currentPool !== p.alias) onCurrentPoolChange(p.alias);
                        else if (messagesBox.current) {
                          messagesBox.current.scrollTop = messagesBox.current.scrollHeight;
                        }
                      }}
                    >
                      {selected && (
                        <span className="absolute inset-y-2 left-0 w-[3px] rounded bg-accent" />
                      )}
                      <span
                        className={cx(
                          "grid size-[30px] flex-none place-items-center rounded-[9px] border text-[13px] font-bold",
                          p.kind === "private"
                            ? "border-clay/25 bg-clay-soft text-clay"
                            : "border-accent/25 bg-accent-soft text-accent-ink",
                        )}
                      >
                        {initial(poolDisplayName(p))}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5 text-[12.5px] font-semibold leading-tight">
                          <span className="truncate">{poolDisplayName(p)}</span>
                          {p.is_main && (
                            <Chip tone="accent" className="px-1.5 py-0 text-[9px]">
                              主
                            </Chip>
                          )}
                          <Chip
                            tone={p.platform === "web" ? "accent" : "default"}
                            className="px-1.5 py-0 text-[9px]"
                          >
                            {platformLabel(p.platform)}
                          </Chip>
                          {Number(p.unread) > 0 && (
                            <span
                              className="ml-auto grid h-[16px] min-w-[16px] flex-none place-items-center rounded-full bg-clay px-1 text-[10px] font-semibold tabular-nums text-white"
                              aria-label={`${p.unread} 条未读`}
                            >
                              {Number(p.unread) > 99 ? "99+" : p.unread}
                            </span>
                          )}
                        </span>
                        <span className="mt-1 flex items-center gap-1.5 text-[10.5px] text-muted">
                          <code className="truncate font-mono text-[10px] text-faint">
                            {p.task_id ? `#${p.task_id}` : p.alias}
                          </code>
                          <span className="truncate">{p.last_msg_local ? p.last_msg_local.slice(5, 16) : "暂无消息"}</span>
                        </span>
                      </span>
                      <span className="flex flex-none flex-col items-end gap-0.5 text-[10px] text-faint">
                        <span>{p.task_status ? <Badge variant={badgeVariant(p.task_status)}>{p.task_status}</Badge> : kindLabel(p.kind)}</span>
                        <span>{p.total || 0} 条</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </aside>

      <section
        className={cx(
          "flex min-h-0 min-w-0 flex-col bg-surface",
          !reading && "max-[820px]:hidden",
        )}
        aria-label="会话记录"
      >
        <div className="flex min-h-[58px] flex-wrap items-center gap-3 border-b border-border px-5 py-2.5 max-[820px]:px-3">
          <button
            type="button"
            className="hidden flex-none rounded-[9px] border border-border px-2.5 py-1.5 text-[13px] max-[820px]:block"
            onClick={() => setReading(false)}
          >
            会话列表
          </button>
          <div className="min-w-0 flex-1">
            <h2
              className="rb-display m-0 truncate text-[17px]"
              title={
                pool
                  ? `${pool.alias} · ${taskId !== null ? `任务 #${taskId} · ${pool.task_status || "unknown"}` : isWebPool ? "网页直聊" : `${platformLabel(pool.platform)} · ${kindLabel(pool.kind)}`} · ${total} 条消息 · 最后 ${pool.last_msg_local || "—"}`
                  : undefined
              }
            >
              {pool ? poolDisplayName(pool) : "选择左侧会话"}
            </h2>
          </div>
          {taskId !== null ? (
            <div className="flex flex-none flex-wrap items-center justify-end gap-2">
              <Chip tone="accent">任务 #{taskId}</Chip>
              {(taskSnap?.task.status || pool?.task_status) ? (
                <Badge variant={badgeVariant(taskSnap?.task.status || pool?.task_status)}>
                  {taskSnap?.task.status || pool?.task_status}
                </Badge>
              ) : null}
              {taskSnap?.task.stage ? <Chip>{taskSnap.task.stage}</Chip> : null}
              <Button variant="ghost" size="sm" onClick={() => setTaskPanel("detail")}>
                任务详情
              </Button>
            </div>
          ) : isWebPool ? (
            <div className="flex flex-none flex-wrap items-center justify-end gap-2">
              <Chip tone="accent">{isPrimary ? "主聊天 · 免审批" : "网页直聊 · 免审批"}</Chip>
              {sendReview && (
                <Button
                  variant={isPrimary ? "default" : "ghost"}
                  size="sm"
                  disabled={reviewSaving}
                  aria-pressed={isPrimary}
                  title={
                    isPrimary
                      ? "主聊天：任务汇报与审批消息都发这里，点此取消"
                      : "设为主聊天：IM 失效时任务汇报和审批消息仍发到网页直聊"
                  }
                  onClick={() => void setPrimaryPool(!isPrimary)}
                >
                  {isPrimary ? "主聊天 ✓" : "设为主聊天"}
                </Button>
              )}
              <Button variant="ghost" size="sm" disabled={archiving} onClick={() => void toggleArchive()}>
                {pool?.archived ? "取消归档" : "归档"}
              </Button>
            </div>
          ) : pool && sendReview && (pool.kind === "group" || pool.kind === "private") ? (
            <div className="flex flex-none flex-wrap items-center justify-end gap-2">
              {isPrimary ? (
                <Chip tone="accent">主聊天 · 免审批</Chip>
              ) : (
                <Segmented
                  value={effectiveReview ? "review" : "direct"}
                  options={[
                    { value: "direct", label: "直接发" },
                    { value: "review", label: "需审批" },
                  ]}
                  onChange={(value) => void changePoolReview(value)}
                  label="这个会话发送是否需要审批"
                />
              )}
              <Button
                variant={isPrimary ? "default" : "ghost"}
                size="sm"
                disabled={reviewSaving}
                aria-pressed={isPrimary}
                title={
                  isPrimary
                    ? "主聊天：任务汇报只发这里、永不审批；点此取消"
                    : "设为主聊天：任务汇报只发这里，永不审批，并接收审批消息"
                }
                onClick={() => void setPrimaryPool(!isPrimary)}
              >
                {isPrimary ? "主聊天 ✓" : "设为主聊天"}
              </Button>
              <Button variant="ghost" size="sm" disabled={archiving} onClick={() => void toggleArchive()}>
                {pool.archived ? "取消归档" : "归档"}
              </Button>
            </div>
          ) : null}
        </div>

        {status.text && (
          <p
            className={cx(
              "m-0 border-b border-border bg-bg px-5 py-2 text-[12.5px] max-[820px]:px-3",
              status.error ? "text-bad" : "text-muted",
            )}
            role={status.error ? "alert" : "status"}
          >
            {status.text}
          </p>
        )}

        <div
          ref={messagesBox}
          className="rb-thin-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-[max(24px,calc((100%-760px)/2))] pb-8 pt-3 [scrollbar-gutter:stable] max-[820px]:px-3.5 max-[820px]:pb-6"
          tabIndex={0}
          aria-label="消息记录"
        >
          {!currentPool ? (
            <Empty>从左侧选择一个会话池。</Empty>
          ) : (
            <>
              {canLoadOlder && (
                <div className="text-center">
                  <Button variant="ghost" size="sm" disabled={loadingOlder} onClick={() => void loadOlder()}>
                    {loadingOlder ? "正在加载…" : "加载更早的消息"}
                  </Button>
                </div>
              )}
              {!messages.length ? (
                <Empty>
                  {isWebPool
                    ? "网页直聊还没有消息。在下面输入框里发第一句。"
                    : "这个池还没有消息。收发消息请用已启用的 IM。"}
                </Empty>
              ) : (
                messages.map((m) => {
                  const stamp = m.local || formatTs(m.ts);
                  const taskId =
                    m.meta?.kind === "task_approval" && typeof m.meta.task_id === "number"
                      ? m.meta.task_id
                      : null;
                  const day = stamp.split(/[ T]/)[0];
                  const showDay = !!day && day !== previousDay;
                  const grouped =
                    !!previous &&
                    day === previousDay &&
                    previous.from_self === m.from_self &&
                    previous.sender === m.sender &&
                    previous.user_id === m.user_id &&
                    Number(m.ts) - Number(previous.ts) >= 0 &&
                    Number(m.ts) - Number(previous.ts) < 5 * 60 * 1000;
                  previous = m;
                  previousDay = day;
                  return (
                    <Fragment key={m.seq}>
                      {showDay && (
                        <div className="my-4 flex items-center gap-3 text-[10.5px] tracking-[0.08em] text-faint">
                          <span className="h-px flex-1 bg-border" />
                          {day}
                          <span className="h-px flex-1 bg-border" />
                        </div>
                      )}
                      <article
                        className={cx(
                          "my-3 flex max-w-[min(680px,88%)] items-start gap-2.5 max-[820px]:max-w-[94%]",
                          m.from_self && "ml-auto flex-row-reverse",
                          grouped && "mt-1.5",
                        )}
                      >
                        <span
                          className={cx(
                            "grid size-6 flex-none place-items-center rounded-[7px] border text-[11px] font-bold",
                            m.from_self
                              ? "border-transparent bg-accent text-white"
                              : "border-border bg-surface3 text-muted",
                            grouped && "opacity-0",
                          )}
                        >
                          {initial(m.sender || "机器人")}
                        </span>
                        <div className="min-w-0">
                          <div
                            className={cx(
                              "mb-1 flex flex-wrap items-baseline gap-2 text-[10.5px] text-faint",
                              m.from_self && "justify-end",
                              grouped && "hidden",
                            )}
                          >
                            <b className="text-[11px] font-semibold text-muted">
                              {m.sender || (m.from_self ? "机器人" : "未知")}
                            </b>
                            {m.from_self && <span>机器人</span>}
                            <time className="tabular-nums">
                              {stamp.match(/\d{2}:\d{2}/)?.[0] || stamp}
                            </time>
                          </div>
                          <div
                            className={cx(
                              "whitespace-pre-wrap wrap-anywhere rounded-[3px_12px_12px_12px] border border-border bg-surface2 px-3 py-2.5 text-[13px] leading-[1.75]",
                              m.from_self &&
                                "rounded-[12px_3px_12px_12px] border-accent/20 bg-accent-soft",
                            )}
                          >
                            {m.text || ""}
                          </div>
                          {isWebPool && taskId !== null && pendingApprovals && (
                            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[12px]">
                              {pendingApprovals.has(taskId) ? (
                                rejectingId === taskId ? (
                                  <>
                                    <Input
                                      value={rejectReason}
                                      onChange={(e) => setRejectReason(e.target.value)}
                                      placeholder="驳回原因（必填）"
                                      aria-label={`任务 #${taskId} 驳回原因`}
                                      className="h-8 min-w-[180px] flex-1 text-[12px]"
                                    />
                                    <Button
                                      variant="primary"
                                      size="sm"
                                      disabled={!rejectReason.trim() || decidingId === taskId}
                                      onClick={() => void decideTask(taskId, "reject", rejectReason.trim())}
                                    >
                                      {decidingId === taskId ? "驳回中…" : "确认驳回"}
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      disabled={decidingId === taskId}
                                      onClick={() => {
                                        setRejectingId(null);
                                        setRejectReason("");
                                      }}
                                    >
                                      取消
                                    </Button>
                                  </>
                                ) : (
                                  <>
                                    <Button
                                      variant="primary"
                                      size="sm"
                                      disabled={decidingId === taskId}
                                      onClick={() => void decideTask(taskId, "approve")}
                                    >
                                      {decidingId === taskId ? "处理中…" : "同意并启动"}
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      disabled={decidingId === taskId}
                                      onClick={() => {
                                        setRejectingId(taskId);
                                        setRejectReason("");
                                      }}
                                    >
                                      驳回
                                    </Button>
                                  </>
                                )
                              ) : (
                                <span className="text-faint">已处理</span>
                              )}
                            </div>
                          )}
                        </div>
                      </article>
                    </Fragment>
                  );
                })
              )}
            </>
          )}
        </div>

        {isWebPool ? (
          <form
            className="flex items-end gap-2 border-t border-border bg-surface px-5 py-3 max-[820px]:px-3"
            onSubmit={(e) => {
              e.preventDefault();
              void sendDraft();
            }}
          >
            <Textarea
              rows={2}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void sendDraft();
                }
              }}
              placeholder="给机器人发消息… Enter 发送，Shift+Enter 换行"
              aria-label="网页直聊输入框"
              className="min-h-[44px] flex-1 resize-none py-2 text-[13px]"
            />
            <Button
              variant="primary"
              type="submit"
              disabled={!draft.trim() || sending}
              className="mb-px flex-none px-4 py-2"
            >
              {sending ? "发送中…" : "发送"}
            </Button>
          </form>
        ) : (
          <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-2 text-[11px] text-muted max-[820px]:px-3">
            <span>只读 · 收发走已启用的 IM</span>
            <div className="flex items-center gap-1.5">
              {canLoadOlder && (
                <Button variant="ghost" size="sm" disabled={loadingOlder} onClick={() => void loadOlder()}>
                  加载更早
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  if (messagesBox.current) messagesBox.current.scrollTop = messagesBox.current.scrollHeight;
                }}
              >
                回到最新
              </Button>
            </div>
          </div>
        )}
      </section>

      <aside className="rb-thin-scroll min-h-0 overflow-y-auto border-l border-border bg-surface p-3.5 max-[1200px]:hidden">
        {taskId !== null ? (
          <TaskExecBoard
            taskId={taskId}
            pool={pool}
            snap={taskSnap}
            total={total}
            pending={pendingApprovals}
            decidingId={decidingId}
            rejectingId={rejectingId}
            rejectReason={rejectReason}
            onRejectReasonChange={setRejectReason}
            onDecide={(id, action, reason) => void decideTask(id, action, reason)}
            onStartReject={(id) => {
              setRejectingId(id);
              setRejectReason("");
            }}
            onCancelReject={() => {
              setRejectingId(null);
              setRejectReason("");
            }}
            onOpenPanel={(panel) => setTaskPanel(panel)}
            onOpenTask={onOpenTask}
          />
        ) : (
          <>
            <div className="mb-2.5 rounded-[11px] border border-border bg-surface p-3">
              <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.1em] text-faint">
                会话信息
              </div>
              {pool ? (
                <>
                  <dl className="rb-kv">
                    <dt>pool_id</dt>
                    <dd>
                      <code className="font-mono text-[10.5px]">{pool.pool_id}</code>
                    </dd>
                    <dt>类型</dt>
                    <dd>{isWebPool ? "网页直聊" : kindLabel(pool.kind)}</dd>
                    <dt>渠道</dt>
                    <dd>{platformLabel(pool.platform)}</dd>
                    <dt>消息</dt>
                    <dd>{pool.total || 0} 条</dd>
                    <dt>最后</dt>
                    <dd>{pool.last_msg_local || "—"}</dd>
                  </dl>
                  <p className="mt-2.5 text-[11.5px] leading-relaxed text-muted">
                    {isWebPool
                      ? "网页直聊：在浏览器或这个页面发消息都会进同一个池，机器人回复免审批直接写回。"
                      : pool.is_main
                        ? "主聊天：任务汇报与审批消息都发这里，发送永不审批。"
                        : "只读值班台：修改发送策略只影响机器人后续发送。"}
                  </p>
                </>
              ) : (
                <p className="m-0 text-[12px] text-muted">选择左侧会话查看信息。</p>
              )}
            </div>

            <div className="mb-2.5 rounded-[11px] border border-border bg-surface p-3">
              <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.1em] text-faint">
                发送策略
              </div>
              {pool && sendReview ? (
                isWebPool ? (
                  <Notice tone="accent">
                    网页直聊固定直接发：消息在浏览器里往返，不进入审批流程。
                    {isPrimary ? "当前是主聊天，任务汇报和审批消息也发这里。" : ""}
                  </Notice>
                ) : isPrimary ? (
                  <Notice tone="accent">
                    主聊天永远免审批；任务汇报只发这里，审批消息也发这里。
                  </Notice>
                ) : (
                  <>
                    <p className="m-0 mb-2 text-[11.5px] leading-relaxed text-muted">
                      这个会话当前：
                      <b className="text-text">{effectiveReview ? "需审批" : "直接发"}</b>
                      。改策略只影响后续机器人发送。
                    </p>
                    <Segmented
                      value={effectiveReview ? "review" : "direct"}
                      options={[
                        { value: "direct", label: "直接发" },
                        { value: "review", label: "需审批" },
                      ]}
                      onChange={(value) => void changePoolReview(value)}
                      label="发送审批"
                    />
                  </>
                )
              ) : (
                <p className="m-0 text-[11.5px] text-muted">发送审核接口不可用。</p>
              )}
              {pool && sendReview ? (
                <>
                  <div className="my-3 h-px bg-border" />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full"
                    disabled={reviewSaving}
                    onClick={() => void setPrimaryPool(!isPrimary)}
                  >
                    {isPrimary ? "取消主聊天" : "设为主聊天"}
                  </Button>
                </>
              ) : null}
            </div>

            <div className="rounded-[11px] border border-border bg-surface p-3">
              <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.1em] text-faint">
                最近消息
              </div>
              {recentMessages.length ? (
                <ol className="m-0 grid list-none gap-2 p-0 text-[11px]">
                  {recentMessages.map((m) => (
                    <li key={m.seq} className="grid grid-cols-[48px_minmax(0,1fr)] gap-2 text-muted">
                      <time className="font-mono text-[10px] text-faint tabular-nums">
                        {(m.local || formatTs(m.ts)).match(/\d{2}:\d{2}/)?.[0] || "—"}
                      </time>
                      <span className="min-w-0">
                        <b className="text-text">{m.sender || "未知"}</b>
                        <span className="mt-0.5 block truncate">{m.text || ""}</span>
                      </span>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="m-0 text-[11.5px] text-muted">还没有消息。</p>
              )}
            </div>
          </>
        )}
      </aside>
      </div>

      {taskId !== null && taskPanel !== null ? (
        <Drawer
          title={
            <span className="inline-flex items-center gap-2">
              <span className="font-mono text-[13px] font-normal text-muted">#{taskId}</span>
              {taskSnap?.task.name || pool?.task_name || "任务"}
            </span>
          }
          onClose={() => setTaskPanel(null)}
        >
          <Segmented
            value={taskPanel}
            options={[
              { value: "detail", label: "任务详情" },
              { value: "doc", label: "指导文件" },
              { value: "outputs", label: "任务产出" },
            ]}
            onChange={setTaskPanel}
            label="任务面板"
          />
          <div className="mt-3">
            {taskPanel === "detail" ? <TaskDetailPanel snap={taskSnap} /> : null}
            {taskPanel === "doc" ? <TaskDocPanel taskId={taskId} /> : null}
            {taskPanel === "outputs" ? <TaskOutputsPanel taskId={taskId} /> : null}
          </div>
        </Drawer>
      ) : null}
    </div>
  );
}
