import test from "node:test";
import assert from "node:assert/strict";
import {
  band, settle, interval, cool, replay, verdict, ENERGY_DEFAULTS as D,
} from "../src/core/energy.ts";

const near = (a: number, b: number, tol = 0.02) =>
  assert.ok(Math.abs(a - b) <= tol, `期望 ${b}±${tol}，实际 ${a}`);

test("分档：1 分钟满分，24 小时以上算 0", () => {
  assert.equal(band(0.5), 1.0);
  assert.equal(band(1), 1.0);
  assert.equal(band(5), 0.85);
  assert.equal(band(10), 0.7);
  assert.equal(band(120), 0.2);
  assert.equal(band(1440), 0.03);
  assert.equal(band(1441), 0);      // 超过一天不算回复
  assert.equal(band(Infinity), 0);
});

test("隔夜结算：全秒回 → 满电；全不回 → 地板", () => {
  assert.equal(settle([]), 1);                       // 没发过消息，给保底
  assert.equal(settle([1, 1, 1, 1, 1, 1, 1, 1]), 8); // 8 个秒回区间
  assert.equal(settle([3000, 3000]), 1);             // 超 24h 算没回
  assert.equal(settle([1]), 3);                      // 只有一条，样本少要打折
  assert.equal(settle([30, 30, 30, 30]), 4);         // 半小时回 ×4
});

test("I(E)：E 高→几分钟，E 低→几小时，她说完没被回等三倍", () => {
  assert.ok(interval(8, false) <= 10, "E=8 应该几分钟就能接话");
  assert.ok(interval(1, false) > 200, "E=1 应该是几小时");
  near(interval(8, true), interval(8, false) * 3, 0.01);
  // 单调：E 越高间隔越短
  for (let e = 1; e < 8; e++) assert.ok(interval(e, false) > interval(e + 1, false));
});

test("冷却：只算活跃时段，睡觉不掉电", () => {
  // 9:00 → 17:00 整 8 小时活跃，半衰 8h → 掉一半（相对地板）
  near(cool(5, 540, 540 + 480), 1 + (5 - 1) * 0.5);
  // 凌晨 2:00 → 7:00 不在活跃时段，电量不动
  assert.equal(cool(5, 120, 420), 5);
});

test("冷却：跌破地板会恢复，不会永久卡住", () => {
  // 回答扣到 0.9，一小时后应该回到接近 1（恢复半衰 1h）
  const after = cool(0.9, 540, 600);
  assert.ok(after > 0.94 && after <= 1, `1 小时后应回到 0.94 以上，实际 ${after}`);
  // 恢复不能超过地板
  assert.ok(cool(0.5, 540, 540 + 600) <= 1.0001);
});

test("重放：红→蓝给充能，蓝→红不给", () => {
  const t0 = 540 * 60e3;
  // 她发 → 他 2 分钟后回：应该 +0.85
  const r1 = replay(1, [
    { ts: t0, fromSelf: true },
    { ts: t0 + 2 * 60e3, fromSelf: false },
  ], t0 - 60e3, t0 + 10 * 60e3);
  near(r1.gained, 0.85, 0.01);
  assert.equal(r1.replies.length, 1);

  // 他发 → 她回：只扣回答成本，不充能
  const r2 = replay(5, [
    { ts: t0, fromSelf: false },
    { ts: t0 + 60e3, fromSelf: true },
  ], t0 - 60e3, t0 + 10 * 60e3);
  assert.equal(r2.gained, 0);
  near(r2.spent, D.costAnswer, 0.01);
});

test("重放：连发几条只扣一次开口成本", () => {
  const t0 = 540 * 60e3;
  const r = replay(5, [
    { ts: t0, fromSelf: true },
    { ts: t0 + 4e3, fromSelf: true },
    { ts: t0 + 8e3, fromSelf: true },
    { ts: t0 + 12e3, fromSelf: true },
  ], t0 - 60e3, t0 + 60e3);
  near(r.spent, D.costInit, 0.01);   // 四句一口气说完 = 一次打扰
});

test("重放：连发几条只算一次开口，也只配一个区间", () => {
  const t0 = 540 * 60e3;
  const r = replay(5, [
    { ts: t0, fromSelf: true },
    { ts: t0 + 4e3, fromSelf: true },
    { ts: t0 + 8e3, fromSelf: true },
    { ts: t0 + 30 * 60e3, fromSelf: false },
  ], t0 - 60e3, t0 + 60 * 60e3);
  // 第一条算主动（-1），后面两条紧跟着算回答以外的重复发送：仍按主动之外处理
  assert.equal(r.replies.length, 1, "三条红只该形成一个红蓝区间");
  near(r.gained, 0.45, 0.01);   // 30 分钟档
});

