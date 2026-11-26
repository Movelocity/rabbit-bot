import { useCallback, useEffect, useMemo, useState } from "react";
import { useApi } from "../lib/api-context.tsx";
import { usePolling } from "../lib/use-polling.ts";
import { cx } from "../lib/cx.ts";
import { badgeVariant, formatTs, friendlyError } from "../lib/format.ts";
import type { Approval, ApprovalStatus } from "../lib/types.ts";
import {
  Badge,
  Button,
  Empty,
  Notice,
  Page,
  Segmented,
  StatusText,
} from "../components/ui.tsx";
import { HostReadLog } from "./approvals/HostReadLog.tsx";
import { HostReadRules } from "./approvals/HostReadRules.tsx";

type View = "log" | "approvals" | "rules";
const VIEWS: View[] = ["log", "approvals", "rules"];

function initialView(): View {
  const v = new URLSearchParams(window.location.search).get("scope");
  return VIEWS.includes(v as View) ? (v as View) : "log";
}

/** 子视图记进 URL，刷新/分享链接能回到同一处 */
function syncViewToUrl(view: View) {
  const params = new URLSearchParams(window.location.search);
  params.set("scope", view);
  window.history.replaceState(window.history.state, "", `${window.location.pathname}?${params}${window.location.hash}`);
}

type StatusFilter = "" | ApprovalStatus;

const STATUS_TABS: { value: StatusFilter; label: string }[] = [
  { value: "", label: "全部" },
  { value: "pending", label: "待处理" },
  { value: "approved", label: "已通过" },
  { value: "rejected", label: "已拒绝" },
  { value: "timeout", label: "超时" },
];

