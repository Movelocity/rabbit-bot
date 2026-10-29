// 对比实验：旧的潮汐水位 vs 简化版（E + 间隔）
// 跑法：npx tsx scripts/sim-compare.ts
//
// 同一份用户行为输入，喂给两套模型，比三件事：
//   1. 每天主动几次
//   2. 主动间隔（最短会被拉到多近 = 骚扰风险）
//   3. 冷场多久之后才开口（响应性）
// 旧模型直接 import 真实的 wave.ts，不是重写，保证比较的是线上那套。

import { level, WAVE_DEFAULTS, type Pulse } from "../src/core/wave.js";

const cfg = { ...WAVE_DEFAULTS };
const DAY_START = 8 * 60, DAY_END = 24 * 60;
const TICK = 3; // 分钟

// ---------- 确定性随机 ----------
function makeRnd(s0: number) {
  let seed = s0;
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed + 1) / 0x80000000;
  };
}
function makeGauss(rnd: () => number) {
  return () => {
    const u = rnd() || 1e-9, v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}

type Day = { userTimes: number[]; delays: number[] };

/** 生成一天的用户行为：他主动找她几次 + 每次回复延迟 */
function genDay(rnd: () => number, gauss: () => number, chats: number, replyMed: number, sigma: number): Day {
  const userTimes: number[] = [];
  const span = DAY_END - DAY_START;
  for (let i = 0; i < chats; i++) userTimes.push(DAY_START + span * ((i + 0.5) / chats) + gauss() * 10);
  userTimes.sort((a, b) => a - b);
  const delays = Array.from({ length: 40 }, () => replyMed * Math.exp(sigma * gauss()));
  return { userTimes, delays };
}

// ---------- 旧模型：潮汐水位 + 档位 ----------
function runOld(days: Day[], base: number) {
  const out = { inits: [] as number[], gaps: [] as number[], blocked: 0, quiet: 0, firstAfterSilence: [] as number[] };
  for (const d of days) {
    const pulses: Pulse[] = [];
    const used = new Set<number>();
    let initsToday = 0, lastSay = -1e9, lastTalk = DAY_START;
    let di = 0;

    for (const ut of d.userTimes) pulses.push({ ts: ut * 60e3, fromSelf: false } as Pulse);

    for (let t = DAY_START; t < DAY_END; t += TICK) {
      const nowMs = t * 60e3;
      const lv = level(pulses, nowMs, cfg, 0);
      if (lv.a < cfg.thr) continue;
      if (initsToday >= cfg.maxWakesPerDay) continue;
      // 同一档不重复问：用「水位分桶」近似线上的 usedWaveStages
      const bucket = Math.floor(lv.a * 4);
      if (used.has(bucket)) continue;
      used.add(bucket);
      initsToday++;
      pulses.push({ ts: nowMs, fromSelf: true } as Pulse);
      if (lastSay > 0) out.gaps.push(t - lastSay);
      else { const sil = t - lastTalk; if (sil > 60) out.firstAfterSilence.push(sil); }
      lastSay = t;
      lastTalk = t;

      // 他回复
      const delay = d.delays[di++ % d.delays.length];
      const at = Math.min(t + delay, DAY_END - 1);
      pulses.push({ ts: at * 60e3, fromSelf: false } as Pulse);
      lastTalk = at;
    }
    out.inits.push(initsToday);
  }
  return out;
}

// ---------- 简化模型：E + I(E) ----------
const CAP = 8, FLOOR = 1, HALF_H = 8, COST_INIT = 1, GAIN = 0.5;
const REST_H = 1;  // 跌破地板后的恢复半衰期：回答扣掉的电，一小时后回来大半
const BANDS: [number, number][] = [[1, 1], [5, .85], [10, .7], [20, .55], [30, .45], [60, .3], [120, .2], [720, .1], [1440, .03]];
const band = (m: number) => (m > 1440 ? 0 : (BANDS.find(([t]) => m <= t)?.[1] ?? 0));

/** 想要说话的间隔：E 越高越想说话。线性，别用双曲——E=1 时会拉到 6 小时，比用户的
 *  说话间隔还长，等于永远等不到（这是推演里实际踩到的坑）。 */
const interval = (E: number) => 20 + (CAP - Math.max(E, FLOOR)) * 15;

function runNew(days: Day[], base: number) {
  const out = { inits: [] as number[], gaps: [] as number[], blocked: 0, quiet: 0, firstAfterSilence: [] as number[] };
  let E = base;
  for (const d of days) {
    let initsToday = 0, lastSay = -1e9, lastTalk = DAY_START;
    let di = 0;
    const said: string[] = [];

    for (let t = DAY_START; t < DAY_END; t += TICK) {
      // 冷却（E 高于地板）与恢复（E 低于地板）走两条曲线。
      // 少了恢复这一半，回答扣 0.1 会让 E 永久卡在 0.9 < 1，一次主动都发不出。
      const dt = Math.min(t, DAY_END) - Math.min(Math.max(lastTalk, DAY_START), DAY_END);
      if (dt > 0) {
        if (E > FLOOR) E = FLOOR + (E - FLOOR) * Math.pow(0.5, dt / (HALF_H * 60));
        else {
          const back = E + (FLOOR - E) * (1 - Math.pow(0.5, dt / (REST_H * 60)));
          E = FLOOR - back < 1e-3 ? FLOOR : back;
        }
      }

      // 用户主动说话 → 她回答（-0.1）
      while (di < d.userTimes.length && d.userTimes[di] <= t) {
        E = Math.max(0, E - 0.1);
        lastTalk = t;
        di++;
      }

      if (E < COST_INIT) continue;
      if (t - lastTalk <= interval(E)) continue;
      if (initsToday >= CAP) continue;

      initsToday++;
      E -= COST_INIT;
      if (said.length < 3 && lastSay < 0) said.push(`t=${t} E=${(E + 1).toFixed(1)} 距上次 ${((t - lastTalk) / 60).toFixed(1)}h > I=${(interval(E + 1) / 60).toFixed(1)}h`);
      if (lastSay > 0) out.gaps.push(t - lastSay);
      else { const sil = t - lastTalk; if (sil > 60) out.firstAfterSilence.push(sil); }
      lastSay = t;
      lastTalk = t;

      const delay = d.delays[di++ % d.delays.length];
      const at = Math.min(t + delay, DAY_END - 1);
      E += Math.min(GAIN * band(delay), CAP - E);
      lastTalk = at;
    }
    out.inits.push(initsToday);
  }
  return out;
}

// ---------- 跑 ----------
function stats(a: number[]) {
  if (!a.length) return { n: 0, mean: 0, med: 0, min: 0, max: 0 };
  const s = [...a].sort((x, y) => x - y);
  return {
    n: a.length,
    mean: a.reduce((x, y) => x + y, 0) / a.length,
    med: s[Math.floor(s.length / 2)],
    min: s[0],
    max: s[s.length - 1],
  };
}

function compare(label: string, chats: number, replyMed: number, sigma: number, base = 3, nDays = 30) {
  const rnd = makeRnd(20261029);
  const gauss = makeGauss(rnd);
  const days: Day[] = [];
  for (let i = 0; i < nDays; i++) days.push(genDay(rnd, gauss, chats, replyMed, sigma));

  const o = runOld(days, base);
  const n = runNew(days, base);
  const so = stats(o.inits), sn = stats(n.inits);
  const go = stats(o.gaps), gn = stats(n.gaps);
  const fo = stats(o.firstAfterSilence), fn = stats(n.firstAfterSilence);

  console.log(`\n=== ${label} ===`);
  console.log(`              主动/天        间隔(分钟)              冷场后首次开口(分钟)`);
  console.log(`  旧(潮汐)    ${so.mean.toFixed(2).padStart(5)}         中位 ${String(go.med).padStart(4)}  最短 ${String(go.min).padStart(4)}    中位 ${fo.med || "-"}`);
  console.log(`  新(简化)    ${sn.mean.toFixed(2).padStart(5)}         中位 ${String(gn.med).padStart(4)}  最短 ${String(gn.min).padStart(4)}    中位 ${fn.med || "-"}`);
}

compare("正常（他每天找 3 次，10 分钟回）", 3, 10, 0.9);
compare("热聊（他每天找 8 次，1 分钟回）", 8, 1, 0.4);
compare("冷淡（他每天找 1 次，2 小时回）", 1, 120, 1.0);
compare("不回（他每天找 0.5 次，12 小时回）", 1, 720, 0.8);

console.log("\n=== 决策理由能不能读懂（简化版前 3 次主动） ===");
const rnd2 = makeRnd(7);
const gauss2 = makeGauss(rnd2);
const d0 = [genDay(rnd2, gauss2, 3, 10, 0.9)];
const n0 = runNew(d0, 3);
console.log(`  一天主动 ${n0.inits[0]} 次。旧模型的理由长这样：「水位 1.22，档位 4/3，峰值 16.49」`);
