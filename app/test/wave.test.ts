import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/db.ts";
import type { InboundMessage } from "../src/types.ts";
import { level, nextHit, pulseK, waveCfg, waveGate, waveSchedule } from "../src/core/wave.ts";

const MIN = 60_000;
const NOW = 1_700_000_000_000;

let n = 0;
const msg = (o: Partial<InboundMessage>): InboundMessage => ({
  platform: "feishu", external_chat_id: "oc_1", pool_kind: "private", msg_id: `w${++n}`,
  sender_id: "ou_a", sender_name: "A", ts: NOW, text: "hi", reply_to: null, mentions: [],
  is_mention_me: false, media_type: "text", ...o,
});

test("脉冲形状：延迟期为 0，峰在 peakMin 且峰高 1，六小时后只剩残量", () => {
  const cfg = waveCfg();
  for (const m of [0, 10, 20, 29.9]) assert.equal(pulseK(m * 60, cfg), 0, `${m} 分钟该是 0`);
  assert.equal(pulseK(45 * 60, cfg), 1);
  assert.ok(pulseK(6 * 3600, cfg) < 0.15, "幂律尾不归零，但六小时后只剩峰值的 1/8 上下");
  assert.ok(pulseK(60 * 60, cfg) > pulseK(6 * 3600, cfg) * 5, "衰减要单调");
});

test("峰位必须大于不打扰期，否则直接报错", () => {
  assert.throws(() => pulseK(10, waveCfg({ delayMin: 60, peakMin: 30 })));
});

test("默认定标：单条孤立消息永远过不了阈值", () => {
  const cfg = waveCfg();
  const pulses = [{ ts: NOW, fromSelf: false }];
  let peak = 0;
  for (let m = 0; m <= 200; m++) peak = Math.max(peak, level(pulses, NOW + m * MIN, cfg).a);
  assert.equal(peak, 0.4);
  for (const m of [34, 45, 60, 70]) assert.equal(level(pulses, NOW + m * MIN, cfg).a >= cfg.thr, false);
});

test("默认定标：两条相隔 10 分钟才开口，且比单条更晚", () => {
  const cfg = waveCfg();
  const one = [{ ts: NOW, fromSelf: false }];
  const two = [{ ts: NOW, fromSelf: false }, { ts: NOW + 10 * MIN, fromSelf: false }];
  // 单条：把 wUser 抬到 1.0 才能看到窗口（34~70 分钟），证明形状没变
  const wide = waveCfg({ wUser: 1 });
  const firstOne = [...Array(200).keys()].find((m) => level(one, NOW + m * MIN, wide).a >= wide.thr);
  assert.ok(firstOne! >= 30 && firstOne! <= 45, `单条首过阈该在 30~45 分钟，实际 ${firstOne}`);
  const firstTwo = [...Array(200).keys()].find((m) => level(two, NOW + m * MIN, wide).a >= wide.thr);
  assert.ok(firstTwo! > firstOne!, `叠加该推后起爆点：单条 ${firstOne}，两条 ${firstTwo}`);
  // 默认权重下两条才过阈值
  assert.ok(level(two, NOW + 45 * MIN, cfg).a >= cfg.thr);
});

test("不打扰期的锚点是最后一条发言（任何一方），不是每条脉冲各自算", () => {
  const cfg = waveCfg({ wUser: 1 });
  const pulses = [{ ts: NOW, fromSelf: false }, { ts: NOW + 10 * MIN, fromSelf: false }];
  assert.equal(level(pulses, NOW + 39 * MIN, cfg).a, 0, "最后一条才过 29 分钟，水位必须是 0");
  assert.ok(level(pulses, NOW + 41 * MIN, cfg).a > 0);
});

test("间隔越散，起爆越晚", () => {
  const cfg = waveCfg();
  const first = (gapMin: number) =>
    [...Array(240).keys()].find((m) =>
      level([{ ts: NOW, fromSelf: false }, { ts: NOW + gapMin * MIN, fromSelf: false }], NOW + m * MIN, cfg).a >= cfg.thr)!;
  assert.ok(first(1) < first(10));
  assert.ok(first(10) < first(20));
});

