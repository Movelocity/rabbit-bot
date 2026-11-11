import { useEffect, useState } from "react";
import { useApi } from "../../lib/api-context.tsx";
import { friendlyError, money, num } from "../../lib/format.ts";
import type { TaskStats } from "../../lib/types.ts";
import { Empty, Field, Select, StatusText } from "../../components/ui.tsx";

type Range = "7d" | "30d" | "90d" | "all";

const RANGE_MS: Record<Exclude<Range, "all">, number> = {
  "7d": 7 * 86400e3,
  "30d": 30 * 86400e3,
  "90d": 90 * 86400e3,
};

const RANGES: { value: Range; label: string }[] = [
  { value: "7d", label: "最近 7 天" },
  { value: "30d", label: "最近 30 天" },
  { value: "90d", label: "最近 90 天" },
  { value: "all", label: "全部" },
];

function duration(ms: number): string {
  const n = Math.max(0, Number(ms) || 0);
  if (n === 0) return "0 秒";
  if (n < 60_000) return `${Math.max(1, Math.round(n / 1000))} 秒`;
  if (n < 3600_000) {
    const m = Math.floor(n / 60_000);
    const s = Math.round((n % 60_000) / 1000);
    return s ? `${m} 分 ${s} 秒` : `${m} 分钟`;
  }
  const h = Math.floor(n / 3600_000);
  const m = Math.round((n % 3600_000) / 60_000);
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

export function TaskStatsView({ reloadSignal }: { reloadSignal: number }) {
  const request = useApi();
  const [range, setRange] = useState<Range>("30d");
  const [stats, setStats] = useState<TaskStats | null>(null);
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: "" });

  useEffect(() => {
    let cancelled = false;
    setStatus({ text: "加载中…" });
    const to = Date.now();
    const from = range === "all" ? 0 : to - RANGE_MS[range];
    (async () => {
      try {
        const data = await request<TaskStats>(`/v1/tasks/stats?from=${from}&to=${to}`);
        if (cancelled) return;
        setStats(data);
        setStatus({
          text: `共 ${data.summary.tasks} 个完成任务 · 最近更新 ${new Date().toLocaleTimeString("zh-CN")}`,
        });
      } catch (e) {
        if (cancelled) return;
        setStatus({ text: `加载失败：${friendlyError(e)}`, error: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [range, reloadSignal, request]);

  const summary = stats?.summary;
  const cards: [string, string][] = summary
    ? [
        ["完成任务", num(summary.tasks)],
        ["总耗时", duration(summary.durationMs)],
        ["平均耗时", duration(summary.avgDurationMs)],
        ["总 token", num(summary.totalTokens)],
        ["总费用", money(summary.costUsd)],
      ]
    : [];

  return (
    <>
      <div className="my-3 flex flex-wrap items-end gap-3">
        <Field label="范围" compact>
          <Select
            value={range}
            onValueChange={(value) => setRange(value as Range)}
            options={RANGES}
          />
        </Field>
        {summary && summary.tasks > 0 && (
          <div className="flex flex-wrap gap-1.5 pb-1">
            {stats?.by_executor.map((e) => (
              <span
                key={e.executor}
                className="rounded-full border border-border bg-surface2 px-2.5 py-1 text-xs text-muted"
              >
                {e.executor} · {num(e.tasks)} 个 · {duration(e.durationMs)} · {num(e.totalTokens)} tok · {money(e.costUsd)}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="my-3 grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2.5">
        {cards.map(([label, value]) => (
          <div
            key={label}
            className="flex flex-col gap-1 rounded-[14px] border border-border bg-surface px-3.5 py-3 shadow-[var(--rb-shadow)]"
          >
            <span className="text-xs text-muted">{label}</span>
            <strong className="text-xl tabular-nums">{value}</strong>
          </div>
        ))}
      </div>

      {stats && stats.tasks.length > 0 ? (
        <div className="overflow-x-auto rounded-[14px] border border-border bg-surface">
          <table className="w-full border-collapse text-[13px] max-[820px]:text-xs">
            <thead>
              <tr>
                {["任务", "执行器", "完成时间", "耗时", "步数", "Token", "费用"].map((label) => (
                  <th
                    key={label}
                    className="whitespace-nowrap border-b border-border bg-surface2 px-3 py-2 text-left text-xs font-semibold text-muted"
                  >
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {stats.tasks.map((t) => (
                <tr
                  key={t.id}
                  className="[&:not(:last-child)>td]:border-b [&:not(:last-child)>td]:border-border"
                >
                  <td className="max-w-[360px] px-3 py-2">
                    <span className="mr-1 text-muted tabular-nums">#{t.id}</span>
                    <span className="wrap-anywhere">{t.name.replace(new RegExp(`^#\\s*${t.id}\\s*`), "")}</span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    {t.executor}
                    {t.model ? <span className="text-muted"> · {t.model}</span> : null}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">{t.end_at_local}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{duration(t.duration_ms)}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{num(t.steps)}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{num(t.total_tokens)}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{money(t.cost_usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="rounded-[14px] border border-border bg-surface p-2.5">
          <Empty>{status.error ? "任务统计加载失败。" : "这个时间段还没有完成的任务。"}</Empty>
        </div>
      )}
      <StatusText text={status.text} error={status.error} />
    </>
  );
}
