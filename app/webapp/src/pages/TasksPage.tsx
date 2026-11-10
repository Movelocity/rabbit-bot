import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useApi } from "../lib/api-context.tsx";
import { usePolling } from "../lib/use-polling.ts";
import {
  badgeVariant,
  formatTs,
  friendlyError,
  noteSummary,
} from "../lib/format.ts";
import type { TaskSnapshot, TaskView } from "../lib/types.ts";
import {
  Badge,
  Button,
  Card,
  CardHead,
  CardMeta,
  CardTitle,
  Empty,
  Field,
  Input,
  Select,
  StatusText,
  Textarea,
} from "../components/ui.tsx";
import { Modal } from "../components/Modal.tsx";
import { DetailRows, type DetailRow } from "../components/DetailRows.tsx";

const STATUS_OPTIONS = [
  "pending_approval",
  "pending",
  "running",
  "blocked",
  "done",
  "failed",
  "cancelled",
];

function taskMatches(t: TaskView, executor: string, search: string): boolean {
  if (executor && String(t.executor || "") !== executor) return false;
  const q = search.trim().toLowerCase();
  if (!q) return true;
  const hay = [
    t.id,
    t.name,
    t.goal,
    t.deliverable,
    t.constraints,
    t.acceptance,
    t.result,
    t.artifact,
    t.files,
    t.status,
    t.stage,
    t.worker_id,
    t.executor,
    t.model,
    t.note,
  ]
    .map((v) => String(v ?? ""))
    .join(" ")
    .toLowerCase();
  return hay.includes(q);
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
  add("worker", t.worker_id, true);
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
  const [busy, setBusy] = useState(false);

  const approve = async () => {
    const body: Record<string, string> = {};
    const collect = (key: keyof TaskView, value: string) => {
      if (value !== (String(task[key] ?? ""))) body[key] = value;
    };
    collect("name", name);
    collect("goal", goal);
    collect("deliverable", deliverable);
    collect("constraints", constraints);
    collect("acceptance", acceptance);

    const message =
      task.executor === "mimo"
        ? "通过后会立即以无审批模式启动 mimo，可能执行任意命令。\n\n确定通过？"
        : "通过后会立即以无审批模式启动 opencode（带 --dangerously-skip-permissions），可能执行任意命令。\n\n确定通过？";
    if (!window.confirm(message)) return;

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
    const reason = window.prompt("驳回原因（可留空）");
    if (reason === null) return;
    setBusy(true);
    setStatus({ text: "正在驳回…" });
    try {
      await request(`/v1/tasks/${task.id}/reject`, {
        method: "POST",
        body: { reason, by: "web" },
      });
      setStatus({ text: `任务 #${task.id} 已驳回，未执行。` });
      await onDone();
    } catch (e) {
      setStatus({ text: `驳回失败：${friendlyError(e)}`, error: true });
      setBusy(false);
    }
  };

  return (
    <div className="mt-1.5 rounded-xl border border-border bg-surface2 p-3.5">
      <h3 className="m-0 mb-2.5 text-sm font-semibold">审批并执行</h3>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-2.5">
        <Field label="name">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="goal">
          <Textarea className="min-h-[72px]" value={goal} onChange={(e) => setGoal(e.target.value)} />
        </Field>
        <Field label="deliverable">
          <Textarea
            className="min-h-[72px]"
            value={deliverable}
            onChange={(e) => setDeliverable(e.target.value)}
          />
        </Field>
        <Field label="constraints">
          <Textarea
            className="min-h-[72px]"
            value={constraints}
            onChange={(e) => setConstraints(e.target.value)}
          />
        </Field>
        <Field label="acceptance">
          <Textarea
            className="min-h-[72px]"
            value={acceptance}
            onChange={(e) => setAcceptance(e.target.value)}
          />
        </Field>
      </div>
      <p className="mt-2.5 text-xs text-muted">
        优先在飞书审批房给任务提示贴 OK；这里是备用入口。work_dir / executor / model 只读，v1 不支持在 Web 修改。
      </p>
      <div className="mt-2.5 flex gap-2">
        <Button variant="primary" size="sm" disabled={busy} onClick={() => void approve()}>
          通过并执行
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void reject()}>
          驳回
        </Button>
      </div>
    </div>
  );
}

