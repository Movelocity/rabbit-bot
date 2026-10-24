import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/db.ts";
import { PlanEngine } from "../src/core/plans.ts";
import { canFire, localDay, anchorOf, type TideConfig } from "../src/core/tide.ts";

const CFG: TideConfig = { enabled: true, dailyCap: { L1: 2, L2: 1 } };
const TZ = "Asia/Shanghai";

function mkPlan(store: Store, over: Record<string, unknown> = {}) {
  return store.insertPlan({
    title: "测试计划", content: "", pool_id: null, schedule_kind: "none", schedule: null, expires_at: null,
    anchor_kind: "L2", why: "测试", ...over,
  } as any);
}

function fire(store: Store, day: string, kind: string, pool: string | null = null) {
  store.recordTideEvent({ day, pool_id: pool, ts: Date.now(), kind: "fired", anchor_kind: kind });
}

test("锚点档位：没填按 L2 算（不能靠不填绕过）", () => {
  assert.equal(anchorOf({ anchor_kind: null }), "L2");
  assert.equal(anchorOf({ anchor_kind: undefined }), "L2");
  assert.equal(anchorOf({ anchor_kind: "l0" }), "L0");
  assert.equal(anchorOf({ anchor_kind: "L1" }), "L1");
  assert.equal(anchorOf({ anchor_kind: "乱写" }), "L2");
});

test("L0 不占额度：一天发五次也全部放行", () => {
  const store = new Store(":memory:");
  const now = Date.now();
  const day = localDay(now, TZ);
  const p = mkPlan(store, { anchor_kind: "L0" });
  for (let i = 0; i < 5; i++) {
    assert.equal(canFire(store, p, CFG, now, TZ).ok, true, `第 ${i + 1} 次该放行`);
    fire(store, day, "L0");
  }
});

test("L2 每天 1 条：第 2 条被拦，reason=cap", () => {
  const store = new Store(":memory:");
  const now = Date.now();
  const day = localDay(now, TZ);
  const p = mkPlan(store, { anchor_kind: "L2" });
  assert.equal(canFire(store, p, CFG, now, TZ).ok, true);
  fire(store, day, "L2");
  const v = canFire(store, p, CFG, now, TZ);
  assert.equal(v.ok, false);
  assert.equal((v as any).reason, "cap");
  assert.match((v as any).detail, /上限 1/);
});

test("L1 每天 2 条：第 3 条被拦", () => {
  const store = new Store(":memory:");
  const now = Date.now();
  const day = localDay(now, TZ);
  const p = mkPlan(store, { anchor_kind: "L1" });
  fire(store, day, "L1");
  assert.equal(canFire(store, p, CFG, now, TZ).ok, true);
  fire(store, day, "L1");
  assert.equal(canFire(store, p, CFG, now, TZ).ok, false);
});

test("额度按池分开：A 池发满不影响 B 池", () => {
  const store = new Store(":memory:");
  const now = Date.now();
  const day = localDay(now, TZ);
  const a = mkPlan(store, { anchor_kind: "L2", pool_id: "p1" });
  const b = mkPlan(store, { anchor_kind: "L2", pool_id: "p2" });
  fire(store, day, "L2", "p1");
  assert.equal(canFire(store, a, CFG, now, TZ).ok, false, "p1 已满");
  assert.equal(canFire(store, b, CFG, now, TZ).ok, true, "p2 还没发过");
});

test("额度按天重置：昨天发满不影响今天", () => {
  const store = new Store(":memory:");
  const now = Date.now();
  const yesterday = localDay(now - 24 * 3600_000, TZ);
  const p = mkPlan(store, { anchor_kind: "L2" });
  fire(store, yesterday, "L2");
  assert.equal(canFire(store, p, CFG, now, TZ).ok, true);
});

test("tide.enabled=false 时闸门全开", () => {
  const store = new Store(":memory:");
  const now = Date.now();
  const p = mkPlan(store, { anchor_kind: "L2" });
  fire(store, localDay(now, TZ), "L2");
  assert.equal(canFire(store, p, { ...CFG, enabled: false }, now, TZ).ok, true);
});

test("due()：计划到点但额度用满 → 不触发，记 skip，once 计划标 expired", () => {
  const store = new Store(":memory:");
  const T = Date.now();
  const day = localDay(T + 2000, TZ);
  fire(store, day, "L2"); // 占掉今天唯一一条 L2
  const engine = new PlanEngine(store, { missedPolicy: "skip", missedGraceMs: 0, tz: TZ, tide: CFG }, T);
  const p = mkPlan(store, { schedule_kind: "once", schedule: new Date(T + 1000).toISOString(), anchor_kind: "L2" });

  const fires = engine.due(T + 2000);
  assert.equal(fires.length, 0, "被闸门拦下不该产生唤醒");
  assert.equal(store.getPlan(p.id)!.status, "expired", "没执行成，不是 done");
  const ev = store.recentTideEvents(1)[0];
  assert.equal(ev.kind, "skip");
  assert.equal(ev.anchor_kind, "L2");
  assert.match(ev.reason, /上限/);
});

test("due()：额度还有 → 正常触发并记 fired", () => {
  const store = new Store(":memory:");
  const T = Date.now();
  const engine = new PlanEngine(store, { missedPolicy: "skip", missedGraceMs: 0, tz: TZ, tide: CFG }, T);
  const p = mkPlan(store, { schedule_kind: "once", schedule: new Date(T + 1000).toISOString(), anchor_kind: "L1" });

  const fires = engine.due(T + 2000);
  assert.equal(fires.length, 1);
  assert.equal(fires[0].planId, p.id);
  assert.equal(store.getPlan(p.id)!.status, "done");
  const ev = store.recentTideEvents(1)[0];
  assert.equal(ev.kind, "fired");
  assert.equal(ev.anchor_kind, "L1");
  assert.equal(ev.why, "测试");
});

test("due()：L0 计划即使当天发满也照常触发", () => {
  const store = new Store(":memory:");
  const T = Date.now();
  const day = localDay(T + 2000, TZ);
  fire(store, day, "L2");
  fire(store, day, "L1");
  fire(store, day, "L1");
  const engine = new PlanEngine(store, { missedPolicy: "skip", missedGraceMs: 0, tz: TZ, tide: CFG }, T);
  const p = mkPlan(store, { schedule_kind: "once", schedule: new Date(T + 1000).toISOString(), anchor_kind: "L0", title: "生日" });

  const fires = engine.due(T + 2000);
  assert.equal(fires.length, 1, "生日不该被任何额度挡住");
  assert.equal(store.getPlan(p.id)!.status, "done");
});

test("lastTideFired：能给唤醒剧本提供「上次主动是几时、为什么」", () => {
  const store = new Store(":memory:");
  assert.equal(store.lastTideFired("p1"), null);
  store.recordTideEvent({ day: "2026-10-24", pool_id: "p1", ts: 1000, kind: "fired", anchor_kind: "L2", why: "问他面试结果" });
  store.recordTideEvent({ day: "2026-10-24", pool_id: "p1", ts: 2000, kind: "skip", anchor_kind: "L2", reason: "cap" });
  const last = store.lastTideFired("p1")!;
  assert.equal(last.ts, 1000, "只数 fired，skip 不算");
  assert.equal(last.why, "问他面试结果");
});
