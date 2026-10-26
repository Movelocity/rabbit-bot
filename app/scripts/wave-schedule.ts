#!/usr/bin/env node
/**
 * 对着三组目标间隔调参：普通一轮 / 5 轮 / 10 轮。
 *
 *   npx tsx scripts/wave-schedule.ts            # 当前参数
 *   npx tsx scripts/wave-schedule.ts --grid     # 扫一遍 delay/peak/ratio 找最接近的
 *
 * 目标（主人给的例子，允许不完全匹配）：
 *   普通一轮   → 10min, 50min, 120min
 *   10 分钟 5 轮 → 7min, 14min, 30min
 *   17 分钟 10 轮 → 10min, 32min, 60min, 180min
 */
import { level, waveCfg, waveSchedule, type Pulse } from "../src/core/wave.ts";

const MIN = 60_000;
const T0 = 1_700_000_000_000;

/** 造一个会话：n 条消息均匀铺在 spanMin 分钟里 */
function convo(n: number, spanMin: number): Pulse[] {
  if (n === 1) return [{ ts: T0, fromSelf: false }];
  return Array.from({ length: n }, (_, i) => ({
    ts: T0 + Math.round((spanMin * i) / (n - 1)) * MIN,
    fromSelf: false,
  }));
}

const TARGETS: [string, Pulse[], number[]][] = [
  ["普通一轮（2 条）", convo(2, 3), [10, 50, 120]],
  ["10 分钟 5 轮（10 条）", convo(10, 8), [7, 14, 30]],
  ["17 分钟 10 轮（20 条）", convo(20, 17), [10, 32, 60, 180]],
];

const runs = (cfg: ReturnType<typeof waveCfg>, ratio: number, start: number) => {
  // 起点 = 最后一条消息，间隔都从「聊完」算
  const res: number[][] = [];
  for (const [, pulses, ] of TARGETS) {
    const last = pulses[pulses.length - 1].ts;
    const pts = waveSchedule(pulses, last, cfg, { ratio, stages: 4, horizonH: 6 });
    res.push(pts.map((p) => Math.round((p.at - last) / MIN)));
  }
  return res;
};

/** 与目标的平均相对误差（只比双方都有的档位，缺一个点罚 25%） */
function score(got: number[][], missPenalty = 0.25) {
  let total = 0;
  for (let i = 0; i < TARGETS.length; i++) {
    const tgt = TARGETS[i][2];
    const g = got[i];
    const n = Math.min(tgt.length, g.length);
    let s = 0;
    for (let k = 0; k < n; k++) s += Math.abs(g[k] - tgt[k]) / tgt[k];
    s = n ? s / n : 1;
    s += Math.abs(tgt.length - g.length) * missPenalty;
    total += s;
  }
  return total / TARGETS.length;
}

const show = (cfg: ReturnType<typeof waveCfg>, ratio: number) => {
  const got = runs(cfg, ratio, 0);
  console.log(`delay=${cfg.delayMin} peak=${cfg.peakMin} thr=${cfg.thr} w=${cfg.wUser} ratio=${ratio}`);
  for (let i = 0; i < TARGETS.length; i++) {
    const [name, , tgt] = TARGETS[i];
    console.log(`  ${name.padEnd(22)} 目标 ${tgt.join("/")}   得到 ${got[i].join("/") || "（无）"}`);
  }
  console.log(`  误差 ${(score(got) * 100).toFixed(0)}%\n`);
};

if (process.argv.includes("--grid")) {
  const all: { s: number; line: string; cfg: ReturnType<typeof waveCfg>; ratio: number }[] = [];
  for (const delayMin of [6, 8, 10, 12]) {
    for (const peakMin of [15, 20, 25, 30, 40]) {
      for (const wUser of [0.4, 0.5, 0.6]) {
        for (const ratio of [0.4, 0.45, 0.5, 0.55, 0.6]) {
          const cfg = waveCfg({ delayMin, peakMin, thr: 0.5, wUser, wSelf: 0.3, idleExemptMin: 180 });
          all.push({ s: score(runs(cfg, ratio, 0)), line: `${delayMin},${peakMin},${wUser},${ratio}`, cfg, ratio });
        }
      }
    }
  }
  all.sort((a, b) => a.s - b.s);
  for (const t of all.slice(0, 3)) {
    console.log(`--- 误差 ${(t.s * 100).toFixed(0)}%  (delay,peak,w,ratio)=${t.line}`);
    show(t.cfg, t.ratio);
  }
} else {
  const num = (name: string, def: number) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? Number(process.argv[i + 1]) : def;
  };
  show(waveCfg({
    delayMin: num("delay", 10), peakMin: num("peak", 15),
    wUser: num("w", 0.5), wSelf: 0.3,
  }), num("ratio", 0.5));
}
