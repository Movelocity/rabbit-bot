#!/usr/bin/env node
/**
 * 生成「水位场触发机制」的时间线案例，直接输出 markdown 片段。
 *
 *   npx tsx scripts/wave-cases.ts > ../docs/wave-timing-cases.md
 *
 * 全部数字由 wave.ts 现算，不手写。
 */
import { level, waveCfg, type Pulse, type WaveConfig } from "../src/core/wave.ts";

const MIN = 60_000;
const T0 = 1_700_000_000_000;
const step = 5;            // 每格 5 分钟
const cols = 30;           // 150 分钟

function glyph(a: number, thr: number): string {
  if (a <= 0) return "·";
  if (a < thr * 0.5) return "▁";
  if (a < thr) return "▄";
  if (a < thr * 1.5) return "▆";
  return "█";
}

/** 精确命中时刻：1 分钟扫描，含泄流演进 */
function exactHits(pulses: Pulse[], cfg: WaveConfig, drainedAt = 0, horizonMin = 180): number[] {
  const hits: number[] = [];
  let drained = drainedAt;
  for (let m = 0; m <= horizonMin; m++) {
    const t = T0 + m * MIN;
    const lv = level(pulses.filter((p) => p.ts <= t), t, cfg, drained);
    const recent = lv.ageMin !== null && lv.ageMin <= cfg.idleExemptMin;
    if (recent && lv.a >= cfg.thr) { hits.push(m); drained = t; }
  }
  return hits;
}

function line(pulses: Pulse[], cfg: WaveConfig, drainedAt = 0): { art: string; marks: string; hits: number[] } {
  const hits = exactHits(pulses, cfg, drainedAt, (cols - 1) * step);
  let art = "";
  let marks = "";
  let drained = drainedAt;
  for (let i = 0; i < cols; i++) {
    const t = T0 + i * step * MIN;
    const lv = level(pulses.filter((p) => p.ts <= t), t, cfg, drained);
    const recent = lv.ageMin !== null && lv.ageMin <= cfg.idleExemptMin;
    const water = recent && lv.a >= cfg.thr;
    if (water) drained = t;
    art += glyph(recent ? lv.a : 0, cfg.thr);
    // ▲ 只标在第一次跨过阈值的那一格；○ 表示「冷场豁免，水位不参与」
    const firstIdx = hits.length ? Math.round(hits[0] / step) : -1;
    marks += !recent ? "○" : i === firstIdx ? "▲" : " ";
  }
  return { art, marks, hits };
}

function ruler(): string {
  const arr = Array(cols).fill(" ");
  for (let i = 0; i < cols; i += 6) {
    const s = String(i * step);
    for (let k = 0; k < s.length; k++) arr[i + k] = s[k];
  }
  return arr.join("");
}

function caseBlock(title: string, desc: string, pulses: Pulse[], cfg: WaveConfig, drainedAt = 0, note = "") {
  const { art, marks, hits } = line(pulses, cfg, drainedAt);
  const at = pulses.map((p) => `${(p.ts - T0) / MIN}${p.fromSelf ? "(自)" : ""}`).join(", ");
  const verdict = hits.length
    ? `命中 t = ${hits.map((h) => `+${h}min`).join(", ")}`
    : "全程不触发";
  console.log(`\n### ${title}\n`);
  console.log(`${desc}\n`);
  console.log("```");
  console.log(`脉搏   ${at}`);
  console.log(`A(t)   ${art}`);
  console.log(`命中   ${marks}`);
  console.log(`       ${ruler()}  (min)`);
  console.log("```");
  console.log(`→ ${verdict}${note ? `；${note}` : ""}`);
}

const cfg = waveCfg();

console.log("# 水位场触发机制：时间线案例");
console.log(`\n> 参数：delay=${cfg.delayMin}min，peak=${cfg.peakMin}min，thr=${cfg.thr}，`
  + `w_user=${cfg.wUser}，w_self=${cfg.wSelf}，idleExempt=${cfg.idleExemptMin}min。`
  + `\n> 符号：· 水位 0，▁ <0.25，▄ <0.5，▆ <0.75，█ ≥0.75；▲ = 第一次跨过阈值并泄流，○ = 冷场豁免（水位不参与）。每格 5 分钟。`);

