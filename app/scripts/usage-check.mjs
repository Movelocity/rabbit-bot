// 记账链路自检：老库补列 + 三段累加：node --experimental-strip-types scripts/usage-check.mjs
import { Store } from "../src/core/db.ts";
const s = new Store(":memory:");
s.addUsage("2026-11-07", 3, 900, 1, { cacheHit: 8000, cacheMiss: 1000, outTokens: 400, costUsd: 0.0009 });
s.addUsage("2026-11-07", 2, 500, 0, { cacheHit: 4000, cacheMiss: 500, outTokens: 200, costUsd: 0.0004 });
const u = s.getUsage("2026-11-07");
console.log(JSON.stringify(u));
const inTok = u.cache_hit + u.cache_miss;
console.log("hit%", ((u.cache_hit / inTok) * 100).toFixed(1), "¥", (u.cost_usd * 7.1).toFixed(5));
