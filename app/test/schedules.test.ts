/** 日程：cron/delay 校验、到点推进、取消。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/db.ts";
import { appendScheduleEvent, createSchedule, ensureSchedulePool, fireSchedule, nextCronAt } from "../src/core/schedules.ts";
import { fmtLocal, parseIsoInTz } from "../src/core/time.ts";

const TZ = "Asia/Shanghai";
const NOW = parseIsoInTz("2026-11-11T08:00:00", TZ)!;

function setup() {
  return new Store(":memory:");
}

test("cron：每天 9:00 的下一次触发是当天 9:00", () => {
  const next = nextCronAt("0 9 * * *", NOW, TZ);
  assert.equal(fmtLocal(next, TZ), "2026-11-11 09:00:00");
});

test("cron：过了 9:00 就排到明天", () => {
  const at = parseIsoInTz("2026-11-11T10:00:00", TZ)!;
  assert.equal(fmtLocal(nextCronAt("0 9 * * *", at, TZ), TZ), "2026-11-12 09:00:00");
});

test("cron：拒绝 30 秒级表达式（最小间隔 1 分钟）", () => {
  assert.throws(() => nextCronAt("*/30 * * * * *", NOW, TZ), /不能低于 1 分钟/);
  assert.equal(fmtLocal(nextCronAt("* * * * *", NOW, TZ), TZ), "2026-11-11 08:01:00");
});

test("delay：创建后 N 分钟触发，只触发一次", () => {
  const store = setup();
  const s = createSchedule(store, { content: "提醒他交报告", delay_minutes: 30 }, NOW, TZ);
  assert.equal(s.kind, "delay");
  assert.equal(s.next_at, NOW + 30 * 60_000);
  assert.equal(store.dueSchedules(NOW).length, 0);
  assert.equal(store.dueSchedules(s.next_at).length, 1);

  const fired = fireSchedule(store, s, s.next_at, TZ)!;
  assert.equal(fired.status, "done");
  assert.equal(fired.last_fired_at, s.next_at);
  assert.equal(store.dueSchedules(s.next_at + 1).length, 0);
});

test("cron：触发后推进到下一天，不重复触发同一档", () => {
  const store = setup();
  const s = createSchedule(store, { content: "每天九点提醒", cron: "0 9 * * *" }, NOW, TZ);
  const at = s.next_at;
  const fired = fireSchedule(store, s, at, TZ)!;
  assert.equal(fired.status, "active");
  assert.equal(fmtLocal(fired.next_at, TZ), "2026-11-12 09:00:00");
  assert.equal(store.dueSchedules(at).length, 0);
  assert.equal(store.dueSchedules(fired.next_at).length, 1);
});

test("每周一 9:00 的重复日程", () => {
  // 2026-11-11 是周三，下一次周一是 11-16
  const next = nextCronAt("0 9 * * 1", NOW, TZ);
  assert.equal(fmtLocal(next, TZ), "2026-11-16 09:00:00");
});

test("取消后不再到点", () => {
  const store = setup();
  const s = createSchedule(store, { content: "提醒", delay_minutes: 1 }, NOW, TZ);
  const cancelled = store.setScheduleStatus(s.id, "cancelled", NOW)!;
  assert.equal(cancelled.status, "cancelled");
  assert.equal(store.dueSchedules(s.next_at).length, 0);
});

test("参数校验：缺 content / 非法 delay / 缺 cron", () => {
  const store = setup();
  assert.throws(() => createSchedule(store, { delay_minutes: 5 }, NOW, TZ), /content/);
  assert.throws(() => createSchedule(store, { content: "x", delay_minutes: 0 }, NOW, TZ), /正整数/);
  assert.throws(() => createSchedule(store, { content: "x", kind: "cron" }, NOW, TZ), /cron/);
});

test("到点事件写进共用日程池，池常驻且 tick 正常可见", () => {
  const store = setup();
  const s = createSchedule(store, { content: "提醒他交周报", delay_minutes: 5 }, NOW, TZ);
  const poolId = ensureSchedulePool(store);
  assert.equal(poolId, "schedule:schedule");

  appendScheduleEvent(store, s, s.next_at);
  appendScheduleEvent(store, s, s.next_at + 1000);
  const msgs = store.unread(poolId);
  assert.equal(msgs.length, 2);
  assert.match(msgs[0].text, /提醒他交周报/);
  assert.equal(store.getPool(poolId)?.kind, "schedule");
  assert.equal(store.getPool(poolId)?.archived, false);
  assert.ok(store.poolsWithUnread().includes(poolId), "tick 应能看到日程池");
});
