import { useEffect, useState } from "react";
import { useApi } from "../../lib/api-context.tsx";
import { formatTs, friendlyError, money, num } from "../../lib/format.ts";
import type { UsageCall, UsagePoint, UsageStats, UsageSummary } from "../../lib/types.ts";
import { Empty, Field, Select, StatusText } from "../../components/ui.tsx";

type Bucket = "hour" | "day";
type Range = "24h" | "7d" | "30d" | "90d";

const RANGE_MS: Record<Range, number> = {
  "24h": 24 * 3600e3,
  "7d": 7 * 86400e3,
  "30d": 30 * 86400e3,
  "90d": 90 * 86400e3,
};

const RANGES: Record<Bucket, { value: Range; label: string }[]> = {
  hour: [
    { value: "24h", label: "最近 24 小时" },
    { value: "7d", label: "7 天" },
    { value: "30d", label: "30 天" },
  ],
  day: [
    { value: "7d", label: "7 天" },
    { value: "30d", label: "30 天" },
    { value: "90d", label: "90 天" },
  ],
};

function UsageChart({ series }: { series: UsagePoint[] }) {
  if (!series.length) {
    return (
      <div className="mb-3 rounded-[14px] border border-border bg-surface p-2.5">
        <Empty>这个时间段还没有用量记录。</Empty>
      </div>
    );
  }
  const W = 800;
  const H = 240;
  const baseY = 206;
  const chartH = 170;
  const n = series.length;
  const maxTokens = series.reduce((m, p) => Math.max(m, Number(p.tokens) || 0), 0);
  const step = W / n;
  const barW = Math.max(1, Math.min(48, step * 0.66));
  const labelEvery = Math.max(1, Math.ceil(n / 8));

  return (
    <div className="mb-3 overflow-x-auto rounded-[14px] border border-border bg-surface px-3 py-2.5">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="token 用量柱状图"
        className="block h-auto w-full min-w-[520px] max-[820px]:min-w-[600px]"
      >
        <line
          x1={0}
          x2={W}
          y1={baseY}
          y2={baseY}
          stroke="var(--rb-border)"
          strokeWidth={1}
        />
        {series.map((p, i) => {
          const tokens = Number(p.tokens) || 0;
          const height = maxTokens > 0 ? (tokens / maxTokens) * chartH : 0;
          const x = step * i + (step - barW) / 2;
          const y = baseY - height;
          return (
            <g key={p.key}>
              <rect
                x={x}
                y={y}
                width={barW}
                height={Math.max(0, height)}
                fill="var(--rb-accent)"
                opacity={0.82}
              >
                <title>
                  {`${p.key} · ${num(tokens)} tokens · ${num(Number(p.calls) || 0)} 次 · ${money(Number(p.costUsd) || 0)}`}
                </title>
              </rect>
              {i % labelEvery === 0 && (
                <text
                  x={step * i + step / 2}
                  y={228}
                  textAnchor="middle"
                  fill="var(--rb-muted)"
                  fontSize={10}
                >
                  {p.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function CallsTable({ calls }: { calls: UsageCall[] }) {
  if (!calls.length) return null;
  const sourceLabel = (source: string) =>
    source === "llm" ? "模型调用" : source === "wake" ? "历史唤醒" : source || "—";
  const columns = [
    "时间",
    "来源",
    "模型",
    "调用",
    "缓存命中",
    "未命中",
    "输出",
    "合计",
    "成本",
  ];
  return (
    <div className="overflow-x-auto rounded-[14px] border border-border bg-surface">
      <table className="w-full border-collapse text-[13px] max-[820px]:text-xs">
        <thead>
          <tr>
            {columns.map((label) => (
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
          {calls.map((c, i) => (
            <tr key={i} className="[&:not(:last-child)>td]:border-b [&:not(:last-child)>td]:border-border">
              <td className="whitespace-nowrap px-3 py-2">{c.ts_local || formatTs(c.ts)}</td>
              <td className="whitespace-nowrap px-3 py-2">{sourceLabel(c.source)}</td>
              <td className="whitespace-nowrap px-3 py-2">{c.model || "—"}</td>
              <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{num(c.calls)}</td>
              <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{num(c.cacheHit)}</td>
              <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{num(c.cacheMiss)}</td>
              <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{num(c.outTokens)}</td>
              <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{num(c.totalTokens)}</td>
              <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{money(c.costUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function UsageView({ reloadSignal }: { reloadSignal: number }) {
  const request = useApi();
  const [bucket, setBucket] = useState<Bucket>("hour");
  const [range, setRange] = useState<Range>("24h");
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [series, setSeries] = useState<UsagePoint[]>([]);
  const [calls, setCalls] = useState<UsageCall[]>([]);
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: "" });

  useEffect(() => {
    let cancelled = false;
    setStatus({ text: "加载中…" });
    const to = Date.now();
    const from = to - RANGE_MS[range];
    (async () => {
      try {
        const [stats, detail] = await Promise.all([
          request<UsageStats>(
            `/v1/usage?bucket=${bucket}&from=${from}&to=${to}`,
          ),
          request<{ calls: UsageCall[] }>(
            `/v1/usage/calls?from=${from}&to=${to}&limit=200`,
          ),
        ]);
        if (cancelled) return;
        setSummary(stats.summary);
        setSeries(stats.series || []);
        setCalls(detail.calls || []);
        setStatus({
          text: `共 ${detail.calls?.length ?? 0} 条明细 · 最近更新 ${new Date().toLocaleTimeString("zh-CN")}`,
        });
      } catch (e) {
        if (cancelled) return;
        setStatus({ text: `加载失败：${friendlyError(e)}`, error: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bucket, range, reloadSignal, request]);

  const cards: [string, string][] = summary
    ? [
        ["总 token", num(summary.tokens)],
        ["调用次数", num(summary.calls)],
        ["成本", money(summary.costUsd)],
        ["缓存命中率", `${(Number(summary.hitRate || 0) * 100).toFixed(1)}%`],
      ]
    : [];

  return (
    <>
      <div className="my-3 flex flex-wrap items-end gap-3">
        <Field label="粒度" compact>
          <Select
            value={bucket}
            onChange={(e) => {
              const next = e.target.value === "day" ? "day" : "hour";
              setBucket(next);
              if (!RANGES[next].some((r) => r.value === range)) {
                setRange(RANGES[next][0].value);
              }
            }}
          >
            <option value="hour">按小时</option>
            <option value="day">按天</option>
          </Select>
        </Field>
        <Field label="范围" compact>
          <Select value={range} onChange={(e) => setRange(e.target.value as Range)}>
            {RANGES[bucket].map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </Select>
        </Field>
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

      <UsageChart series={series} />
      <CallsTable calls={calls} />
      <StatusText text={status.text} error={status.error} />
    </>
  );
}
