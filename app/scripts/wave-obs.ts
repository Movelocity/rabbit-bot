#!/usr/bin/env node
/**
 * 水位场观测 / 回放：拿真实库里的消息重算「每个 tick 水位多少、会不会放行」。
 *
 *   npx tsx scripts/wave-obs.ts                 # 最近 7 天，5 分钟 tick
 *   npx tsx scripts/wave-obs.ts --days 3 --pool feishu:xxx
 *   npx tsx scripts/wave-obs.ts --thr 0.6 --w-user 0.3
 *
 * 只读打开数据库（mode=ro），不写任何东西；pm2 进程在跑也能用。
 * 语义：把每个 tick 当成「一个 L2 计划正好到点」，看水位会放行多少次——
 * 这是波的上限，真实发送还要过每日额度。
 */
import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { level, waveCfg, type Pulse } from "../src/core/wave.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name: string, def?: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};

const dbPath = arg("db", path.join(HERE, "..", "data", "rabbit-bot.db"));
const days = Number(arg("days", "7"));
const stepSec = Number(arg("step", "300"));
const cfg = waveCfg({
  thr: arg("thr") ? Number(arg("thr")) : undefined,
  wUser: arg("w-user") ? Number(arg("w-user")) : undefined,
  wSelf: arg("w-self") ? Number(arg("w-self")) : undefined,
  delayMin: arg("delay") ? Number(arg("delay")) : undefined,
  peakMin: arg("peak") ? Number(arg("peak")) : undefined,
  idleExemptMin: arg("idle-exempt") ? Number(arg("idle-exempt")) : undefined,
});

const db = new Database(dbPath, { readonly: true });
const poolArg = arg("pool");
const pools = poolArg
  ? [poolArg]
  : (db.prepare("SELECT pool_id FROM pools ORDER BY pool_id").all() as { pool_id: string }[]).map((r) => r.pool_id);

const now = Date.now();
const from = now - days * 86400_000;
const fmt = (ts: number) => new Date(ts).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });

console.log(`库 ${dbPath}\n窗口 ${fmt(from)} → ${fmt(now)}，tick ${stepSec}s，配置 ${JSON.stringify(cfg)}\n`);

for (const pool of pools) {
  const rows = db.prepare("SELECT ts, from_self FROM messages WHERE pool_id=? AND ts>=? ORDER BY ts")
    .all(pool, from) as { ts: number; from_self: number }[];
  if (!rows.length) continue;
  const pulses: Pulse[] = rows.map((r) => ({ ts: r.ts, fromSelf: !!r.from_self }));

  let drained = 0;
  let hitCount = 0;
  let blocked = 0;
  let blockedDelay = 0;   // 拦在不打扰期里（最后一条才几分钟前）
  let blockedLow = 0;     // 过了不打扰期但水位仍不够——这才是阈值在真正起作用
  let cold = 0;
  const hits: number[] = [];
  const aRecent: number[] = [];
  for (let t = from; t <= now; t += stepSec * 1000) {
    const lv = level(pulses.filter((p) => p.ts <= t), t, cfg, drained);
    const recent = lv.ageMin !== null && lv.ageMin <= cfg.idleExemptMin;
    if (!recent) { cold++; continue; }        // 冷场：不归水位管，交给每日额度
    aRecent.push(lv.a);
    if (lv.a >= cfg.thr) { hitCount++; hits.push(t); drained = t; } else {
      blocked++;
      if (lv.ageMin !== null && lv.ageMin < cfg.delayMin) blockedDelay++; else blockedLow++;
    }
  }
  const gaps = hits.slice(1).map((t, i) => (t - hits[i]) / 60_000);
  const mean = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
  const sd = gaps.length ? Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length) : 0;
  aRecent.sort((a, b) => a - b);
  const q = (p: number) => (aRecent.length ? aRecent[Math.min(aRecent.length - 1, Math.floor(aRecent.length * p))] : 0);
  const share = (x: number) => ((x / (hitCount + blocked + cold || 1)) * 100).toFixed(0);

  console.log(`池 ${pool}`);
  console.log(`  消息 ${rows.length} 条 / tick ${hitCount + blocked + cold}`);
  console.log(`  水位命中 ${hitCount}（${(hitCount / days).toFixed(1)}/天）  冷场不归波管 ${cold}（${share(cold)}%）`);
  console.log(`  拦下 ${blocked}：不打扰期内 ${blockedDelay}，过了不打扰期但水位不够 ${blockedLow}（后者才是阈值在起作用）`);
  if (gaps.length) {
    console.log(`  命中间隔 p50 ${gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)].toFixed(0)}min `
      + `CV ${(sd / mean).toFixed(2)}  范围 ${Math.min(...gaps).toFixed(0)}~${Math.max(...gaps).toFixed(0)}`);
  }
  console.log(`  近聊时水位 p50 ${q(0.5).toFixed(2)} p90 ${q(0.9).toFixed(2)} max ${q(1).toFixed(2)}（阈值 ${cfg.thr}）`);
  const byDay = new Map<string, string[]>();
  for (const t of hits) {
    const d = new Date(t).toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
    const hm = new Date(t).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false, hour: "2-digit", minute: "2-digit" });
    byDay.set(d, [...(byDay.get(d) ?? []), hm]);
  }
  for (const [d, vs] of [...byDay].sort()) {
    const head = vs.slice(0, 6).join(" ");
    console.log(`  ${d}  ${vs.length} 次  ${head}${vs.length > 6 ? ` …` : ""}`);
  }
  console.log();
}
db.close();
