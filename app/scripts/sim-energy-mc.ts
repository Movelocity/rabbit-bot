// 蒙特卡洛推演：用户行为用正态/对数正态随机，看这套机制长期稳不稳。
// 跑法：npx tsx scripts/sim-energy-mc.ts
//
// 手工编排场景（sim-energy.ts）只能看「如果这样会怎样」，
// 这个脚本回答的是「参数真跑起来，会收敛到哪、会不会震荡」。
// 固定种子，同样的数跑两遍结果一致。

const BANDS: [number, number][] = [
  [1, 1.0], [5, 0.85], [10, 0.7], [20, 0.55], [30, 0.45],
  [60, 0.3], [120, 0.2], [720, 0.1], [1440, 0.03],
];
const COST_ANSWER = 0.1, COST_INIT = 1.0, GAIN = 0.5, FLOOR = 1.0, CAP = 8.0;
const HALF_H = 8, DAY_START = 8 * 60, DAY_END = 24 * 60;

function band(m: number): number {
  if (m > 1440) return 0;
  for (const [t, s] of BANDS) if (m <= t) return s;
  return 0;
}
function settle(replies: number[]): number {
  if (!replies.length) return 1;
  const p = replies.reduce((s, x) => s + band(x), 0) / replies.length;
  return Math.max(1, Math.min(8, Math.round(1 + 7 * p * Math.min(1, replies.length / 3))));
}
function activeMinutes(t0: number, t1: number): number {
  let total = 0;
  for (let day = 0; day <= Math.max(t1, 1440) + 1440; day += 1440) {
    const s = Math.max(t0, day + DAY_START), e = Math.min(t1, day + DAY_END);
    if (e > s) total += e - s;
  }
  return total;
}
function cool(E: number, t0: number, t1: number): number {
  const m = activeMinutes(t0, t1);
  if (E <= FLOOR || m <= 0) return E;
  return FLOOR + (E - FLOOR) * Math.pow(0.5, m / (HALF_H * 60));
}