caseBlock(
  "C1 单条消息：永不触发",
  "`w_user < thr` 的直接后果。孤立的一句话不够开一次口，音量不会因为「等得久」变大。",
  [{ ts: T0, fromSelf: false }], cfg,
  0, "峰值 0.40 < 阈值 0.50",
);

caseBlock(
  "C2 两条相隔 10 分钟：+42 分钟开口",
  "叠加够了才开口。命中窗口有起有落：早了水还没涨上来，晚了又退回去。",
  [{ ts: T0, fromSelf: false }, { ts: T0 + 10 * MIN, fromSelf: false }], cfg,
);

caseBlock(
  "C2b 两条相隔 25 分钟：水位成了瓶颈",
  "最后一条之后满 30 分钟时水还不够——第一条已经退到 0.28，第二条才刚起步。还要再等几格才过阈值：这时决定开口时刻的是水位，不是不打扰期。",
  [{ ts: T0, fromSelf: false }, { ts: T0 + 25 * MIN, fromSelf: false }], cfg,
);

caseBlock(
  "C3 密聊五条：更晚、更久、仍只算一次",
  "叠加把起爆点往后推、把高水位拉宽，但只泄流一次——叠加再多也只算一个。",
  [0, 2, 5, 8, 12].map((m) => ({ ts: T0 + m * MIN, fromSelf: false })), cfg,
);

const fastCfg = waveCfg({ delayMin: 10, peakMin: 30 });
caseBlock(
  "C3b 同一个场景，把不打扰期压到 10 分钟",
  "delay 一收短，起爆点立刻提前到 +22 分钟——起爆延迟的公式是第一句话命脉：**最后一条 + max(不打扰期, 水位积累时间)**。",
  [0, 2, 5, 8, 12].map((m) => ({ ts: T0 + m * MIN, fromSelf: false })), fastCfg,
);

caseBlock(
  "C4 会话结束 → 泄流 → 下一轮重新蓄水",
  "泄流把 t=42 之前的脉冲全部作废；同样的两条新消息重新蓄水，间隔由对话本身决定，不是固定节拍。",
  [
    { ts: T0, fromSelf: false }, { ts: T0 + 10 * MIN, fromSelf: false },
    { ts: T0 + 60 * MIN, fromSelf: false }, { ts: T0 + 70 * MIN, fromSelf: false },
  ], cfg, T0 + 42 * MIN,
);

caseBlock(
  "C5 冷场豁免：最后一条在 4 小时前",
  "水位早已归零，但这不是「刚聊完别打扰」，是「没人说话」。豁免后交给每日额度，否则普通关心永远发不出去。",
  [{ ts: T0 - 240 * MIN, fromSelf: false }, { ts: T0 - 238 * MIN, fromSelf: false }], cfg,
  0, "豁免裁定放行、水位不参与",
);

caseBlock(
  "C6 自己说的话也算，但更轻",
  "她说完一句，水也涨一点，但权重 0.25：自己开口更该克制，不能靠自言自语攒出下一次发言。",
  [{ ts: T0, fromSelf: true }, { ts: T0 + 10 * MIN, fromSelf: true }], cfg,
  0, "两条自说自话仍不够开口",
);

// 隔夜不积压
const night = [{ ts: T0, fromSelf: false }, { ts: T0 + 10 * MIN, fromSelf: false }];
const at8 = level(night, T0 + 7 * 3600_000, cfg);
console.log("\n### C7 夜里不积压\n");
console.log("晚上 23 点聊完，静默到早上 8 点：水位已经回到 0，不会一醒来就被补发的热情吵到。\n");
console.log("| 经过时间 | A(t) |");
console.log("|---|---|");
for (const h of [0.5, 1, 2, 4, 7]) {
  console.log(`| ${h} 小时 | ${level(night, T0 + h * 3600_000, cfg).a.toFixed(3)} |`);
}
console.log(`\n→ 7 小时后 A = ${at8.a}（阈值 ${cfg.thr}）`);
