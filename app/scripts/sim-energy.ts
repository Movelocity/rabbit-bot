// 推演：能量模型（红蓝染色 + 分档充能 + 退火冷却）
// 跑法：npx tsx scripts/sim-energy.ts
//
// 这不是项目代码，是接进 wake 之前的数字验证。为什么这么设计、结论是什么，见
// docs/energy-model.md。改参数就改下面这几个常量，再跑一遍看曲线。

const BANDS: [number, number][] = [
  [1, 1.0], [5, 0.85], [10, 0.7], [20, 0.55], [30, 0.45],
  [60, 0.3], [120, 0.2], [720, 0.1], [1440, 0.03],
];

const COST_ANSWER = 0.1;   // 醒来看到消息、回一句
const COST_INIT = 1.0;     // 主动插话 / 起话头
const GAIN = 0.5;          // 他回一句的满额收益（再乘档位）
const FLOOR = 1.0;         // 冷却地板：每天至少留一次
const CAP = 8.0;           // 恒定上限，不叠加基准
const HALF_H = 8;          // 冷却半衰期（小时）
const ACTIVE_START = 8 * 60;
const ACTIVE_END = 24 * 60; // 睡觉不掉电

function band(minutes: number | null): number {
  if (minutes === null || minutes > 1440) return 0;
  for (const [t, s] of BANDS) if (minutes <= t) return s;
  return 0;
}

/** 隔夜结算：她发出的每条消息 → 他回复用了几分钟（null=没回/超 24h） */
function settle(replies: (number | null)[]): number {
  const n = replies.length;
  if (n === 0) return 1;
  const p = replies.reduce((s, x) => s + band(x), 0) / n;
  return Math.max(1, Math.min(8, Math.round(1 + 7 * p * Math.min(1, n / 3))));
}

function activeMinutes(t0: number, t1: number): number {
  let total = 0;
  for (let day = 0; day <= Math.max(t1, 1440) + 1440; day += 1440) {
    const s = Math.max(t0, day + ACTIVE_START);
    const e = Math.min(t1, day + ACTIVE_END);
    if (e > s) total += e - s;
  }
  return total;
}

function cool(E: number, t0: number, t1: number): number {
  const m = activeMinutes(t0, t1);
  if (E <= FLOOR || m <= 0) return E;
  return FLOOR + (E - FLOOR) * Math.pow(0.5, m / (HALF_H * 60));
}

type Msg = { t: number; color: "r" | "b"; kind?: "init" | "answer" };

function sim(name: string, base: number, msgs: Msg[], showHours = false) {
  let E = base, lastT = 0, pendingRed: number | null = null;
  const st = { init: 0, answer: 0, blocked: 0, gain: 0 };
  const curve: [number, number][] = [];

  for (const m of msgs) {
    E = cool(E, lastT, m.t);
    lastT = m.t;
    if (m.color === "r") {
      const cost = m.kind === "init" ? COST_INIT : COST_ANSWER;
      if (m.kind === "init" && E < COST_INIT) { st.blocked++; continue; }
      E = Math.max(0, E - cost);
      if (m.kind === "init") st.init++; else st.answer++;
      if (pendingRed === null) pendingRed = m.t;
    } else {
      if (pendingRed !== null) {
        const g = Math.max(0, Math.min(GAIN * band(m.t - pendingRed), CAP - E));
        E += g;
        st.gain += g;
      }
      pendingRed = null;
    }
    curve.push([m.t, E]);
  }

  E = cool(E, lastT, ACTIVE_END);
  const peak = curve.length ? Math.max(...curve.map(([, e]) => e)) : E;
  console.log(`\n${name}  基准 ${base}`);
  console.log(`  主动 ${st.init}｜回答 ${st.answer}｜被拦 ${st.blocked}｜充能 +${st.gain.toFixed(2)}`);
  console.log(`  → 24:00 E=${E.toFixed(2)}｜峰值 ${peak.toFixed(2)}`);

  if (showHours) {
    const row: string[] = [];
    for (let h = 8; h <= 24; h++) {
      const prev = curve.filter(([t]) => t <= h * 60);
      const e = prev.length ? cool(prev[prev.length - 1][1], prev[prev.length - 1][0], h * 60) : cool(base, 0, h * 60);
      row.push(`${String(h).padStart(2, "0")}:${e.toFixed(1)}`);
    }
    console.log("   " + row.join(" "));
  }
  return E;
}

