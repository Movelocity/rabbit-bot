// 简化模型 v2：sigmoid 二级机制
// 跑法：npx tsx scripts/sim-simple.ts
//
// 核心：只有一个状态量 E，一个函数 I(E) 决定「多久可以再开口」。
//   I(E) = 240·(1-s) + 3·s        s = sigmoid((E-4.5)/0.9)
//     E=8 → 约 7 分钟（热态，几分钟就能插一句）
//     E=4.5 → 120 分钟（中态）
//     E=1 → 约 237 分钟（冷态，大半天才开口一次）
//
// 两条补充规则（缺一就会刷屏或哑火）：
//   1. 最后一句是她说的 → 只说了半句没人接，等 3×I，不追问
//   2. 及时回复要全额返还（GAIN=1.0），否则热态撑不住「几分钟说一句」

const BANDS: [number, number][] = [
  [1, 1.0], [5, 0.85], [10, 0.7], [20, 0.55], [30, 0.45],
  [60, 0.3], [120, 0.2], [720, 0.1], [1440, 0.03],
];
const CAP = 8, FLOOR = 1, HALF_H = 8, REST_H = 1;
const COST_INIT = 1.0, COST_ANSWER = 0.1, GAIN = 1.0;
const DAY_START = 8 * 60, DAY_END = 24 * 60, TICK = 1;

const band = (m: number) => (m > 1440 ? 0 : (BANDS.find(([t]) => m <= t)?.[1] ?? 0));
const sig = (x: number) => 1 / (1 + Math.exp(-x));

/** 多久之后可以再开口（分钟） */
function interval(E: number, lastWasHers: boolean): number {
  const MID = 3.8;
  const s = sig((E - MID) / 0.9);
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
function makeGauss(rnd: () => number) {
  return () => { const u = rnd() || 1e-9, v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
}

/** 一天由若干「对话段」组成：一段里他隔 rounds 分钟说一句，段与段之间隔很远。
 *  热聊 = 几段密集对话（一段 20~30 轮）；正常 = 一两段短聊；冷淡 = 偶尔一句。 */
type Params = { bursts: number; rounds: number; roundGap: number; replyMed: number; sigma: number };
type Day = { userTimes: number[]; delays: number[] };

function genDay(rnd: () => number, g: () => number, p: Params): Day {
  const span = DAY_END - DAY_START;
  const userTimes: number[] = [];
  for (let b = 0; b < p.bursts; b++) {
    const start = DAY_START + span * ((b + 0.5) / p.bursts) - (p.rounds * p.roundGap) / 2;
    for (let i = 0; i < p.rounds; i++) userTimes.push(start + i * p.roundGap + g() * 0.5);
  }
  userTimes.sort((a, b) => a - b);
  const delays = Array.from({ length: 200 }, () => p.replyMed * Math.exp(p.sigma * g()));
  return { userTimes, delays };
}

function runDay(d: Day, E0: number, rnd: () => number) {
  let E = E0, lastTalk = DAY_START, lastWasHers = false, di = 0;
  let inits = 0;
  const gaps: number[] = [];
  let prevSay = -1e9;
  let prevT = DAY_START;   // 上次已经结算到的时刻：冷却只能算增量，否则每个 tick 重复扣一次

  for (let t = DAY_START; t < DAY_END; t += TICK) {
    E = cool(E, prevT, t);
    prevT = t;

    // 他说话 → 她答（-0.1）→ 他有一定概率再答一句（红→蓝，这才是充能路径）
    while (di < d.userTimes.length && d.userTimes[di] <= t) {
      const ut = d.userTimes[di++];
      E = Math.max(0, E - COST_ANSWER);
      lastTalk = ut;
      lastWasHers = true;
      if (rnd() < 0.7) {
        const dl = d.delays[di % d.delays.length];
        const at = Math.min(ut + dl, DAY_END - 1);
        E = cool(E, prevT, at);
        prevT = at;
        E += Math.min(GAIN * band(dl), CAP - E);
        lastTalk = at;
        lastWasHers = false;
      }
    }

    if (E < COST_INIT) continue;
    if (t - lastTalk < interval(E, lastWasHers)) continue;

    // 她说
    inits++;
    E -= COST_INIT;
    if (prevSay > 0) gaps.push(t - prevSay);
    prevSay = t;
    lastTalk = t;
    lastWasHers = true;

    // 他回复（按预设延迟）
    const delay = d.delays[di++ % d.delays.length];
    const at = Math.min(t + delay, DAY_END - 1);
    E = cool(E, prevT, at);
    prevT = at;
    E += Math.min(GAIN * band(delay), CAP - E);
    lastTalk = at;
    lastWasHers = false;
  }
  return { inits, gaps, E };
}

function trial(label: string, p: Params, days = 30, base = 4) {
  const rnd = makeRnd(20261029), g = makeGauss(rnd);
  const inits: number[] = [], gaps: number[] = [], eTrace: number[] = [];
  let E = base;
  for (let i = 0; i < days; i++) {
    const r = runDay(genDay(rnd, g, p), E, rnd);
    inits.push(r.inits);
    gaps.push(...r.gaps);
    eTrace.push(r.E);
    E = Math.max(1, Math.min(8, Math.round(r.E)));
  }
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  const s = [...gaps].sort((x, y) => x - y);
  console.log(`\n=== ${label} ===`);
  console.log(`  ${p.bursts} 段 × 每段 ${p.rounds} 轮（${p.roundGap} 分钟一轮）｜回复中位 ${p.replyMed} 分钟`);
  console.log(`  主动/天 均值 ${mean(inits).toFixed(2)}｜最低 ${Math.min(...inits)}｜最高 ${Math.max(...inits)}`);
  console.log(`  主动间隔 中位 ${s[Math.floor(s.length / 2)] ?? "-"} 分钟｜最短 ${s[0] ?? "-"}｜p90 ${s[Math.floor(s.length * 0.9)] ?? "-"}`);
  console.log(`  日终 E 轨迹 ${eTrace.slice(0, 10).map((x) => x.toFixed(1)).join(" ")}`);
}

// 热聊：一天 3 段，每段 30 轮、3 分钟一轮 → 一段聊 90 分钟
trial("热聊（3 段 × 30 轮 × 3 分钟，他 1 分钟回）",
  { bursts: 3, rounds: 30, roundGap: 3, replyMed: 1, sigma: 0.4 });
// 正常：一天 3 段，每段 8 轮、5 分钟一轮
trial("正常（3 段 × 8 轮 × 5 分钟，他 10 分钟回）",
  { bursts: 3, rounds: 8, roundGap: 5, replyMed: 10, sigma: 0.9 });
// 冷淡：一天 1 段 3 轮，他 2 小时才回
trial("冷淡（1 段 × 3 轮，他 2 小时回）",
  { bursts: 1, rounds: 3, roundGap: 30, replyMed: 120, sigma: 1.0 });
// 不回：一天 1 段 2 轮，他 12 小时才回
trial("不回（1 段 × 2 轮，他 12 小时回）",
  { bursts: 1, rounds: 2, roundGap: 60, replyMed: 720, sigma: 0.8 });

console.log("\n=== I(E) 曲线 ===");
for (const e of [1, 2, 3, 4, 5, 6, 7, 8]) {
  console.log(`  E=${e}  接话 ${interval(e, false).toFixed(0)} 分钟｜她说完没被回 ${interval(e, true).toFixed(0)} 分钟`);
}