test("自己说的话权重更小，但也算", () => {
  const cfg = waveCfg({ wUser: 1 });
  const mine = level([{ ts: NOW, fromSelf: true }], NOW + 45 * MIN, cfg);
  assert.ok(mine.a > 0 && mine.a < 1);
});

test("未来时间戳不参与：补录的消息不能把整条场压成 0", () => {
  const cfg = waveCfg({ wUser: 1 });
  const lv = level([{ ts: NOW, fromSelf: false }, { ts: NOW + 3 * 86400_000, fromSelf: false }], NOW + 45 * MIN, cfg);
  assert.equal(lv.nUser, 1);
  assert.equal(lv.a, 1);
});

test("horizon 之外的脉冲不参与", () => {
  const cfg = waveCfg({ wUser: 1, horizonH: 24 });
  const lv = level([{ ts: NOW - 30 * 3600_000, fromSelf: false }, { ts: NOW, fromSelf: false }], NOW + 45 * MIN, cfg);
  assert.equal(lv.nUser, 1);
});

test("nextHit 给出下一次达阈时刻，过峰后返回 null", () => {
  const cfg = waveCfg({ wUser: 1 });
  const pulses = [{ ts: NOW, fromSelf: false }];
  const t = nextHit(pulses, NOW, cfg, 300, 12)!;
  assert.ok(t !== null && level(pulses, t, cfg).a >= cfg.thr);
  assert.ok(level(pulses, t - 300_000, cfg).a < cfg.thr);
  assert.equal(nextHit(pulses, NOW + 2 * 3600_000, cfg, 300, 12), null);
});

// ---------- 与库接线 ----------

test("waveGate：池里没消息 → 不拦（从没聊过，谈不上「刚聊完」）", () => {
  const s = new Store(":memory:");
  const v = waveGate(s, "nope", NOW, {})!;
  assert.equal(v.ok, true);
  assert.equal(v.a, 0);
});

test("waveGate：冷场放行，否则普通关心永远发不出去", () => {
  const s = new Store(":memory:");
  const pool = s.insertMessage(msg({ ts: NOW }))!.pool_id;
  // 最后一条在 4 小时前：水位早就落回 0，但这不是「别打扰」，是「冷场了该开口」
  const v = waveGate(s, pool, NOW + 240 * MIN, {})!;
  assert.ok(v.a < 0.1, `幂律尾剩一点残量，但早就该低于阈值：${v.a}`);
  assert.equal(v.ok, true);
  // 边界内（3 小时内）仍然拦
  assert.equal(waveGate(s, pool, NOW + 170 * MIN, {})!.ok, false);
});

test("waveGate：一条消息不够（默认 wUser < thr），两条够了", () => {
  const s = new Store(":memory:");
  const pool = s.insertMessage(msg({ ts: NOW }))!.pool_id;
  const one = waveGate(s, pool, NOW + 45 * MIN, {})!;
  assert.equal(one.ok, false);
  assert.equal(one.a, 0.4);
  s.insertMessage(msg({ ts: NOW + 10 * MIN }));
  // 两条相隔 10 分钟：+42 分钟附近过阈值，之后又掉下去
  assert.equal(waveGate(s, pool, NOW + 40 * MIN, {})!.ok, false, "第二条还在不打扰期里，叠加不够");
  assert.equal(waveGate(s, pool, NOW + 45 * MIN, {})!.ok, true, "峰值附近两条叠加够了");
  assert.equal(waveGate(s, pool, NOW + 90 * MIN, {})!.ok, false, "时间越久水位越低");
});

test("waveGate：泄流点是上次真发，之后的消息才重新蓄水", () => {
  const s = new Store(":memory:");
  const pool = s.insertMessage(msg({ ts: NOW }))!.pool_id;
  s.insertMessage(msg({ ts: NOW + 10 * MIN }));
  const okAt = [...Array(240).keys()].map((m) => NOW + m * MIN).find((t) => waveGate(s, pool, t, {})!.ok)!;
  assert.ok(okAt > NOW, "两条叠加后确实能到阈值");
  // 记一次真发 = 泄流
  s.recordTideEvent({ pool_id: pool, day: "2026-10-26", ts: okAt, kind: "fired", anchor_kind: "L2" });
  assert.equal(waveGate(s, pool, okAt + MIN, {})!.ok, false, "泄流之后水位归零");
  assert.equal(waveGate(s, pool, okAt + MIN, {})!.a, 0);
});

