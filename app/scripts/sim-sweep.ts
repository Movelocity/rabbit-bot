// 参数扫描：sigmoid 的中点 × 尺度，看哪一组最接近实验目标
// 跑法：npx tsx scripts/sim-sweep.ts
//
// 目标（先定死，再扫参数，不然就是拿结果凑目标）：
//   热聊   间隔中位 5~15 分钟、主动 25~45 次/天
//   正常   主动 3~5 次/天
//   冷淡   主动 1~2 次/天
//   不回   主动 1~1.5 次/天
//   稳定性 同一配置换 5 个种子，主动次数的标准差不超过均值的 25%

const BANDS: [number, number][] = [
  [1, 1.0], [5, 0.85], [10, 0.7], [20, 0.55], [30, 0.45],
  [60, 0.3], [120, 0.2], [720, 0.1], [1440, 0.03],
];
const CAP = 8, FLOOR = 1, HALF_H = 8, REST_H = 1;
const COST_INIT = 1.0, COST_ANSWER = 0.1, GAIN = 1.0;
const DAY_START = 8 * 60, DAY_END = 24 * 60, TICK = 1;

const band = (m: number) => (m > 1440 ? 0 : (BANDS.find(([t]) => m <= t)?.[1] ?? 0));
const sig = (x: number) => 1 / (1 + Math.exp(-x));

let MID = 3.8, SCALE = 0.9;
function interval(E: number, lastWasHers: boolean): number {
  const s = sig((E - MID) / SCALE);
  const base = 240 * (1 - s) + 3 * s;
  return lastWasHers ? base * 3 : base;
}

function activeMin(t0: number, t1: number): number {
  let total = 0;
  for (let d = 0; d <= Math.max(t1, 1440) + 1440; d += 1440) {
    const s = Math.max(t0, d + DAY_START), e = Math.min(t1, d + DAY_END);
    if (e > s) total += e - s;
  }
  return total;
}
function cool(E: number, t0: number, t1: number): number {
  const m = activeMin(t0, t1);
  if (m <= 0) return E;
  const k = Math.pow(0.5, m / (HALF_H * 60));
  if (E > FLOOR) return FLOOR + (E - FLOOR) * k;
  const back = E + (FLOOR - E) * (1 - Math.pow(0.5, m / (REST_H * 60)));
  return FLOOR - back < 1e-3 ? FLOOR : back;
}

function makeRnd(s0: number) {
  let seed = s0;
  return () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed + 1) / 0x80000000; };
}
const gaussFrom = (rnd: () => number) => () => {
  const u = rnd() || 1e-9, v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

type Params = { bursts: number; rounds: number; roundGap: number; replyMed: number; sigma: number };

function runDay(p: Params, E0: number, rnd: () => number, g: () => number) {
  const span = DAY_END - DAY_START;
  const userTimes: number[] = [];
  for (let b = 0; b < p.bursts; b++) {
    const start = DAY_START + span * ((b + 0.5) / p.bursts) - (p.rounds * p.roundGap) / 2;
    for (let i = 0; i < p.rounds; i++) userTimes.push(start + i * p.roundGap + g() * 0.5);
  }
  userTimes.sort((a, b) => a - b);
  const delays = Array.from({ length: 200 }, () => p.replyMed * Math.exp(p.sigma * g()));

  let E = E0, lastTalk = DAY_START, lastWasHers = false, di = 0, prevT = DAY_START;
  let inits = 0;
  const gaps: number[] = [];
  let prevSay = -1e9;

  for (let t = DAY_START; t < DAY_END; t += TICK) {
    E = cool(E, prevT, t); prevT = t;
    while (di < userTimes.length && userTimes[di] <= t) {
      const ut = userTimes[di++];
      E = Math.max(0, E - COST_ANSWER);
      lastTalk = ut; lastWasHers = true;
      if (rnd() < 0.7) {
        const dl = delays[di % delays.length];
        const at = Math.min(ut + dl, DAY_END - 1);
        E = cool(E, prevT, at); prevT = at;
        E += Math.min(GAIN * band(dl), CAP - E);
        lastTalk = at; lastWasHers = false;
      }
    }
    if (E < COST_INIT) continue;
    if (t - lastTalk < interval(E, lastWasHers)) continue;
    inits++;
    E -= COST_INIT;
    if (prevSay > 0) gaps.push(t - prevSay);
    prevSay = t; lastTalk = t; lastWasHers = true;
    const delay = delays[di++ % delays.length];
    const at = Math.min(t + delay, DAY_END - 1);
    E = cool(E, prevT, at); prevT = at;
    E += Math.min(GAIN * band(delay), CAP - E);
    lastTalk = at; lastWasHers = false;
  }
  return { inits, gaps };
}

type Stat = { inits: number[]; gaps: number[] };
function sample(p: Params, seeds = 5, days = 30): Stat {
  const inits: number[] = [], gaps: number[] = [];
  for (let s = 0; s < seeds; s++) {
    const rnd = makeRnd(1000 + s * 7919), g = gaussFrom(rnd);
    let E = 4;
    for (let d = 0; d < days; d++) {
      const r = runDay(p, E, rnd, g);
      inits.push(r.inits); gaps.push(...r.gaps);
      E = Math.max(1, Math.min(8, Math.round(r.inits > 0 ? Math.min(8, E + 0.1) : E)));
    }
  }
  return { inits, gaps };
}

const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const median = (a: number[]) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : 0; };
const sd = (a: number[]) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };

