import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/db.ts";
import { computeIdle, idleNow, loadIdle, saveIdle, ensureIdle } from "../src/core/idle.ts";
import { canFire } from "../src/core/tide.ts";

const TZ = "Asia/Shanghai";
const H = 3600_000;

/** 本地零点：按 Asia/Shanghai 的日历日算，否则 +11h 不等于 11 点 */
function localMidnight(ts: number): number {
  const d = new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ts));
  return new Date(`${d}T00:00:00+08:00`).getTime();
}

/** 往库里塞一条消息（idle 只用到 ts / from_self / seq） */
let n = 0;
function mkMsg(store: Store, ts: number, self: boolean) {
  store.insertMessage({
    platform: "mock", msg_id: `m${++n}`, external_chat_id: "chat1", pool_kind: "private",
    sender_id: self ? "me" : "u1", sender_name: self ? "克劳德" : "主人", ts, text: "x",
    reply_to: null, mentions: [], is_mention_me: false, media_type: "text", from_self: self,
  } as any);
}

function mkPlan(store: Store, over: Record<string, unknown> = {}) {
  return store.insertPlan({
    title: "t", content: "", pool_id: "p1", schedule_kind: "none", schedule: null, expires_at: null,
    anchor_kind: "L2", ...over,
  } as any);
}

test("样本不足：置信度 low，idleNow 一律 0.5，不拦也不放大", () => {
  const store = new Store(":memory:");
  const now = Date.now();
  mkMsg(store, now - 2 * H, false);
  const m = computeIdle(store, now, TZ);
  assert.equal(m.confidence, "low");
  assert.ok(m.samples < 80);
  // 让「当前活跃」不生效：拿 2 小时前的时间点判断
  assert.equal(idleNow(m, store, now - 1 * H, TZ), 0.5);
});

test("当前 30 分钟内有互动 → 直接给 1.0（不需要样本）", () => {
  const store = new Store(":memory:");
  const now = Date.now();
  const m = computeIdle(store, now, TZ);
  mkMsg(store, now - 5 * 60_000, false);
  assert.equal(idleNow(m, store, now, TZ), 1);
});

test("足够样本时：回得快的时段分数高，回得慢的时段分数低", () => {
  const store = new Store(":memory:");
  const now = Date.now();
  // 造 8 天数据：10 点秒回（她发完 30s 内他就回），16 点拖 40 分钟
  for (let d = 8; d >= 1; d--) {
    const dayStart = localMidnight(now) - d * 24 * H;
    for (const [hour, delay] of [[10, 30_000], [16, 40 * 60_000]]) {
      const base = dayStart + hour * H;
      mkMsg(store, base, true);
      mkMsg(store, base + delay, false);
    }
  }
  const m = computeIdle(store, now, TZ, { minSamples: 10 });
  assert.equal(m.confidence, "mid", "8 天 / 16 条该够门槛");
  const fast = m.buckets[10].score;
  const slow = m.buckets[16].score;
  assert.ok(fast > slow, `10 点该比 16 点活跃：${fast} vs ${slow}`);
  assert.ok(fast > 0.8, `秒回的时段该接近 1，实际 ${fast}`);
  assert.ok(slow < 0.4, `拖 40 分钟的时段该低，实际 ${slow}`);
});

test("阈值按人归一化：整体都回得慢的人，相对快的时段依然得高分", () => {
  const store = new Store(":memory:");
  const now = Date.now();
  for (let d = 8; d >= 1; d--) {
    const dayStart = localMidnight(now) - d * 24 * H;
    // 这个人天生慢：快的时候也要 10 分钟，慢的时候 3 小时
    for (const [hour, delay] of [[9, 10 * 60_000], [15, 180 * 60_000]]) {
      const base = dayStart + hour * H;
      mkMsg(store, base, true);
      mkMsg(store, base + delay, false);
    }
  }
  const m = computeIdle(store, now, TZ, { minSamples: 10 });
  assert.ok(m.buckets[9].score > m.buckets[15].score, "10 分钟的时段该比 3 小时的活跃");
  assert.ok(m.buckets[9].score > 0.7, `归一化后 10 分钟也该算快，实际 ${m.buckets[9].score}`);
});

