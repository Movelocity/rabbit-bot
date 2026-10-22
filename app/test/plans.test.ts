import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/db.ts";
import { PlanEngine, cronOccurrences, validateSchedule } from "../src/core/plans.ts";
import { parseIsoInTz, fmtLocal } from "../src/core/time.ts";

const T = (s: string) => Date.parse(s);
const NOW = T("2026-10-22T03:00:00Z"); // = 上海 11:00

test("ISO 无时区按 Asia/Shanghai 解释；带时区按其时区", () => {
  assert.equal(parseIsoInTz("2026-10-23T09:00"), T("2026-10-23T01:00:00Z"));
  assert.equal(parseIsoInTz("2026-10-23 09:00:30"), T("2026-10-23T01:00:30Z"));
  assert.equal(parseIsoInTz("2026-10-23T09:00+09:00"), T("2026-10-23T00:00:00Z"));
  assert.equal(parseIsoInTz("2026-10-23T09:00Z"), T("2026-10-23T09:00:00Z"));
  assert.equal(parseIsoInTz("2026-02-30T09:00"), null);
  assert.equal(parseIsoInTz("明天九点"), null);
  assert.equal(fmtLocal(T("2026-10-23T01:00:00Z")), "2026-10-23 09:00:00");
});

test("validateSchedule：格式与过去时间校验", () => {
  assert.equal(validateSchedule({ kind: "once", value: "2026-10-22T12:00" }, NOW).ok, true);
  assert.equal(validateSchedule({ kind: "once", value: "2026-10-22T10:00" }, NOW).ok, false);
  assert.equal(validateSchedule({ kind: "once", value: "garbage" }, NOW).ok, false);
  const c = validateSchedule({ kind: "cron", value: "0 9 * * *" }, NOW);
  assert.ok(c.ok && c.firstFire === T("2026-10-23T01:00:00Z"), "cron 按上海时区：明早 9 点");
  assert.equal(validateSchedule({ kind: "cron", value: "0 9 *" }, NOW).ok, false);
  assert.equal(validateSchedule({ kind: "cron", value: "99 9 * * *" }, NOW).ok, false);
  assert.equal(validateSchedule({ kind: "none" }, NOW).ok, true);
});

test("cronOccurrences 按上海时区", () => {
  const occ = cronOccurrences("30 10 * * *", T("2026-10-20T00:00:00Z"), T("2026-10-22T03:00:00Z"));
  assert.deepEqual(occ.map((t) => fmtLocal(t)), ["2026-10-20 10:30:00", "2026-10-21 10:30:00", "2026-10-22 10:30:00"]);
});

function engine(policy: "catchup" | "skip", startedAt: number, lastCheck: number) {
  const store = new Store(":memory:");
  store.setKv("plans.lastCheck", String(lastCheck));
  const e = new PlanEngine(store, { missedPolicy: policy, missedGraceMs: 86_400_000, tz: "Asia/Shanghai" }, startedAt);
  return { store, e };
}

test("一次性计划：到点触发一次并标记完成", () => {
  const { store, e } = engine("catchup", NOW - 3600_000, NOW - 60_000);
  const p = store.insertPlan({ title: "a", content: "", pool_id: null, schedule_kind: "once", schedule: new Date(NOW + 60_000).toISOString(), expires_at: null });
  assert.deepEqual(e.due(NOW), []);
  assert.deepEqual(e.due(NOW + 61_000), [{ planId: p.id, fireTs: NOW + 60_000 }]);
  assert.equal(store.getPlan(p.id)!.status, "done");
  assert.deepEqual(e.due(NOW + 120_000), []);
});

test("cron：同一时间点只触发一次；一个窗口多个点只触发最近一次", () => {
  const { store, e } = engine("catchup", NOW - 86_400_000, NOW);
  // created_at 是真实 now，这里手动改成更早
  const p = store.insertPlan({ title: "每分钟", content: "", pool_id: null, schedule_kind: "cron", schedule: "* * * * *", expires_at: null });
  store.db.prepare("UPDATE plans SET created_at=? WHERE id=?").run(NOW - 3600_000, p.id);
  const f1 = e.due(NOW + 180_000);
  assert.equal(f1.length, 1);
  assert.equal(f1[0].fireTs, NOW + 180_000);
  assert.deepEqual(e.due(NOW + 180_000), []);
  store.setKv("plans.lastCheck", String(NOW)); // 模拟重复检查同一窗口
  assert.deepEqual(e.due(NOW + 180_000), [], "同一时间点不重复触发");
});

test("停机错过：catchup 补发一次，skip 跳过", () => {
  const start = NOW + 500; // 进程在整点后启动；lastCheck 是 2 小时前（停机）
  for (const policy of ["catchup", "skip"] as const) {
    const { store, e } = engine(policy, start, NOW - 7200_000);
    const p = store.insertPlan({ title: "x", content: "", pool_id: null, schedule_kind: "cron", schedule: "0 * * * *", expires_at: null });
    store.db.prepare("UPDATE plans SET created_at=? WHERE id=?").run(NOW - 86_400_000, p.id);
    const f = e.due(NOW + 1000);
    if (policy === "catchup") assert.equal(f.length, 1);
    else assert.equal(f.length, 0);
    assert.deepEqual(e.due(NOW + 2000), []);
  }
});

test("过期计划自动 expired，不触发", () => {
  const { store, e } = engine("catchup", NOW - 1000, NOW - 1000);
  const p = store.insertPlan({ title: "x", content: "", pool_id: null, schedule_kind: "cron", schedule: "* * * * *", expires_at: NOW - 1 });
  assert.deepEqual(e.due(NOW + 60_000), []);
  assert.equal(store.getPlan(p.id)!.status, "expired");
});

test("取消的计划不触发", () => {
  const { store, e } = engine("catchup", NOW - 1000, NOW - 1000);
  const p = store.insertPlan({ title: "x", content: "", pool_id: null, schedule_kind: "once", schedule: new Date(NOW).toISOString(), expires_at: null });
  store.setPlanStatus(p.id, "cancelled");
  assert.deepEqual(e.due(NOW + 1), []);
});
