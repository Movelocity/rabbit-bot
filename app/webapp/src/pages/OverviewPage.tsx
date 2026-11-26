import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useApi } from "../lib/api-context.tsx";
import { usePolling } from "../lib/use-polling.ts";
import { cx } from "../lib/cx.ts";
import {
  badgeVariant,
  duration,
  formatTs,
  friendlyError,
  num,
  platformLabel,
} from "../lib/format.ts";
import type {
  AdapterStatusResponse,
  Approval,
  LimitStatus,
  SchedulerStatus,
  TaskView,
  UsageStats,
} from "../lib/types.ts";
import {
  Badge,
  Button,
  Chip,
  Kpi,
  KpiGrid,
  Page,
  StatusText,
} from "../components/ui.tsx";

const STATUS_LABEL: Record<string, string> = {
  pending_approval: "待审批",
  pending: "排队中",
  running: "执行中",
  blocked: "已阻塞",
  done: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

const ACTIVE_STATUSES = ["running", "blocked", "pending_approval", "pending"];

const STATUS_PRIORITY: Record<string, number> = {
  running: 0,
  blocked: 1,
  pending_approval: 2,
  pending: 3,
};

interface OverviewData {
  tasks: TaskView[];
  approvals: Approval[];
  limits: LimitStatus;
  usage: UsageStats;
  adapters: AdapterStatusResponse;
  scheduler: SchedulerStatus;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function dayLabel(date: Date): string {
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function fmtTokens(value: number): string {
  const n = Number(value) || 0;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

function fmtCny(value: number): string {
  return `¥${(Number(value) || 0).toFixed(2)}`;
}

function remainText(expiresAt: number, now: number): string {
  const ms = expiresAt - now;
  if (ms <= 0) return "已过期";
  const minutes = Math.ceil(ms / 60_000);
  return minutes <= 1 ? "不到 1 分钟后过期" : `${minutes} 分钟后过期`;
}

function activeElapsed(task: TaskView, now: number): string {
  if (task.status !== "running" && task.status !== "blocked") return "—";
  const start = task.runner_started_at ?? task.start_at;
  if (!start) return "—";
  return duration(Math.max(0, now - start));
}

function Panel({
  title,
  aside,
  children,
  className,
}: {
  title: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cx(
        "min-w-0 overflow-hidden rounded-[14px] border border-border bg-surface",
        className,
      )}
    >
      <div className="flex h-11 items-center gap-3 border-b border-border px-3.5">
        <span className="text-[13px] leading-none font-semibold">{title}</span>
        {aside ? (
          <div className="ml-auto flex items-center gap-2 text-[11.5px] leading-none text-muted">
            {aside}
          </div>
        ) : null}
      </div>
      {children}
    </section>
  );
}

type AlertTone = "rose" | "amber" | "default";

interface AlertItem {
  tone: AlertTone;
  label: string;
  text: string;
  meta?: string;
}

export function OverviewPage({
  reloadSignal,
  onOpenTask,
  onOpenTasks,
  onOpenApprovals,
  onOpenLogs,
}: {
  reloadSignal: number;
  onOpenTask: (taskId: number) => void;
  onOpenTasks: () => void;
  onOpenApprovals: () => void;
  onOpenLogs: () => void;
}) {
  const request = useApi();
  const [data, setData] = useState<OverviewData | null>(null);
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: "" });

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setStatus({ text: "加载中…" });
      const now = Date.now();
      const from = now - 6 * 86400e3;
      try {
        const [tasks, approvals, limits, usage, adapters, scheduler] = await Promise.all([
          request<TaskView[]>("/v1/tasks"),
          request<Approval[]>("/v1/approvals"),
          request<LimitStatus>("/v1/limits"),
          request<UsageStats>(`/v1/usage?bucket=day&from=${from}&to=${now}`),
          request<AdapterStatusResponse>("/v1/adapters/status"),
          request<SchedulerStatus>("/v1/scheduler/status"),
        ]);
        setData({ tasks, approvals, limits, usage, adapters, scheduler });
        setStatus({ text: "" });
      } catch (e) {
        if (!silent) setStatus({ text: `加载失败：${friendlyError(e)}`, error: true });
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

  usePolling(() => load(true), 10_000);

  const now = Date.now();
  const todayStart = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }, []);

  const tasks = data?.tasks ?? [];
  const activeTasks = useMemo(
    () =>
      tasks
        .filter((t) => ACTIVE_STATUSES.includes(t.status))
        .sort((a, b) => {
          const pa = STATUS_PRIORITY[a.status] ?? 9;
          const pb = STATUS_PRIORITY[b.status] ?? 9;
          if (pa !== pb) return pa - pb;
          return b.updated_at - a.updated_at;
        }),
    [tasks],
  );

  const runningCount = tasks.filter((t) => t.status === "running").length;
  const pendingCount = tasks.filter((t) => t.status === "pending").length;
  const blockedCount = tasks.filter((t) => t.status === "blocked").length;

  const doneToday = tasks.filter((t) => {
    if (t.status !== "done") return false;
    const at = t.end_at ?? t.updated_at;
    return at >= todayStart;
  }).length;

  const failedToday = tasks.filter((t) => {
    if (t.status !== "failed") return false;
    const at = t.end_at ?? t.updated_at;
    return at >= todayStart;
  }).length;

  const pendingApprovals = useMemo(
    () =>
      (data?.approvals ?? [])
        .filter((a) => a.status === "pending")
        .sort((a, b) => a.expires_at - b.expires_at),
    [data],
  );

  const usageDays = useMemo(() => {
    const series = data?.usage.series ?? [];
    const byLabel = new Map(series.map((p) => [p.label, p.tokens]));
    const out: { label: string; tokens: number; today: boolean }[] = [];
    const base = new Date(now);
    for (let i = 6; i >= 0; i--) {
      const d = new Date(base);
      d.setDate(base.getDate() - i);
      const label = dayLabel(d);
      out.push({ label, tokens: byLabel.get(label) ?? 0, today: i === 0 });
    }
    return out;
  }, [data, now]);

  const usageMax = usageDays.reduce((max, d) => Math.max(max, d.tokens), 0);

  const quotaRows = useMemo(() => {
    if (!data) return [];
    const { today, dailyLlmCalls, dailyTokens, dailyCny } = data.limits;
    return [
      {
        label: "调用次数",
        used: today.llm_calls,
        limit: dailyLlmCalls,
        usedText: `${num(today.llm_calls)} 次`,
        limitText: dailyLlmCalls > 0 ? `${num(dailyLlmCalls)} 次` : "",
      },
      {
        label: "tokens",
        used: today.tokens,
        limit: dailyTokens,
        usedText: fmtTokens(today.tokens),
        limitText: dailyTokens > 0 ? fmtTokens(dailyTokens) : "",
      },
      {
        label: "人民币",
        used: today.cost_cny,
        limit: dailyCny,
        usedText: fmtCny(today.cost_cny),
        limitText: dailyCny > 0 ? fmtCny(dailyCny) : "",
      },
    ];
  }, [data]);

  const alerts = useMemo(() => {
    const out: AlertItem[] = [];
    for (const adapter of data?.adapters.adapters ?? []) {
      const name = platformLabel(adapter.platform);
      if (adapter.state === "reconnecting") {
        out.push({
          tone: "rose",
          label: name,
          text: "连接断开，正在重连",
          meta: adapter.disconnected_at ? `断开于 ${formatTs(adapter.disconnected_at)}` : undefined,
        });
      } else if (adapter.state === "stopped") {
        out.push({
          tone: "rose",
          label: name,
          text: "适配器已停止",
          meta: adapter.last_error || undefined,
        });
      }
      const gap = adapter.last_gap;
      if (gap && gap.missed > 0) {
        out.push({
          tone: "amber",
          label: name,
          text: `最近一次断线漏收 ${gap.missed} 条消息`,
          meta: gap.error || `${formatTs(gap.checked_at)} 已补拉`,
        });
      }
    }
    if (data?.scheduler.paused) {
      out.push({ tone: "rose", label: "调度器", text: "调度器已暂停，不会唤醒 Agent" });
    }
    if (data && data.scheduler.pauses_detected > 0) {
      out.push({
        tone: "amber",
        label: "调度器",
        text: `检测到 ${data.scheduler.pauses_detected} 次时钟暂停`,
        meta: `已恢复 ${data.scheduler.recovered} 次`,
      });
    }
    if (blockedCount > 0) {
      out.push({ tone: "amber", label: "任务", text: `${blockedCount} 个任务阻塞，等待处理` });
    }
    if (failedToday > 0) {
      out.push({ tone: "rose", label: "任务", text: `${failedToday} 个任务今日失败` });
    }
    for (const row of quotaRows) {
      if (row.limit > 0 && row.used >= row.limit) {
        out.push({ tone: "rose", label: "额度", text: `${row.label} 已到日上限，唤醒已暂停` });
        break;
      }
    }
    const severity: Record<AlertTone, number> = { rose: 0, amber: 1, default: 2 };
    return out.sort((a, b) => severity[a.tone] - severity[b.tone]).slice(0, 5);
  }, [data, blockedCount, failedToday, quotaRows]);

  return (
    <Page>
      {!data ? (
        <StatusText text={status.text || "加载中…"} error={status.error} />
      ) : (
        <>
          {status.error ? <StatusText text={status.text} error /> : null}

          <KpiGrid>
            <Kpi
              label="执行中"
              value={num(runningCount)}
              note={`排队 ${pendingCount} · 阻塞 ${blockedCount}`}
              tone="accent"
            />
            <Kpi label="今日完成" value={num(doneToday)} note="按任务结束时间统计" />
            <Kpi
              label="待审批"
              value={num(pendingApprovals.length)}
              note={
                pendingApprovals[0]
                  ? remainText(pendingApprovals[0].expires_at, now)
                  : "没有等待中的申请"
              }
              tone={pendingApprovals.length ? "amber" : "default"}
            />
            <Kpi
              label="今日 tokens"
              value={fmtTokens(data.limits.today.tokens)}
              note={`${num(data.limits.today.llm_calls)} 次调用`}
            />
            <Kpi
              label="今日费用"
              value={fmtCny(data.limits.today.cost_cny)}
              note={
                data.limits.dailyCny > 0
                  ? `日上限 ${fmtCny(data.limits.dailyCny)}`
                  : "不设金额闸"
              }
            />
          </KpiGrid>

          <div className="mb-3.5 grid items-start gap-3.5 min-[1100px]:grid-cols-[minmax(0,1.6fr)_minmax(300px,1fr)]">
            <Panel
              title="进行中的任务"
              aside={
                <>
                  <span className="text-faint">{activeTasks.length} 个</span>
                  <Button size="sm" variant="ghost" onClick={onOpenTasks}>
                    全部任务 →
                  </Button>
                </>
              }
            >
              {activeTasks.length === 0 ? (
                <div className="px-3.5 py-8 text-center text-[12.5px] text-faint">
                  没有进行中的任务。
                </div>
              ) : (
                <div className="rb-thin-scroll overflow-x-auto">
                  <table className="w-full border-collapse text-[12.5px]">
                    <thead>
                      <tr className="text-left text-[11px] text-faint">
                        <th className="px-3.5 py-2 font-medium">#</th>
                        <th className="px-3.5 py-2 font-medium">任务</th>
                        <th className="px-3.5 py-2 font-medium">状态</th>
                        <th className="px-3.5 py-2 font-medium">执行器</th>
                        <th className="px-3.5 py-2 font-medium">阶段</th>
                        <th className="px-3.5 py-2 text-right font-medium">用时</th>
                      </tr>
                    </thead>
                    <tbody>
                      {activeTasks.slice(0, 8).map((task) => (
                        <tr
                          key={task.id}
                          className="cursor-pointer border-t border-border transition-colors hover:bg-surface2"
                          onClick={() => onOpenTask(task.id)}
                        >
                          <td className="px-3.5 py-2 font-mono text-[11.5px] text-faint">
                            {task.id}
                          </td>
                          <td className="max-w-[260px] truncate px-3.5 py-2 font-medium">
                            {task.name || task.goal}
                          </td>
                          <td className="px-3.5 py-2">
                            <Badge variant={badgeVariant(task.status)}>
                              {STATUS_LABEL[task.status] ?? task.status}
                            </Badge>
                          </td>
                          <td className="px-3.5 py-2 text-muted">{task.executor || "opencode"}</td>
                          <td className="max-w-[220px] truncate px-3.5 py-2 text-muted">
                            {task.stage || "—"}
                          </td>
                          <td className="px-3.5 py-2 text-right font-mono text-[11.5px] text-muted">
                            {activeElapsed(task, now)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>

            <Panel
              title="需要你处理"
              aside={<span className="text-faint">{pendingApprovals.length} 项</span>}
            >
              {pendingApprovals.length === 0 ? (
                <div className="px-3.5 py-8 text-center text-[12.5px] text-faint">
                  都处理完了。
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {pendingApprovals.slice(0, 5).map((approval) => (
                    <div key={approval.id} className="flex items-start gap-2.5 px-3.5 py-2.5">
                      <Chip tone="amber">{approval.action}</Chip>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[12.5px]" title={approval.detail}>
                          {approval.detail || approval.why}
                        </div>
                        <div className="mt-0.5 text-[11px] text-faint">
                          任务 #{approval.task_id} · {remainText(approval.expires_at, now)}
                        </div>
                      </div>
                      <Button size="sm" variant="ghost" onClick={onOpenApprovals}>
                        处理
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </Panel>
          </div>

          <div className="grid items-start gap-3.5 min-[1100px]:grid-cols-3">
            <Panel title="今日额度" aside={<span className="text-faint">任一闸到顶即暂停唤醒</span>}>
              <div className="grid gap-3 px-3.5 py-3">
                {quotaRows.map((row) => {
                  const gated = row.limit > 0;
                  const ratio = gated ? row.used / row.limit : 0;
                  return (
                    <div key={row.label}>
                      <div className="flex items-baseline justify-between gap-2 text-[11.5px]">
                        <span className="text-muted">{row.label}</span>
                        <span className="font-mono tabular-nums">
                          {row.usedText}
                          {gated ? <span className="text-faint"> / {row.limitText}</span> : null}
                        </span>
                      </div>
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface2">
                        <i
                          className={cx(
                            "block h-full rounded-full",
                            ratio >= 1 ? "bg-rose" : ratio >= 0.8 ? "bg-amber" : "bg-accent",
                          )}
                          style={{ width: `${gated ? Math.min(100, ratio * 100) : 0}%` }}
                        />
                      </div>
                      {!gated ? (
                        <div className="mt-0.5 text-[10.5px] text-faint">不设这条闸</div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </Panel>

            <Panel
              title="近 7 天 tokens"
              aside={<span className="text-faint">按日 · 深色为今天</span>}
            >
              {usageMax === 0 ? (
                <div className="px-3.5 py-8 text-center text-[12.5px] text-faint">
                  近 7 天还没有用量记录。
                </div>
              ) : (
                <div className="flex h-[160px] items-stretch gap-2 px-3.5 pb-2 pt-3">
                  {usageDays.map((day) => (
                    <div key={day.label} className="flex min-w-0 flex-1 flex-col items-center gap-1">
                      <span className="font-mono text-[10.5px] text-faint tabular-nums">
                        {fmtTokens(day.tokens)}
                      </span>
                      <div className="flex w-full flex-1 items-end justify-center">
                        <i
                          className={cx(
                            "block w-full max-w-[36px] rounded-t-[5px]",
                            day.today ? "bg-accent" : "bg-accent/35",
                          )}
                          style={{ height: `${Math.max(2, (day.tokens / usageMax) * 100)}%` }}
                        />
                      </div>
                      <small className="text-[10.5px] text-faint">{day.label}</small>
                    </div>
                  ))}
                </div>
              )}
            </Panel>

            <Panel
              title="最近异常"
              aside={
                <>
                  <span className="text-faint">{alerts.length ? `${alerts.length} 条` : ""}</span>
                  <Button size="sm" variant="ghost" onClick={onOpenLogs}>
                    模型日志 →
                  </Button>
                </>
              }
            >
              {alerts.length === 0 ? (
                <div className="px-3.5 py-8 text-center text-[12.5px] text-faint">
                  运行正常，暂无异常。
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {alerts.map((alert, index) => (
                    <div key={`${alert.label}-${index}`} className="flex items-start gap-2.5 px-3.5 py-2.5">
                      <Chip tone={alert.tone === "rose" ? "rose" : alert.tone === "amber" ? "amber" : "default"}>
                        {alert.label}
                      </Chip>
                      <div className="min-w-0 flex-1">
                        <div className="text-[12.5px]">{alert.text}</div>
                        {alert.meta ? (
                          <div className="mt-0.5 text-[11px] text-faint">{alert.meta}</div>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Panel>
          </div>
        </>
      )}
    </Page>
  );
}