// 一次性验证：四条主动性改动是不是真的在代码里生效（不是只过了测试）。
// 跑法：npx tsx scripts/probe-proactive.ts
import { level, WAVE_DEFAULTS } from "../src/core/wave.js";

const now = Date.UTC(2026, 9, 29, 8, 0, 0); // 固定时间，避免跑一次一个结果
const H = 3600e3;
const cfg = { ...WAVE_DEFAULTS, delayMin: 10, peakMin: 20, thr: 0.5, wUser: 0.4, wSelf: 0.25 };

function show(label: string, pulses: { ts: number; w: number; kind: "user" | "self" }[], hoursIdle: number) {
  const t = now;
  const a = level(pulses, t, cfg, 0).a;
  console.log(`${label}（空窗 ${hoursIdle}h）→ A=${a.toFixed(4)}`);
  return a;
}

console.log("=== 1. 空窗项：越久没说话，水位越高 ===");
const base = [{ ts: now - 30 * 60e3, w: 0.4, kind: "user" as const }];
for (const h of [0.5, 3, 6, 12, 18, 24, 48]) {
  const pulses = h <= 0.5 ? base : [{ ts: now - h * H, w: 0.4, kind: "user" as const }];
  const a = level(pulses, now, cfg, 0).a;
  console.log(`  空窗 ${String(h).padStart(4)}h → A=${a.toFixed(4)}`);
}

console.log("\n=== 2. 聊天中（<6h）空窗项必须是 0 ===");
for (const m of [20, 40, 60, 120, 300]) {
  const a = level([{ ts: now - m * 60e3, w: 0.4, kind: "user" as const }], now, cfg, 0).a;
  console.log(`  ${String(m).padStart(3)} 分钟前说过话 → A=${a.toFixed(4)}`);
}

console.log("\n=== 3. 空窗项权重为 0 时行为不变（可回退） ===");
const off = { ...cfg, wIdle: 0 };
console.log(`  48h 空窗、wIdle=0 → A=${level([{ ts: now - 48 * H, w: 0.4, kind: "user" as const }], now, off, 0).a.toFixed(4)}`);