test("已读不回会拉低活跃度", () => {
  const store = new Store(":memory:");
  const now = Date.now();
  for (let d = 8; d >= 1; d--) {
    const dayStart = localMidnight(now) - d * 24 * H;
    // 11 点：她发了他马上回
    mkMsg(store, dayStart + 11 * H, true);
    mkMsg(store, dayStart + 11 * H + 60_000, false);
    // 20 点：她发了，他从没回（不回 = 不活跃的证据）
    mkMsg(store, dayStart + 20 * H, true);
  }
  const m = computeIdle(store, now, TZ, { minSamples: 10 });
  const answered = m.buckets[11];
  const ignored = m.buckets[20];
  assert.equal(answered.unansweredRate, 0);
  assert.ok(ignored.unansweredRate === null || ignored.unansweredRate > 0.5);
});

test("模型跨天就失效：拿昨天的模型判断今天的时段退回 0.5", () => {
  const store = new Store(":memory:");
  const now = Date.now();
  const m = computeIdle(store, now, TZ);
  const stale = { ...m, day: "2020-01-01", confidence: "mid" as const };
  assert.equal(idleNow(stale, store, now, TZ), 0.5);
});

test("ensureIdle：同一天只算一次，读回来是同一份", () => {
  const store = new Store(":memory:");
  const now = Date.now();
  const a = ensureIdle(store, now, TZ);
  const b = ensureIdle(store, now + 1000, TZ);
  assert.equal(a.computedAt, b.computedAt, "同一天不该重算");
  assert.ok(loadIdle(store));
  saveIdle(store, { ...a, samples: 999 });
  assert.equal(loadIdle(store)!.samples, 999);
});

test("闸门：忙的时候 L2 被拦，L1 照发", () => {
  const store = new Store(":memory:");
  const now = Date.now();
  const cfg = { enabled: true, dailyCap: { L1: 2, L2: 1 }, busyThreshold: 0.3, activeThreshold: 0.6 };
  const l2 = mkPlan(store, { anchor_kind: "L2" });
  const l1 = mkPlan(store, { anchor_kind: "L1", title: "跟进" });
  const busy = canFire(store, l2, cfg, now, TZ, { idleNow: 0.1 });
  assert.equal(busy.ok, false);
  assert.equal((busy as any).reason, "busy");
  assert.equal(canFire(store, l1, cfg, now, TZ, { idleNow: 0.1 }).ok, true, "跟进到期比闲聊重要，不拦");
});

test("闸门：高活跃时 L2 额度翻倍（1 → 2）", () => {
  const store = new Store(":memory:");
  const now = Date.now();
  const cfg = { enabled: true, dailyCap: { L1: 2, L2: 1 }, busyThreshold: 0.3, activeThreshold: 0.6 };
  const l2 = mkPlan(store, { anchor_kind: "L2" });
  const { localDay } = { localDay: (ts: number) => new Intl.DateTimeFormat("sv-SE", { timeZone: TZ }).format(new Date(ts)) };
  const day = localDay(now);
  store.recordTideEvent({ day, pool_id: "p1", ts: now, kind: "fired", anchor_kind: "L2" });
  // 中性：已经 1 条，到顶
  assert.equal(canFire(store, l2, cfg, now, TZ, { idleNow: 0.5 }).ok, false);
  // 高活跃：额度翻成 2，还能再发一条
  assert.equal(canFire(store, l2, cfg, now, TZ, { idleNow: 0.8 }).ok, true);
});

test("闸门：没有 idle 数据时按原样走（不因为算不出来就不发）", () => {
  const store = new Store(":memory:");
  const now = Date.now();
  const cfg = { enabled: true, dailyCap: { L1: 2, L2: 1 } };
  const l2 = mkPlan(store, { anchor_kind: "L2" });
  assert.equal(canFire(store, l2, cfg, now, TZ).ok, true);
});
