import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/db.ts";
import { computeIdle } from "../src/core/idle.ts";

/**
 * 只测统计本身。
 * 2026-10-26 起这个模型不再参与闸门决策（从来触发过 0 次拦截），
 * 只留 `npm run idle` 用来看分布，所以这里去掉 canFire 相关的用例。
 */
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

test("样本不够就直接标 low", () => {
  const store = new Store(":memory:");
  const now = Date.now();
  mkMsg(store, now - 2 * H, false);
  const m = computeIdle(store, now, TZ);
  assert.equal(m.confidence, "low");
  assert.ok(m.samples < 80);
});

test("足够样本时：回得快的时段分数高，回得慢的时段分数低", () => {
  const store = new Store(":memory:");
  const now = Date.now();
  // 造 8 天数据：10 点秒回，16 点拖 40 分钟
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
    // 20 点：她发了，他从没回
    mkMsg(store, dayStart + 20 * H, true);
  }
  const m = computeIdle(store, now, TZ, { minSamples: 10 });
  assert.equal(m.buckets[11].unansweredRate, 0);
  assert.ok(m.buckets[20].unansweredRate === null || m.buckets[20].unansweredRate > 0.5);
});
