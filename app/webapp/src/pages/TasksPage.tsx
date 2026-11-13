import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useApi } from "../lib/api-context.tsx";
import { usePolling } from "../lib/use-polling.ts";
import {
  badgeVariant,
  formatTs,
  friendlyError,
  noteSummary,
} from "../lib/format.ts";
import type { ExecutorInfo, TaskSnapshot, TaskView } from "../lib/types.ts";
import {
  Badge,
  Button,
  Chip,
  Empty,
  Field,
  FilterBar,
  Input,
  Kpi,
  KpiGrid,
  Page,
  PageHead,
  Select,
  StatusText,
  TableWrap,
  Textarea,
} from "../components/ui.tsx";
import { Drawer } from "../components/Drawer.tsx";
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

type BoardGroup = {
  key: string;
  title: string;
  statuses: string[];
  variant: "default" | "done" | "closed" | "info" | "warn";
};

const BOARD_PAGE_SIZE = 10;

const BOARD_GROUPS: BoardGroup[] = [
  { key: "pending", title: "待审批", statuses: ["pending_approval", "pending"], variant: "warn" },
  { key: "running", title: "进行中", statuses: ["running"], variant: "info" },
  { key: "blocked", title: "阻塞", statuses: ["blocked", "failed"], variant: "closed" },
  { key: "done", title: "已结束", statuses: ["done", "cancelled"], variant: "default" },
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
  const [rejectReason, setRejectReason] = useState("");
  const [confirming, setConfirming] = useState(false);
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
    <div className="mt-3 rounded-xl border border-border bg-surface2 p-3.5">
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
      <div className="mt-2.5">
        <Field label="驳回原因（必填）">
          <Textarea
            rows={2}
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="写清楚为什么不通过"
          />
        </Field>
      </div>
      <p className="mt-2.5 text-xs text-muted">
        优先在飞书审批房给任务提示贴 OK；这里是备用入口。work_dir / executor / model 只读，v1 不支持在 Web 修改。
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
            通过后会立即以无审批模式启动{" "}
            {task.executor === "mimo" ? "mimo" : "opencode（带 --dangerously-skip-permissions）"}
            ，可能执行任意命令。请确认你已经了解风险。
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

export function TasksPage({
  reloadSignal,
  focusTaskId,
  onFocusHandled,
}: {
  reloadSignal: number;
  focusTaskId?: number | null;
  onFocusHandled?: () => void;
}) {
  const request = useApi();
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [statusFilter, setStatusFilter] = useState("");
  const [executorFilter, setExecutorFilter] = useState("");
  const [executors, setExecutors] = useState<ExecutorInfo[]>([]);
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<"board" | "list">("board");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: "" });
  const [modalId, setModalId] = useState<number | null>(null);
  const [drawerTab, setDrawerTab] = useState<"detail" | "events">("detail");
  const [modalLoading, setModalLoading] = useState(false);
  const [snapshots, setSnapshots] = useState<Record<number, TaskSnapshot>>({});
  const [boardLimits, setBoardLimits] = useState<Record<string, number>>({});
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
    setBoardLimits({});
  }, [statusFilter, executorFilter, search]);

  useEffect(() => {
    let alive = true;
    void request<ExecutorInfo[]>("/v1/executors")
      .then((list) => {
        if (alive) setExecutors(list);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [request]);

  useEffect(() => {
    if (reloadSignal === 0) return;
    void loadTasks(false);
  }, [reloadSignal, loadTasks]);

  useEffect(() => {
    if (focusTaskId === null || focusTaskId === undefined) return;
    setStatusFilter("");
    setViewMode("list");
    setModalId(focusTaskId);
    setDrawerTab("detail");
    setModalLoading(true);
    void loadSnapshot(focusTaskId, false);
    void loadTasks(true);
    onFocusHandled?.();
  }, [focusTaskId, loadSnapshot, loadTasks, onFocusHandled]);

  usePolling(() => loadTasks(true), 3000);

  const openTask = (id: number) => {
    setModalId(id);
    setDrawerTab("detail");
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

  const counts = { pending: 0, running: 0, blocked: 0, done: 0 };
  for (const t of tasks) {
    if (t.status === "pending_approval" || t.status === "pending") counts.pending++;
    else if (t.status === "running") counts.running++;
    else if (t.status === "blocked" || t.status === "failed") counts.blocked++;
    else if (t.status === "done" || t.status === "cancelled") counts.done++;
  }

  const task = modalId !== null ? tasks.find((t) => t.id === modalId) : undefined;
  const snap = modalId !== null ? snapshots[modalId] ?? null : null;

  return (
    <Page>
      <PageHead
        eyebrow="Task Pool"
        title="任务"
        sub="按状态扫任务，审批与预览不离开列表。审批通过后执行器会以无审批模式启动。"
        actions={<Chip>{filtered.length} 条结果</Chip>}
      />

      <KpiGrid>
        <Kpi label="待审批" value={counts.pending} note="飞书审批为主" tone="amber" />
        <Kpi label="进行中" value={counts.running} note="含 running / working" tone="accent" />
        <Kpi label="阻塞" value={counts.blocked} note="需要人介入" tone="rose" />
        <Kpi label="已结束" value={counts.done} note="含 cancelled" />
      </KpiGrid>

      <FilterBar>
        <Field label="视图">
          <div className="inline-flex rounded-[8px] border border-border bg-surface2 p-0.5">
            {(["board", "list"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                className={
                  viewMode === mode
                    ? "rounded-[6px] bg-surface px-2.5 py-1 text-[11.5px] font-semibold text-accent-ink shadow-sm"
                    : "rounded-[6px] px-2.5 py-1 text-[11.5px] text-muted"
                }
                aria-pressed={viewMode === mode}
                onClick={() => setViewMode(mode)}
              >
                {mode === "board" ? "看板" : "列表"}
              </button>
            ))}
          </div>
        </Field>
        <Field label="状态">
          <Select
            value={statusFilter}
            onValueChange={(value) => {
              setStatusFilter(value);
              setPage(1);
            }}
            options={[
              { value: "", label: "全部" },
              ...STATUS_OPTIONS.map((value) => ({ value, label: value })),
            ]}
          />
        </Field>
        <Field label="执行器">
          <Select
            value={executorFilter}
            onValueChange={(value) => {
              setExecutorFilter(value);
              setPage(1);
            }}
            options={[
              { value: "", label: "全部" },
              ...(executors.length
                ? executors.map((e) => ({ value: e.name, label: e.available ? e.name : `${e.name}（未安装）` }))
                : [{ value: "opencode", label: "opencode" }, { value: "mimo", label: "mimo" }]),
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
      </FilterBar>

      <StatusText text={status.text} error={status.error} />

      {!filtered.length ? (
        <Empty>{tasks.length ? "没有匹配的任务。" : "没有任务。"}</Empty>
      ) : viewMode === "board" ? (
        <div className="grid grid-cols-4 items-start gap-2.5 max-[1100px]:grid-cols-2 max-[640px]:grid-cols-1">
          {BOARD_GROUPS.map((group) => {
            const list = filtered.filter((t) => group.statuses.includes(t.status));
            const limit = boardLimits[group.key] ?? BOARD_PAGE_SIZE;
            const shown = list.slice(0, limit);
            return (
              <div
                key={group.key}
                className="min-h-[120px] rounded-[12px] border border-border bg-surface2 p-2"
              >
                <div className="flex items-center gap-2 px-1 pb-2 pt-0.5 text-[11.5px] font-bold text-muted">
                  <Badge variant={group.variant}>{group.title}</Badge>
                  <span className="ml-auto font-mono text-[10px] text-faint">
                    {shown.length}/{list.length}
                  </span>
                </div>
                {shown.length ? (
                  shown.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      className="mb-1.5 block w-full rounded-[10px] border border-border bg-surface p-2.5 text-left transition hover:-translate-y-px hover:border-accent/45 hover:shadow-[var(--rb-shadow)]"
                      onClick={() => openTask(t.id)}
                    >
                      <div className="mb-1 flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-[10.5px] text-faint">#{t.id}</span>
                        <Badge variant={badgeVariant(t.status)}>{t.status}</Badge>
                        {t.stage ? (
                          <span className="rounded-[5px] border border-border bg-surface2 px-1.5 py-px font-mono text-[10px] text-muted">
                            {t.stage}
                          </span>
                        ) : null}
                      </div>
                      <div className="line-clamp-2 text-[12px] leading-snug">
                        {t.goal || "（无目标）"}
                      </div>
                      <div className="mt-1.5 flex flex-wrap gap-x-2.5 gap-y-1 text-[10px] text-faint">
                        <span>{t.executor || "—"}</span>
                        <span>{t.worker_id || "未领取"}</span>
                        <span>{t.updated_at_local || formatTs(t.updated_at)}</span>
                      </div>
                      {noteSummary(t.note) && (
                        <div className="mt-1.5 truncate border-t border-dashed border-border pt-1.5 text-[10.5px] text-muted">
                          {noteSummary(t.note)}
                        </div>
                      )}
                    </button>
                  ))
                ) : (
                  <div className="px-1 py-3 text-center text-[11px] text-muted">没有任务</div>
                )}
                {list.length > shown.length ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full"
                    onClick={() =>
                      setBoardLimits((prev) => ({
                        ...prev,
                        [group.key]: (prev[group.key] ?? BOARD_PAGE_SIZE) + BOARD_PAGE_SIZE,
                      }))
                    }
                  >
                    加载更多（还有 {list.length - shown.length} 条）
                  </Button>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <>
          <TableWrap>
            <table className="w-full border-collapse text-[12.5px]">
              <thead>
                <tr>
                  {["id", "status", "goal", "executor", "worker", "updated", ""].map((label) => (
                    <th
                      key={label}
                      className="whitespace-nowrap border-b border-border bg-surface2 px-2.5 py-2 text-left text-[10.5px] font-semibold uppercase tracking-[0.05em] text-muted"
                    >
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pageRows.map((t) => (
                  <tr key={t.id} className="align-top transition hover:bg-accent-soft/30">
                    <td className="whitespace-nowrap border-b border-border px-2.5 py-2 font-mono text-[11px] text-muted">
                      #{t.id}
                    </td>
                    <td className="whitespace-nowrap border-b border-border px-2.5 py-2">
                      <Badge variant={badgeVariant(t.status)}>{t.status}</Badge>
                    </td>
                    <td className="max-w-[420px] border-b border-border px-2.5 py-2">
                      <span className="line-clamp-2">{t.goal || "（无目标）"}</span>
                    </td>
                    <td className="whitespace-nowrap border-b border-border px-2.5 py-2">
                      {t.executor || "—"}
                    </td>
                    <td className="whitespace-nowrap border-b border-border px-2.5 py-2 font-mono text-[10.5px]">
                      {t.worker_id || "—"}
                    </td>
                    <td className="whitespace-nowrap border-b border-border px-2.5 py-2 tabular-nums text-muted">
                      {t.updated_at_local || formatTs(t.updated_at)}
                    </td>
                    <td className="whitespace-nowrap border-b border-border px-2.5 py-2">
                      <Button variant="ghost" size="sm" onClick={() => openTask(t.id)}>
                        详情
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>

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
        </>
      )}

      {task && (
        <Drawer
          title={
            <span>
              #{task.id} {task.name || "任务详情"}
            </span>
          }
          onClose={closeModal}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={badgeVariant(task.status)}>{task.status}</Badge>
            {task.stage ? (
              <span className="rounded-[5px] border border-border bg-surface2 px-1.5 py-px font-mono text-[10.5px] text-muted">
                {task.stage}
              </span>
            ) : null}
            {task.model ? (
              <span className="rounded-[5px] border border-border bg-surface2 px-1.5 py-px font-mono text-[10.5px] text-muted">
                {task.model}
              </span>
            ) : null}
          </div>
          <div className="mt-3 flex text-[11.5px]">
            <button
              type="button"
              className={
                drawerTab === "detail"
                  ? "border-b-2 border-accent px-3 py-1.5 font-semibold text-text"
                  : "border-b-2 border-transparent px-3 py-1.5 text-muted"
              }
              onClick={() => setDrawerTab("detail")}
            >
              详情
            </button>
            <button
              type="button"
              className={
                drawerTab === "events"
                  ? "border-b-2 border-accent px-3 py-1.5 font-semibold text-text"
                  : "border-b-2 border-transparent px-3 py-1.5 text-muted"
              }
              onClick={() => setDrawerTab("events")}
            >
              事件 · {snap?.recent_events?.length ?? 0}
            </button>
          </div>

          {drawerTab === "detail" ? (
            <>
              <DetailRows className="mt-0 border-t-0 pt-0" rows={buildDetailRows(task)} />
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
          ) : modalLoading ? (
            <p className="text-[13px] text-muted">正在加载任务快照…</p>
          ) : !snap?.recent_events?.length ? (
            <p className="text-[13px] text-muted">还没收到任务事件。</p>
          ) : (
            <ol className="m-0 mt-3 grid list-none gap-0 p-0">
              {snap.recent_events.map((ev) => (
                <li
                  key={ev.seq}
                  className="relative pb-3 pl-4 text-[11.5px] text-muted before:absolute before:left-0.5 before:top-1.5 before:size-[7px] before:rounded-full before:bg-line-strong after:absolute after:bottom-0 after:left-[5px] after:top-4 after:w-px after:bg-border last:after:hidden"
                >
                  <b className="text-text">
                    {ev.local || formatTs(ev.ts)} · {ev.sender || "task"}
                  </b>
                  <div className="mt-0.5 whitespace-pre-wrap wrap-anywhere">{ev.text || ""}</div>
                </li>
              ))}
            </ol>
          )}
        </Drawer>
      )}
    </Page>
  );
}