// ---- 确定性随机 ----
let seed = 20261029;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return (seed + 1) / 0x80000000;
};
const gauss = () => {
  const u = rnd() || 1e-9, v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
/** 对数正态：中位数 m、σ 控制长尾（回复时间和间隔不可能为负，用它比正态合适） */
const lognorm = (median: number, sigma: number) => median * Math.exp(sigma * gauss());

type Params = {
  replyMedian: number;   // 主人在她开口后多久回（中位数，分钟）
  replySigma: number;    // 抖动量
  initMedian: number;    // 她两次主动之间的间隔（中位数，分钟）
  initSigma: number;
  userChatsPerDay: number; // 主人每天主动找她说几次
};

function simulateDay(E0: number, p: Params): { end: number; init: number; blocked: number; replies: number[] } {
  let E = E0, t = DAY_START, lastT = t;
  let init = 0, blocked = 0;
  const replies: number[] = [];

  const advance = (to: number) => { E = cool(E, lastT, to); lastT = to; };

  // 她自己找话头的时刻
  let next = t + lognorm(p.initMedian, p.initSigma);
  // 主人主动说话的时刻
  let userNext = t + (DAY_END - DAY_START) / Math.max(1, p.userChatsPerDay) * (0.5 + rnd());

  while (t < DAY_END) {
    const take = Math.min(next, userNext);
    if (take >= DAY_END) break;
    t = take;
    advance(t);

    if (t === userNext) {
      // 主人先说：蓝 → 她答（-0.1）→ 主人可能再接一句（红→蓝，充能）
      userNext = t + (DAY_END - DAY_START) / Math.max(1, p.userChatsPerDay) * (0.5 + rnd());
      if (rnd() < 0.85) {
        E = Math.max(0, E - COST_ANSWER);
        if (rnd() < 0.7) {
          const delay = lognorm(p.replyMedian, p.replySigma);
          const at = Math.min(t + delay, DAY_END);
          E = cool(E, lastT, at);
          lastT = at;
          E += Math.max(0, Math.min(GAIN * band(delay), CAP - E));
        }
      }
    } else {
      // 她主动开口：先看额度
      next = t + lognorm(p.initMedian, p.initSigma);
      if (E < COST_INIT) { blocked++; continue; }
      E -= COST_INIT;
      init++;
      const delay = lognorm(p.replyMedian, p.replySigma);
      const at = Math.min(t + delay, DAY_END);
      E = cool(E, lastT, at);
      lastT = at;
      const g = Math.max(0, Math.min(GAIN * band(delay), CAP - E));
      E += g;
      if (delay <= 1440) replies.push(delay);
    }
  }
  E = cool(E, lastT, DAY_END);
  return { end: E, init, blocked, replies };
}

function run(label: string, p: Params, days = 30, trials = 40) {
  const allInits: number[] = [], allBlocked: number[] = [], endEs: number[] = [], bases: number[] = [];
  let sampleTrace: number[] = [];
  for (let k = 0; k < trials; k++) {
    let E = 3;
    const trace: number[] = [];
    for (let d = 0; d < days; d++) {
      const r = simulateDay(E, p);
      allInits.push(r.init);
      allBlocked.push(r.blocked);
      endEs.push(r.end);
      E = settle(r.replies);
      bases.push(E);
      trace.push(r.init);
    }
    if (k === 0) sampleTrace = trace;
  }
  const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
  const median = (a: number[]) => { const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
  const hist: Record<number, number> = {};
  for (const v of allInits) hist[v] = (hist[v] || 0) + 1;
  const keys = Object.keys(hist).map(Number).sort((a, b) => a - b);

  console.log(`\n=== ${label} ===`);
  console.log(`  回复中位数 ${p.replyMedian} 分钟（σ=${p.replySigma}）｜主动间隔中位数 ${p.initMedian} 分钟（σ=${p.initSigma}）｜他每天主动找 ${p.userChatsPerDay} 次`);
  console.log(`  每天主动次数：均值 ${mean(allInits).toFixed(2)}｜中位 ${median(allInits)}｜最低 ${Math.min(...allInits)}｜最高 ${Math.max(...allInits)}`);
  console.log(`  被拦：均值 ${mean(allBlocked).toFixed(2)}/天｜隔夜基准 E：均值 ${mean(bases).toFixed(2)}｜日终 E：均值 ${mean(endEs).toFixed(2)}`);
  console.log(`  分布：` + keys.map((k) => `${k}次:${hist[k]}`).join("  "));
  console.log(`  样本轨迹（首 14 天主动次数）：${sampleTrace.slice(0, 14).join(" ")}`);
}

// 1 正常关系：10 分钟回，主动间隔 2 小时
run("正常（10 分钟回，2 小时插话一次，他每天找 3 次）",
  { replyMedian: 10, replySigma: 0.9, initMedian: 120, initSigma: 0.6, userChatsPerDay: 3 });

// 2 热聊：1 分钟回，主动间隔 40 分钟
run("热聊（1 分钟回，40 分钟插话一次，他每天找 8 次）",
  { replyMedian: 1, replySigma: 0.4, initMedian: 40, initSigma: 0.5, userChatsPerDay: 8 });

// 3 冷淡：2 小时回，主动间隔 4 小时
run("冷淡（2 小时回，4 小时插话一次，他每天找 1 次）",
  { replyMedian: 120, replySigma: 1.0, initMedian: 240, initSigma: 0.7, userChatsPerDay: 1 });

// 4 不回：他基本不接（12 小时才回）
run("不回（12 小时才回，他每天找 0.5 次）",
  { replyMedian: 720, replySigma: 0.8, initMedian: 180, initSigma: 0.6, userChatsPerDay: 0.5 });

// 5 抖动很大：同一个人有时秒回有时隔天
run("抖动大（回复 σ=1.4，中位 15 分钟）",
  { replyMedian: 15, replySigma: 1.4, initMedian: 120, initSigma: 0.9, userChatsPerDay: 3 });