const cls = (n: number) => String(n).padStart(3, " ");

// A 早聊 40 分钟冲到顶，之后一整天没人
const a: Msg[] = [];
for (let i = 0; i < 12; i++) {
  a.push({ t: 540 + i * 3, color: "b" });
  a.push({ t: 541 + i * 3, color: "r", kind: "answer" });
}
sim("A 早聊 40 分钟冲到顶，之后整天没人", 3, a, true);

// B 全天稀疏：9/13/18/22 点各一轮，每次 5 分钟内回
const b: Msg[] = [];
for (const t of [540, 780, 1080, 1320]) {
  b.push({ t, color: "r", kind: "init" });
  b.push({ t: t + 5, color: "b" });
}
sim("B 全天稀疏（4 轮，每轮 5 分钟内回）", 3, b, true);

// C 一整天没有任何互动
sim("C 一整天没有任何互动（从 5 开始）", 5, [], true);

// D 早聊充到顶，晚上 20:00 主动一次
const d: Msg[] = [];
for (let i = 0; i < 10; i++) {
  d.push({ t: 540 + i * 3, color: "b" });
  d.push({ t: 541 + i * 3, color: "r", kind: "answer" });
}
d.push({ t: 1200, color: "r", kind: "init" });
d.push({ t: 1201, color: "b" });
sim("D 早聊到顶，20:00 再主动一次", 3, d, true);

// E 一天没回：基准 1，4 次主动能发出几次
sim("E 一天没回（基准 1，主动 4 次，全无回应）", 1,
  [540, 660, 840, 1020].map((t) => ({ t, color: "r" as const, kind: "init" as const })));

console.log("\n=== 半衰期对比：09:00 充到 8，之后不管它 ===");
for (const hh of [4, 8, 12, 24]) {
  const row = [12, 15, 18, 21, 24].map((h) => {
    const m = activeMinutes(9 * 60, h * 60);
    const e = FLOOR + (8 - FLOOR) * Math.pow(0.5, m / (hh * 60));
    return `${h}:00=${e.toFixed(1)}`;
  });
  console.log(`  半衰 ${String(hh).padStart(2)}h  ` + row.join("  "));
}

console.log("\n=== 隔夜结算（只数红→蓝区间）===");
const cases: [string, (number | null)[]][] = [
  ["8 个区间全 1 分钟内", Array(8).fill(1)],
  ["10 个：8 个 10 分钟、2 个超 24h", [...Array(8).fill(10), null, null]],
  ["6 个：2 个 5 分钟、4 个超 24h", [5, 5, null, null, null, null]],
  ["只有 1 个区间、1 分钟", [1]],
  ["2 个区间都超 24h", [null, null]],
  ["20 个区间全部 30 分钟", Array(20).fill(30)],
  ["20 个区间全部 2 小时", Array(20).fill(120)],
];
for (const [name, r] of cases) console.log(`  ${name.padEnd(32)} → E=${settle(r)}`);

console.log("\n=== 真实例子：今天 18:57 她连发 4 条 → 19:37 主人回 ===");
const gapReal = 39;
console.log(`  区间 ${gapReal} 分钟 → 落在 ${BANDS.find(([t]) => gapReal <= t)?.[0]} 分钟档 → ` +
  `得分 ${band(gapReal).toFixed(2)} → 充能 +${(GAIN * band(gapReal)).toFixed(2)}`);