export function TasksPage({ reloadSignal }: { reloadSignal: number }) {
  const request = useApi();
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [statusFilter, setStatusFilter] = useState("");
  const [executorFilter, setExecutorFilter] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: "" });
  const [modalId, setModalId] = useState<number | null>(null);
  const [modalLoading, setModalLoading] = useState(false);
  const [snapshots, setSnapshots] = useState<Record<number, TaskSnapshot>>({});
  const modalIdRef = useRef<number | null>(null);
  modalIdRef.current = modalId;

  const loadSnapshot = useCallback(
    async (id: number, silent = false) => {
      try {
        const snap = await request<TaskSnapshot>(`/v1/tasks/${id}/snapshot`);
        setSnapshots((prev) => ({ ...prev, [id]: snap }));
      } catch (e) {
        if (!silent) setStatus({ text: `任务快照加载失败：${friendlyError(e)}`, error: true });
      } finally {
        if (modalIdRef.current === id) setModalLoading(false);
      }
    },
    [request],
  );

  const closeModal = useCallback(() => {
    modalIdRef.current = null;
    setModalId(null);
    setModalLoading(false);
  }, []);

  const loadTasks = useCallback(
    async (silent = false) => {
      if (!silent) setStatus({ text: "加载中…" });
      try {
        const query = statusFilter ? `?status=${encodeURIComponent(statusFilter)}` : "";
        const rows = await request<TaskView[]>(`/v1/tasks${query}`);
        setTasks(rows);
        setStatus({ text: rows.length ? "" : "没有任务。" });
        if (modalIdRef.current !== null && !rows.some((t) => t.id === modalIdRef.current)) {
          closeModal();
        }
        if (modalIdRef.current !== null) void loadSnapshot(modalIdRef.current, true);
      } catch (e) {
        setStatus({ text: `加载失败：${friendlyError(e)}`, error: true });
      }
    },
    [request, statusFilter, closeModal, loadSnapshot],
  );

  useEffect(() => {
    void loadTasks(false);
  }, [loadTasks]);

  useEffect(() => {
    if (reloadSignal === 0) return;
    void loadTasks(false);
  }, [reloadSignal, loadTasks]);

  usePolling(() => loadTasks(true), 3000);

  const openModal = (id: number) => {
    setModalId(id);
    setModalLoading(!snapshots[id]);
    void loadSnapshot(id, false);
  };

  // 倒排：最近有动静的排最上面；同一时刻按 id 倒序兜底
  const filtered = tasks
    .filter((t) => taskMatches(t, executorFilter, search))
    .sort((a, b) => b.updated_at - a.updated_at || b.id - a.id);
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pages);
  const start = (currentPage - 1) * pageSize;
  const pageRows = filtered.slice(start, start + pageSize);
  const end = Math.min(filtered.length, currentPage * pageSize);

  const task = modalId !== null ? tasks.find((t) => t.id === modalId) : undefined;
  const snap = modalId !== null ? snapshots[modalId] ?? null : null;

  return (
    <div className="h-full overflow-y-auto px-[clamp(16px,4vw,44px)] pb-[60px] pt-[22px] max-[820px]:px-3.5 max-[820px]:pb-12 max-[820px]:pt-4">
      <div className="my-3 flex flex-wrap items-end gap-3">
        <Field label="status" compact>
          <Select
            value={statusFilter}
            onValueChange={(value) => {
              setStatusFilter(value);
              setPage(1);
            }}
            options={[
              { value: "", label: "全部" },
              ...STATUS_OPTIONS.map((status) => ({ value: status, label: status })),
            ]}
          />
        </Field>
        <Field label="executor" compact>
          <Select
            value={executorFilter}
            onValueChange={(value) => {
              setExecutorFilter(value);
              setPage(1);
            }}
            options={[
              { value: "", label: "全部" },
              { value: "opencode", label: "opencode" },
              { value: "mimo", label: "mimo" },
            ]}
          />
        </Field>
        <Field label="搜索" grow>
          <Input
            type="search"
            placeholder="id / 任务名 / 目标 / worker / note"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </Field>
      </div>

      <StatusText text={status.text} error={status.error} />

      <div className="grid gap-2.5">
        {!filtered.length ? (
          <Empty>{tasks.length ? "没有匹配的任务。" : "没有任务。"}</Empty>
        ) : (
          pageRows.map((t) => (
            <Card key={t.id}>
              <CardHead>
                <CardTitle>
                  <span className="font-mono text-[13px] font-semibold text-muted">#{t.id}</span>{" "}
                  {t.goal || "（无目标）"}
                </CardTitle>
                <Button variant="ghost" size="sm" onClick={() => openModal(t.id)}>
                  {t.status === "pending_approval" ? "审批 / 预览" : "预览详情"}
                </Button>
              </CardHead>
              <CardMeta>
                <Badge variant={badgeVariant(t.status)}>{t.status}</Badge>
                {t.stage && <span>stage {t.stage}</span>}
                <span>worker {t.worker_id || "未领取"}</span>
                <span>更新 {t.updated_at_local || formatTs(t.updated_at)}</span>
                {noteSummary(t.note) && (
                  <span className="basis-full">note {noteSummary(t.note)}</span>
                )}
              </CardMeta>
            </Card>
          ))
        )}
      </div>

      {filtered.length > 0 && (
        <div className="mt-3.5 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted">
          <Button
            variant="ghost"
            size="sm"
            disabled={currentPage <= 1}
            onClick={() => setPage(currentPage - 1)}
          >
            上一页
          </Button>
          <span>
            {start + 1}–{end} / 共 {filtered.length} 条 · 第 {currentPage} / {pages} 页
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={currentPage >= pages}
            onClick={() => setPage(currentPage + 1)}
          >
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
            options={[10, 20, 50, 100].map((n) => ({
              value: String(n),
              label: `${n} 条/页`,
            }))}
          />
        </div>
      )}

      {task && (
        <Modal title={`#${task.id} ${task.name || "任务详情"}`} onClose={closeModal}>
          <div className="flex flex-wrap gap-3 text-xs text-muted">
            <Badge variant={badgeVariant(task.status)}>{task.status}</Badge>
            <span>executor {task.executor || "—"}</span>
            <span>更新 {task.updated_at_local || formatTs(task.updated_at)}</span>
          </div>
          <DetailRows
            className="mt-0 border-t-0 pt-0"
            rows={buildDetailRows(task)}
          />
          {modalLoading ? (
            <p className="text-[13px] text-muted">正在加载任务快照…</p>
          ) : (
            <>
              <section className="mt-4">
                <h3 className="m-0 mb-2 text-sm font-semibold">最近事件</h3>
                {!snap?.recent_events?.length ? (
                  <p className="text-[13px] text-muted">还没收到任务事件。</p>
                ) : (
                  <ol className="m-0 grid list-none gap-1.5 p-0">
                    {snap.recent_events.map((ev) => (
                      <li
                        key={ev.seq}
                        className="rounded-lg border border-border bg-surface2 px-2.5 py-2 text-xs whitespace-pre-wrap wrap-anywhere"
                      >
                        <div className="text-muted">
                          {ev.local || formatTs(ev.ts)} · {ev.sender || "task"}
                        </div>
                        <div className="mt-1">{ev.text || ""}</div>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
              {task.status === "pending_approval" && (
                <div className="mt-3">
                  <TaskApprovalForm
                    key={task.id}
                    task={task}
                    setStatus={setStatus}
                    onDone={async () => {
                      closeModal();
                      await loadTasks(false);
                    }}
                  />
                </div>
              )}
            </>
          )}
        </Modal>
      )}
    </div>
  );
}