export function ApprovalsPage({
  reloadSignal,
  onOpenTask,
}: {
  reloadSignal: number;
  onOpenTask?: (taskId: number) => void;
}) {
  const request = useApi();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("");
  const [rows, setRows] = useState<Approval[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: "" });
  const [view, setViewState] = useState<View>(initialView);
  const [deciding, setDeciding] = useState(false);
  const setView = (v: View) => {
    setViewState(v);
    syncViewToUrl(v);
  };

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setStatus({ text: "加载中…" });
      try {
        const data = await request<Approval[]>("/v1/approvals");
        setRows(data);
        setStatus({ text: data.length ? "" : "没有权限申请。" });
      } catch (e) {
        setStatus({ text: `加载失败：${friendlyError(e)}`, error: true });
      }
    },
    [request],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  useEffect(() => {
    if (reloadSignal === 0) return;
    void load(false);
  }, [reloadSignal, load]);

  usePolling(() => load(true), 3000);

  const decide = async (id: number, decision: "approved" | "rejected") => {
    setDeciding(true);
    try {
      await request(`/v1/approvals/${id}/decide`, { method: "POST", body: { decision, by: "web" } });
      setStatus({ text: `#${id} 已${decision === "approved" ? "批准" : "拒绝"}` });
      await load(true);
    } catch (e) {
      setStatus({ text: `裁决失败：${friendlyError(e)}`, error: true });
    } finally {
      setDeciding(false);
    }
  };

  const counts = useMemo(() => {
    const next: Record<StatusFilter, number> = {
      "": rows.length,
      pending: 0,
      approved: 0,
      rejected: 0,
      timeout: 0,
    };
    for (const row of rows) next[row.status]++;
    return next;
  }, [rows]);

  const sortedRows = useMemo(
    () =>
      rows
        .filter((row) => !statusFilter || row.status === statusFilter)
        .sort((a, b) => {
          const aPriority = a.status === "pending" ? 0 : 1;
          const bPriority = b.status === "pending" ? 0 : 1;
          if (aPriority !== bPriority) return aPriority - bPriority;
          if (a.created_at !== b.created_at) return b.created_at - a.created_at;
          return b.id - a.id;
        }),
    [rows, statusFilter],
  );

  const selected =
    sortedRows.find((row) => row.id === selectedId) ?? sortedRows[0] ?? null;

  return (
    <Page>
      <div className="mb-3.5">
        <Segmented
          value={view}
          onChange={setView}
          label="权限视图"
          options={[
            { value: "log", label: "读取记录" },
            { value: "approvals", label: counts.pending ? `审批（${counts.pending} 待处理）` : "审批" },
            { value: "rules", label: "白名单与规则" },
          ]}
        />
      </div>

      {view === "log" && <HostReadLog onChanged={() => void load(true)} />}
      {view === "rules" && <HostReadRules reloadSignal={reloadSignal} />}

      {view === "approvals" && (<>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="inline-flex flex-wrap rounded-[8px] border border-border bg-surface2 p-0.5">
          {STATUS_TABS.map((tab) => (
            <button
              key={tab.value}
              type="button"
              className={cx(
                "whitespace-nowrap rounded-[6px] px-2.5 py-1 text-[11.5px] transition",
                statusFilter === tab.value
                  ? "bg-surface font-semibold text-accent-ink shadow-sm"
                  : "text-muted hover:text-text",
              )}
              aria-pressed={statusFilter === tab.value}
              onClick={() => setStatusFilter(tab.value)}
            >
              {tab.label} <span className="text-faint">{counts[tab.value]}</span>
            </button>
          ))}
        </div>
      </div>

      <StatusText text={status.text} error={status.error} />

      <div className="grid items-start gap-3.5 min-[1100px]:grid-cols-[minmax(0,1.15fr)_minmax(300px,0.85fr)]">
        <div className="flex min-w-0 flex-col gap-1.5">
          {!sortedRows.length ? (
            <Empty>这个状态没有申请。</Empty>
          ) : (
            sortedRows.map((row) => {
              const active = selected?.id === row.id;
              return (
                <button
                  key={row.id}
                  type="button"
                  className={cx(
                    "flex w-full items-start gap-2.5 rounded-[10px] border px-3 py-2.5 text-left transition",
                    active
                      ? "border-accent/48 bg-accent-soft"
                      : "border-border bg-surface hover:border-line-strong",
                  )}
                  onClick={() => setSelectedId(row.id)}
                >
                  <span
                    className={cx(
                      "grid size-6 flex-none place-items-center rounded-[7px] border text-[11px] font-bold",
                      row.status === "pending"
                        ? "border-clay/25 bg-clay-soft text-clay"
                        : "border-accent/25 bg-accent-soft text-accent-ink",
                    )}
                  >
                    {row.status === "pending" ? "!" : "✓"}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5 text-[12.5px] font-semibold">
                      <span className="font-mono text-[10.5px] text-faint">#{row.id}</span>
                      <span className="wrap-anywhere">{row.action || "（无 action）"}</span>
                      <Badge variant={badgeVariant(row.status)}>{row.status}</Badge>
                    </span>
                    <span className="mt-1 flex flex-wrap gap-x-2.5 gap-y-1 text-[10.5px] text-muted">
                      <span>{row.task_id ? `task #${row.task_id}` : "本机闸门"}</span>
                      <span>{row.worker_id || "—"}</span>
                      <span>创建 {row.created_at_local || formatTs(row.created_at)}</span>
                      <span>过期 {row.expires_at_local || formatTs(row.expires_at)}</span>
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </div>

        {selected ? (
          <aside className="rounded-[13px] border border-border bg-surface p-4 shadow-[var(--rb-shadow)] min-[1100px]:sticky min-[1100px]:top-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="rb-display m-0 text-[18px] wrap-anywhere">
                #{selected.id} {selected.action || "（无 action）"}
              </h3>
              <Badge variant={badgeVariant(selected.status)}>{selected.status}</Badge>
            </div>
            <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-muted">
              <span>{selected.task_id ? `task #${selected.task_id}` : "本机闸门"}</span>
              <span>{selected.worker_id || "—"}</span>
              <span>
                过期 {selected.expires_at_local || formatTs(selected.expires_at)}
              </span>
            </div>
            <div className="my-3 h-px bg-border" />
            {selected.detail ? (
              <div className="text-[12px]">
                <b>detail</b>
                <p className="m-0 mt-1 whitespace-pre-wrap leading-relaxed text-muted">
                  {selected.detail}
                </p>
              </div>
            ) : null}
            {selected.why ? (
              <div className="mt-2.5 text-[12px]">
                <b>why</b>
                <p className="m-0 mt-1 whitespace-pre-wrap leading-relaxed text-muted">
                  {selected.why}
                </p>
              </div>
            ) : null}

            <ol className="m-0 mt-3 grid list-none gap-0 p-0">
              <li className="relative pb-3 pl-4 text-[11.5px] text-muted before:absolute before:left-0.5 before:top-1.5 before:size-[7px] before:rounded-full before:bg-line-strong after:absolute after:bottom-0 after:left-[5px] after:top-4 after:w-px after:bg-border last:after:hidden">
                <b className="text-text">创建</b> ·{" "}
                {selected.created_at_local || formatTs(selected.created_at)}
                <br />
                任务进入待审批。
              </li>
              <li className="relative pb-3 pl-4 text-[11.5px] text-muted before:absolute before:left-0.5 before:top-1.5 before:size-[7px] before:rounded-full before:bg-line-strong after:absolute after:bottom-0 after:left-[5px] after:top-4 after:w-px after:bg-border last:after:hidden">
                <b className="text-text">过期</b> ·{" "}
                {selected.expires_at_local || formatTs(selected.expires_at)}
                <br />
                {selected.status === "timeout" ? "已超时，按拒绝处理。" : "到期不裁决按拒绝处理。"}
              </li>
              <li className="relative pb-3 pl-4 text-[11.5px] text-muted before:absolute before:left-0.5 before:top-1.5 before:size-[7px] before:rounded-full before:bg-line-strong after:absolute after:bottom-0 after:left-[5px] after:top-4 after:w-px after:bg-border last:after:hidden">
                {selected.decided_at ? (
                  <>
                    <b className="text-text">裁决</b> ·{" "}
                    {selected.decided_at_local || formatTs(selected.decided_at)}
                    <br />
                    <Badge variant={badgeVariant(selected.status)}>{selected.status}</Badge>
                  </>
                ) : (
                  <>
                    <b className="text-text">待裁决</b>
                    <br />
                    在下方或审批房裁决。
                  </>
                )}
              </li>
            </ol>

            {selected.status === "pending" ? (
              <div className="mt-3 flex gap-2">
                <Button variant="primary" size="sm" className="flex-1" disabled={deciding} onClick={() => void decide(selected.id, "approved")}>
                  批准
                </Button>
                <Button variant="danger" size="sm" className="flex-1" disabled={deciding} onClick={() => void decide(selected.id, "rejected")}>
                  拒绝
                </Button>
              </div>
            ) : null}
            {selected.worker_id === "host" ? (
              <Notice className="mt-3">本机闸门的审批：批准只放行这一次。想以后不再问，去「白名单与规则」加目录（密钥类文件除外）。</Notice>
            ) : null}
            {onOpenTask && selected.task_id > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                className="mt-2.5 w-full"
                onClick={() => onOpenTask(selected.task_id)}
              >
                去任务里看 →
              </Button>
            ) : null}
          </aside>
        ) : null}
      </div>
      </>)}
    </Page>
  );
}