test("waveGate：enabled=false 返回 null（完全不参与判定）", () => {
  const s = new Store(":memory:");
  const pool = s.insertMessage(msg({ ts: NOW }))!.pool_id;
  assert.equal(waveGate(s, pool, NOW + 60 * MIN, { enabled: false }), null);
});

test("waveGate：跨池（poolId=null）看所有池的消息", () => {
  const s = new Store(":memory:");
  s.insertMessage(msg({ external_chat_id: "oc_a", ts: NOW }));
  s.insertMessage(msg({ external_chat_id: "oc_b", ts: NOW + 10 * MIN }));
  const v = waveGate(s, null, NOW + 45 * MIN, {})!;
  assert.equal(v.nUser, 2);
});

// ---------- 候选时刻表（一个会话之后的「想起你」序列） ----------

const fast = () => waveCfg({ delayMin: 8, peakMin: 15, wUser: 0.5, wSelf: 0.3 });

test("时刻表：首档在十几分钟内，之后间隔递增", () => {
  const cfg = fast();
  const pulses = [{ ts: NOW, fromSelf: false }, { ts: NOW + 3 * MIN, fromSelf: false }];
  const pts = waveSchedule(pulses, NOW + 3 * MIN, cfg, { ratio: 0.5, maxStages: 4 });
  const mins = pts.map((p) => Math.round((p.at - (NOW + 3 * MIN)) / MIN));
  assert.ok(mins.length >= 3, `该有多个候选点，实际 ${mins.join(",")}`);
  assert.ok(mins[0] <= 20, `首档该在 20 分钟内，实际 ${mins[0]}`);
  const gaps = mins.slice(1).map((m, i) => m - mins[i]);
  for (let i = 1; i < gaps.length; i++) assert.ok(gaps[i] > gaps[i - 1], `间隔该递增：${gaps.join(",")}`);
});

test("时刻表：单条消息水不够，一个点都没有", () => {
  const cfg = waveCfg({ delayMin: 8, peakMin: 15 });   // 默认 wUser=0.4 < thr
  assert.equal(waveSchedule([{ ts: NOW, fromSelf: false }], NOW, cfg).length, 0);
});

test("时刻表：聊得越多，序列越长", () => {
  const cfg = fast();
  const few = waveSchedule([{ ts: NOW, fromSelf: false }, { ts: NOW + 2 * MIN, fromSelf: false }], NOW + 2 * MIN, cfg);
  const many = Array.from({ length: 20 }, (_, i) => ({ ts: NOW + i * MIN, fromSelf: false }));
  const lots = waveSchedule(many, NOW + 19 * MIN, cfg);
  assert.ok(lots.length >= few.length, `多的该不短于少的：${lots.length} vs ${few.length}`);
});

// ---------- 退潮档位（tick 用） ----------

const candCfg = () => ({ delayMin: 10, peakMin: 20, thr: 0.5, wUser: 0.4, wSelf: 0.25, ratio: 0.5, maxStages: 3 });
import { waveCandidate } from "../src/core/wave.ts";

test("退潮档位：三条消息攒够水，首档给机会", () => {
  const s = new Store(":memory:");
  const pool = s.insertMessage(msg({ ts: NOW }))!.pool_id;
  s.insertMessage(msg({ ts: NOW + 3 * MIN }));
  s.insertMessage(msg({ ts: NOW + 6 * MIN }));
  const c = waveCandidate(s, pool, NOW + 20 * MIN, candCfg())!;
  assert.equal(c.ok, true);
  assert.equal(c.stage, 0);
});

test("退潮档位：不打扰期内不给机会", () => {
  const s = new Store(":memory:");
  const pool = s.insertMessage(msg({ ts: NOW }))!.pool_id;
  s.insertMessage(msg({ ts: NOW + 3 * MIN }));
  const c = waveCandidate(s, pool, NOW + 5 * MIN, candCfg())!;
  assert.equal(c.ok, false);
  assert.match(c.detail, /不打扰期/);
});