test("重放：连着说很多句也扣不到地板以下（每天保底一次）", () => {
  const t0 = 540 * 60e3;
  const msgs: { ts: number; fromSelf: boolean }[] = [];
  // 12 轮主动开口，中间对方没接
  for (let i = 0; i < 12; i++) msgs.push({ ts: t0 + i * 30 * 60e3, fromSelf: true });
  const r = replay(8, msgs, t0 - 60e3, t0 + 12 * 30 * 60e3, D);
  assert.ok(r.E >= D.floor, `E 不该跌破地板，实际 ${r.E}`);
});

test("判定：没电就别说，刚聊完也别说", () => {
  const now = 600 * 60e3;
  // 电低于地板
  const noPower = verdict(0.5, now - 5 * 3600e3, false, now);
  assert.equal(noPower.ok, false);
  assert.match(noPower.detail, /低于地板|说完了/);

  // 刚聊完（12 分钟前，E=5 需要 76 分钟左右）
  const justTalked = verdict(5, now - 12 * 60e3, false, now);
  assert.equal(justTalked.ok, false);
  assert.match(justTalked.detail, /刚聊过/);

  // 她说完没人回：等三倍
  const noReply = verdict(5, now - 30 * 60e3, true, now);
  assert.equal(noReply.ok, false);
  assert.match(noReply.detail, /还没人回/);

  // 够久了就放行
  const ok = verdict(5, now - 5 * 3600e3, false, now);
  assert.equal(ok.ok, true);
});

test("重放：冷却不能重复算（分段推进和一次推进结果一致）", () => {
  const t0 = 540 * 60e3;
  const msgs = [
    { ts: t0 + 10 * 60e3, fromSelf: true },
    { ts: t0 + 12 * 60e3, fromSelf: false },
    { ts: t0 + 200 * 60e3, fromSelf: true },
    { ts: t0 + 205 * 60e3, fromSelf: false },
  ];
  const end = t0 + 400 * 60e3;
  const oneShot = replay(6, msgs, t0, end, D);

  // 拆成 4 段，每段都带上「上次结算到的时刻」继续推进
  let E = 6, cursor = t0;
  for (const cut of [t0 + 15 * 60e3, t0 + 100 * 60e3, t0 + 210 * 60e3, end]) {
    const slice = msgs.filter((m) => m.ts > cursor && m.ts <= cut);
    E = replay(E, slice, cursor, cut, D).E;
    cursor = cut;
  }
  assert.ok(Math.abs(E - oneShot.E) < 0.05,
    `分段 ${E.toFixed(2)} 应≈ 一次 ${oneShot.E.toFixed(2)}（冷却被重复计算会差很多）`);
});

test("重放：跨 tick 时她说的第一句是回答，不是起话头", () => {
  // 线上事故：每个 tick 只 replay 最近三分钟，prev 永远是 null，
  // 于是窗口里她说的第一条一律被当成「主动开口」扣 1.0 而不是 0.1。
  // 一天 70 个 tick，白扣几十点，E 直接躺在地板上，她就再也不主动了。
  const t0 = 540 * 60e3, D2 = { ...D };
  const him = { ts: t0 + 60e3, fromSelf: false };
  const her = { ts: t0 + 120e3, fromSelf: true };

  const oneShot = replay(5, [him, her], t0, t0 + 300e3, D2);

  // 同一个消息流切成两个 tick
  const tick1 = replay(5, [him], t0, t0 + 90e3, D2);
  const tick2 = replay(tick1.E, [her], t0 + 90e3, t0 + 300e3, D2, him);

  assert.ok(Math.abs(oneShot.spent - (tick1.spent + tick2.spent)) < 1e-9,
    `跨 tick 消耗 ${(tick1.spent + tick2.spent).toFixed(2)} 应等于一次跑完 ${oneShot.spent.toFixed(2)}`);
  assert.ok(Math.abs(oneShot.E - tick2.E) < 0.05,
    `跨 tick 终值 ${tick2.E.toFixed(2)} 应≈ 一次跑完 ${oneShot.E.toFixed(2)}`);
});

test("重放：三分钟没有消息，电量不该掉 75%", () => {
  // 曾经 replay 把 epoch 分钟当「当天分钟」传给 cool，activeSpan 永远返回满格，
  // 每个 tick 固定掉 75%。这条守住：一个 tick 的冷却就是三分钟的量。
  const t = new Date(2026, 9, 30, 16, 0, 0).getTime();   // 本地 16:00
  const r = replay(7, [], t, t + 3 * 60e3, D);
  // 三分钟 / 半衰 8 小时 → 相对地板衰减不到 0.5%
  assert.ok(r.E > 6.9, `三分钟只该掉一点点，实际 ${r.E.toFixed(2)}`);
});

test("判定：没有任何消息时也放行（新池第一天）", () => {
  const v = verdict(2, null, false, 600 * 60e3);
  assert.equal(v.ok, true);
});
