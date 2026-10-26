#!/usr/bin/env node
/**
 * 现在这一刻：每个池的水位、退到第几档、会不会叫醒她。
 *
 *   npx tsx scripts/wave-check.ts
 *
 * 只读开库，线上进程在跑也能用。
 */
import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../src/core/db.ts";
import { waveCandidate } from "../src/core/wave.ts";
import { loadConfig } from "../src/config.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.argv[2] ?? path.join(HERE, "..", "data", "rabbit-bot.db");
const cfg = loadConfig({});
const wave = cfg.tide?.wave;

const store = new Store(dbPath);
const now = Date.now();
const mins = (ms: number) => Math.round(ms / 60_000);

console.log(`现在 ${new Date(now).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}`);
console.log(`参数 delay=${wave?.delayMin} peak=${wave?.peakMin} thr=${wave?.thr} ratio=${wave?.ratio} maxStages=${wave?.maxStages}\n`);

for (const pool of store.listPools()) {
  const c = waveCandidate(store, pool.pool_id, now, wave);
  const used = c ? store.usedWaveStages(pool.pool_id, c.sessionTs) : [];
  console.log(`池 ${pool.pool_id}（最后一条 ${mins(now - pool.last_msg_at)} 分钟前）`);
  if (!c) { console.log("  没有会话\n"); continue; }
  console.log(`  会话起 ${new Date(c.sessionTs).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false, hour: "2-digit", minute: "2-digit" })}`
    + `  峰值 ${c.peak.toFixed(2)}  现在水位 ${c.a.toFixed(2)}  档位 ${c.stage}  用过 [${used.join(",")}]`);
  console.log(`  ${c.ok ? "→ 会叫醒她（说不说她自己定）" : "→ 不叫"}：${c.detail}\n`);
}
store.close();
