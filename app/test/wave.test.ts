import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/db.ts";
import type { InboundMessage } from "../src/types.ts";
import { level, nextHit, pulseK, waveCfg, waveGate } from "../src/core/wave.ts";

const MIN = 60_000;
const NOW = 1_700_000_000_000;

let n = 0;
const msg = (o: Partial<InboundMessage>): InboundMessage => ({
  platform: "feishu", external_chat_id: "oc_1", pool_kind: "private", msg_id: `w${++n}`,
  sender_id: "ou_a", sender_name: "A", ts: NOW, text: "hi", reply_to: null, mentions: [],
  is_mention_me: false, media_type: "text", ...o,
});

test("脉冲形状：延迟期为 0，峰在 peakMin 且峰高 1，六小时后归零", () => {
  const cfg = waveCfg();
  for (const m of [0, 10, 20, 29.9]) assert.equal(pulseK(m * 60, cfg), 0, `${m} 分钟该是 0`);
  assert.equal(pulseK(45 * 60, cfg), 1);
  assert.ok(pulseK(6 * 3600, cfg) < 1e-4);
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
  assert.equal(firstOne, 34);
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
  assert.equal(v.a, 0);
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