test("退潮档位：同一档只给一次，退到下一档才有第二次", () => {
  const s = new Store(":memory:");
  const pool = s.insertMessage(msg({ ts: NOW }))!.pool_id;
  s.insertMessage(msg({ ts: NOW + 3 * MIN }));
  s.insertMessage(msg({ ts: NOW + 6 * MIN }));
  const now = NOW + 20 * MIN;
  const c = waveCandidate(s, pool, now, candCfg())!;
  assert.equal(c.ok, true);
  // 真开口了 → 记这一档
  s.recordTideEvent({ pool_id: pool, day: "2026-10-26", ts: now, kind: "wave", anchor_kind: "L2", stage: c.stage, wave_a: c.a });
  assert.equal(waveCandidate(s, pool, now + 1 * MIN, candCfg())!.ok, false, "同一档不能连着给");
  // 水位再退一半 → 下一档
  const later = now + 60 * MIN;
  const c2 = waveCandidate(s, pool, later, candCfg())!;
  assert.ok(c2.stage > c.stage, `该退到更后面的档：${c2.stage} vs ${c.stage}`);
});

test("退潮档位：单个会话水位不够就永远没机会", () => {
  const s = new Store(":memory:");
  const pool = s.insertMessage(msg({ ts: NOW }))!.pool_id;
  const c = waveCandidate(s, pool, NOW + 30 * MIN, candCfg())!;
  assert.equal(c.ok, false);
  assert.equal(c.peak, 0.4);
});

test("退潮档位：连着几档都选择不说，只要有人再说话，档位就重置（10-28 全天静默的回归）", () => {
  const s = new Store(":memory:");
  const pool = s.insertMessage(msg({ ts: NOW }))!.pool_id;
  s.insertMessage(msg({ ts: NOW + 3 * MIN }));
  s.insertMessage(msg({ ts: NOW + 6 * MIN }));

  // 走完一轮退潮：每一档都给过机会，但每次都记「问过」，她选择不说
  let t = NOW + 20 * MIN;
  const asked: number[] = [];
  for (let i = 0; i < 30; i++) {
    const c = waveCandidate(s, pool, t, candCfg())!;
    if (c.ok) {
      asked.push(c.stage);
      s.recordTideEvent({ pool_id: pool, day: "2026-10-26", ts: t, kind: "wave", anchor_kind: "L2", stage: c.stage, wave_a: c.a, reason: "没发" });
    }
    t += 10 * MIN;
  }
  assert.ok(asked.length >= 2, `该问过好几档，实际：${asked.join(",")}`);

  // 档位用完之后：没人说话就安静着（这是对的，硬叫也是硬凑）
  assert.equal(waveCandidate(s, pool, t, candCfg())!.ok, false);

  // 但只要有人再说一句，沉默就是新的一段，档位从头算
  s.insertMessage(msg({ ts: t + 1 * MIN }));
  const after = waveCandidate(s, pool, t + 40 * MIN, candCfg())!;
  assert.equal(after.ok, true, `有新消息该重新给机会，实际：${after.detail}`);
});

// ---------- 夜间静默 ----------

import { inQuietHours } from "../src/core/wave.ts";

test("夜间静默：凌晨不叫，白天放行，边界不含结束时刻", () => {
  const cfg = waveCfg({ quietStart: "00:30", quietEnd: "08:00" });
  assert.equal(inQuietHours(Date.parse("2026-10-27T17:00:00Z"), cfg), true, "北京 01:00 该静默");
  assert.equal(inQuietHours(Date.parse("2026-10-27T00:00:00Z"), cfg), false, "北京 08:00 该放行");
  assert.equal(inQuietHours(Date.parse("2026-10-27T02:00:00Z"), cfg), false, "北京 10:00 该放行");
  assert.equal(inQuietHours(Date.parse("2026-10-26T16:20:00Z"), cfg), false, "北京 00:20 还没到静默");
});

test("夜间静默：跨零点的段（23:30→08:00）两头都算", () => {
  const cfg = waveCfg({ quietStart: "23:30", quietEnd: "08:00" });
  assert.equal(inQuietHours(Date.parse("2026-10-27T15:45:00Z"), cfg), true, "北京 23:45");
  assert.equal(inQuietHours(Date.parse("2026-10-27T01:00:00Z"), cfg), false, "北京 09:00 该放行");
  assert.equal(inQuietHours(Date.parse("2026-10-27T14:00:00Z"), cfg), false, "北京 22:00 放行");
});