const SCENES: [string, Params][] = [
  ["热聊", { bursts: 3, rounds: 30, roundGap: 3, replyMed: 1, sigma: 0.4 }],
  ["正常", { bursts: 3, rounds: 8, roundGap: 5, replyMed: 10, sigma: 0.9 }],
  ["冷淡", { bursts: 1, rounds: 3, roundGap: 30, replyMed: 120, sigma: 1.0 }],
  ["不回", { bursts: 1, rounds: 2, roundGap: 60, replyMed: 720, sigma: 0.8 }],
];

function score(hot: number, hotGap: number, normal: number, cold: number, dead: number, cv: number) {
  let s = 0;
  // 热聊：主动次数落在 25~45 且间隔中位落在 5~15 分钟
  if (hot < 25) s += (25 - hot);
  if (hot > 45) s += (hot - 45) * 0.5;
  if (hotGap < 5) s += (5 - hotGap) * 2;
  if (hotGap > 15) s += (hotGap - 15) * 1.5;
  // 正常 3~5
  if (normal < 3) s += (3 - normal) * 3;
  if (normal > 5) s += (normal - 5) * 3;
  // 冷淡 1~2
  if (cold < 1) s += (1 - cold) * 3;
  if (cold > 2) s += (cold - 2) * 3;
  // 不回 1~1.5
  if (dead < 1) s += (1 - dead) * 3;
  if (dead > 1.5) s += (dead - 1.5) * 3;
  // 稳定性
  if (cv > 0.25) s += (cv - 0.25) * 10;
  return s;
}

console.log("目标：热聊 25~45次/间隔 5~15min｜正常 3~5次｜冷淡 1~2次｜不回 1~1.5次｜CV<25%\n");
console.log("mid  scale │ 热聊/day 热聊间隔 │ 正常/day │ 冷淡/day │ 不回/day │ CV   │ 偏离");
console.log("───────────┼──────────────────┼──────────┼──────────┼──────────┼──────┼─────");

let best = { s: Infinity, mid: 0, scale: 0 };
for (const mid of [2.6, 3.0, 3.4, 3.8, 4.2, 4.6]) {
  for (const scale of [0.5, 0.7, 0.9, 1.2]) {
    MID = mid; SCALE = scale;
    const res = SCENES.map(([, p]) => sample(p));
    const hot = mean(res[0].inits), hotGap = median(res[0].gaps);
    const normal = mean(res[1].inits), cold = mean(res[2].inits), dead = mean(res[3].inits);
    const cv = sd(res[1].inits) / (mean(res[1].inits) || 1);
    const s = score(hot, hotGap, normal, cold, dead, cv);
    if (s < best.s) best = { s, mid, scale };
    const flag = s < 1 ? "  ★" : s < 3 ? "  ·" : "";
    console.log(
      `${String(mid).padEnd(4)} ${String(scale).padEnd(5)} │ ` +
      `${hot.toFixed(1).padStart(6)} ${hotGap.toFixed(0).padStart(6)}min │ ` +
      `${normal.toFixed(2).padStart(7)}  │ ${cold.toFixed(2).padStart(7)}  │ ${dead.toFixed(2).padStart(7)}  │ ` +
      `${(cv * 100).toFixed(0).padStart(3)}% │ ${s.toFixed(1).padStart(5)}${flag}`
    );
  }
}
console.log(`\n最佳：mid=${best.mid} scale=${best.scale}（偏离 ${best.s.toFixed(2)}）`);
