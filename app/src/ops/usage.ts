/** Token 用量只读视图：逐次事件按小时/天聚合，API 和 Web 共用。 */
import type { Store, UsageEventRow } from "../core/db.ts";
import { fmtLocal } from "../core/time.ts";

const TZ = "Asia/Shanghai";

export interface UsageSummary {
  calls: number;
  tokens: number;
  cacheHit: number;
  cacheMiss: number;
  outTokens: number;
  costUsd: number;
  hitRate: number;
}

export interface UsageBucketPoint {
  key: string;
  label: string;
  calls: number;
  tokens: number;
  cacheHit: number;
  cacheMiss: number;
  outTokens: number;
  costUsd: number;
}

export interface UsageCall extends UsageEventRow {
  ts_local: string;
}

function summarize(rows: UsageEventRow[]): UsageSummary {
  let calls = 0, tokens = 0, cacheHit = 0, cacheMiss = 0, outTokens = 0, costUsd = 0;
  for (const r of rows) {
    calls += r.calls;
    tokens += r.totalTokens;
    cacheHit += r.cacheHit;
    cacheMiss += r.cacheMiss;
    outTokens += r.outTokens;
    costUsd += r.costUsd;
  }
  const input = cacheHit + cacheMiss;
  return {
    calls,
    tokens,
    cacheHit,
    cacheMiss,
    outTokens,
    costUsd,
    hitRate: input > 0 ? cacheHit / input : 0,
  };
}

export function usageSummary(store: Store, from: number, to: number, tz = TZ): UsageSummary {
  return summarize(store.listUsageEvents(from, to));
}

export function usageSeries(
  store: Store, from: number, to: number, bucket: "hour" | "day", tz = TZ,
): UsageBucketPoint[] {
  const rows = store.listUsageEvents(from, to);
  const buckets = new Map<string, UsageBucketPoint>();
  for (const r of rows) {
    const local = fmtLocal(r.ts, tz);
    const key = bucket === "hour" ? local.slice(0, 13) : local.slice(0, 10);
    const label = bucket === "hour" ? `${local.slice(5, 10)} ${local.slice(11, 13)}:00` : local.slice(5, 10);
    let p = buckets.get(key);
    if (!p) {
      p = { key, label, calls: 0, tokens: 0, cacheHit: 0, cacheMiss: 0, outTokens: 0, costUsd: 0 };
      buckets.set(key, p);
    }
    p.calls += r.calls;
    p.tokens += r.totalTokens;
    p.cacheHit += r.cacheHit;
    p.cacheMiss += r.cacheMiss;
    p.outTokens += r.outTokens;
    p.costUsd += r.costUsd;
  }
  return Array.from(buckets.values()).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export function usageCalls(
  store: Store, from: number, to: number, limit = 200, tz = TZ,
): UsageCall[] {
  return store.listUsageEvents(from, to, limit).map((r) => ({ ...r, ts_local: fmtLocal(r.ts, tz) }));
}
