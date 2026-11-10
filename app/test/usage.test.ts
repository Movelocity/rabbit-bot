import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/db.ts";
import { usageCalls, usageSeries, usageSummary } from "../src/ops/usage.ts";

test("addUsageEvent + listUsageEvents：范围左闭右开、倒序、limit", () => {
  const s = new Store(":memory:");
  const base = Date.UTC(2026, 0, 5, 2, 0);
  s.addUsageEvent({ ts: base + 1_000, cacheHit: 1, cacheMiss: 2, outTokens: 3, totalTokens: 6, costUsd: 0.001 });
  s.addUsageEvent({ ts: base + 2_000, cacheHit: 4, cacheMiss: 5, outTokens: 6, totalTokens: 15, costUsd: 0.002, calls: 3 });
  s.addUsageEvent({ ts: base + 3_600_000, cacheHit: 7, cacheMiss: 8, outTokens: 9, totalTokens: 24, costUsd: 0.003 });

  const rows = s.listUsageEvents(base, base + 3_600_000);
  assert.deepEqual(rows.map((r) => r.ts), [base + 2_000, base + 1_000]);
  assert.equal(rows[0].source, "llm");
  assert.equal(rows[0].totalTokens, 15);
  assert.equal(rows[0].calls, 3);
  assert.equal(rows[1].calls, 1);

  const limited = s.listUsageEvents(base, base + 3_600_000, 1);
  assert.equal(limited.length, 1);
  assert.equal(limited[0].ts, base + 2_000);

  assert.equal(s.countUsageEvents(), 3);
  const calls = usageCalls(s, base, base + 3_600_000);
  assert.equal(calls.length, 2);
  assert.match(calls[0].ts_local, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});

test("usageSummary / usageSeries：按小时和按天分桶、汇总正确", () => {
  const s = new Store(":memory:");
  const t1 = Date.UTC(2026, 0, 5, 2, 10);
  const t2 = Date.UTC(2026, 0, 5, 2, 40);
  const t3 = Date.UTC(2026, 0, 5, 4, 10);
  const from = Date.UTC(2026, 0, 5, 0, 0);
  const to = Date.UTC(2026, 0, 6, 0, 0);
  s.addUsageEvent({ ts: t1, cacheHit: 60, cacheMiss: 40, outTokens: 20, totalTokens: 100, costUsd: 0.001, calls: 2 });
  s.addUsageEvent({ ts: t2, cacheHit: 100, cacheMiss: 100, outTokens: 50, totalTokens: 200, costUsd: 0.002, calls: 3 });
  s.addUsageEvent({ ts: t3, cacheHit: 0, cacheMiss: 200, outTokens: 30, totalTokens: 300, costUsd: 0.003, calls: 4 });

  const hours = usageSeries(s, from, to, "hour");
  assert.deepEqual(hours.map((p) => p.key), ["2026-01-05 10", "2026-01-05 12"]);
  assert.deepEqual(hours.map((p) => p.label), ["01-05 10:00", "01-05 12:00"]);
  assert.equal(hours[0].calls, 5);
  assert.equal(hours[0].tokens, 300);
  assert.equal(hours[0].cacheHit, 160);
  assert.equal(hours[0].cacheMiss, 140);
  assert.equal(hours[0].outTokens, 70);
  assert.ok(Math.abs(hours[0].costUsd - 0.003) < 1e-9);
  assert.equal(hours[1].calls, 4);
  assert.equal(hours[1].tokens, 300);

  const days = usageSeries(s, from, to, "day");
  assert.equal(days.length, 1);
  assert.equal(days[0].key, "2026-01-05");
  assert.equal(days[0].label, "01-05");
  assert.equal(days[0].calls, 9);
  assert.equal(days[0].tokens, 600);

  const sum = usageSummary(s, from, to);
  assert.equal(sum.calls, 9);
  assert.equal(sum.tokens, 600);
  assert.equal(sum.cacheHit, 160);
  assert.equal(sum.cacheMiss, 340);
  assert.equal(sum.outTokens, 100);
  assert.ok(Math.abs(sum.costUsd - 0.006) < 1e-9);
  assert.ok(Math.abs(sum.hitRate - 160 / 500) < 1e-9);
});

test("backfillUsageEventsFromWakeLog：空表回填一次，已有事件不重复", () => {
  const s = new Store(":memory:");
  const t1 = Date.UTC(2026, 0, 5, 2, 0);
  const t2 = Date.UTC(2026, 0, 5, 3, 0);
  const t3 = Date.UTC(2026, 0, 5, 4, 0);
  s.addWakeLog({ ts: t1, rawTokens: 100, cost: 0.01, llmCalls: 5 });
  s.addWakeLog({ ts: t2, tokens: 50 });
  s.addWakeLog({ ts: t3, cost: 0.02 });

  assert.equal(s.backfillUsageEventsFromWakeLog(), 2);
  const rows = s.listUsageEvents(0, Number.MAX_SAFE_INTEGER);
  assert.deepEqual(rows.map((r) => r.ts), [t2, t1]);
  assert.deepEqual(rows.map((r) => r.totalTokens), [50, 100]);
  assert.deepEqual(rows.map((r) => r.costUsd), [0, 0.01]);
  assert.deepEqual(rows.map((r) => r.calls), [1, 5]);
  for (const r of rows) {
    assert.equal(r.source, "wake");
    assert.equal(r.model, "");
    assert.equal(r.cacheHit, 0);
    assert.equal(r.cacheMiss, 0);
    assert.equal(r.outTokens, 0);
  }

  s.addUsageEvent({ ts: t3, cacheHit: 1, cacheMiss: 2, outTokens: 3, totalTokens: 6, costUsd: 0.001 });
  const before = s.countUsageEvents();
  assert.equal(s.backfillUsageEventsFromWakeLog(), 0);
  assert.equal(s.countUsageEvents(), before);
});

test("backfillUsageEventsFromWakeLog：已有回填行按 wake_log.llmCalls 重算 calls", () => {
  const s = new Store(":memory:");
  const ts = Date.UTC(2026, 0, 5, 2, 0);
  s.addUsageEvent({
    ts, source: "wake", cacheHit: 0, cacheMiss: 0, outTokens: 0,
    totalTokens: 100, costUsd: 0.01, calls: 1,
  });
  // JSON.ts 是 ISO 字符串：修正逻辑必须用 Date.parse，不能拿 Number 直接转
  s.addWakeLog({ ts: new Date(ts).toISOString(), llmCalls: 5, rawTokens: 100, cost: 0.01 });

  assert.equal(s.backfillUsageEventsFromWakeLog(), 0);
  const rows = s.listUsageEvents(0, Number.MAX_SAFE_INTEGER);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].calls, 5);
  assert.equal(s.repairBackfilledUsageCalls(), 0);
});
