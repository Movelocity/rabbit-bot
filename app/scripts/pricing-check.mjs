// 手跑一次的价目表体检：node --experimental-strip-types scripts/pricing-check.mjs
import { costUsd, isPeakHour, splitUsage } from "../src/core/pricing.ts";
const t = (s) => Date.parse(s);
// 2026-11-08 是周日，11-09 是周一
const cases = [
  ["2026-11-08T02:00:00Z", "周日 10:00 北京 → 谷"],
  ["2026-11-08T06:30:00Z", "周日 14:30 北京 → 谷"],
  ["2026-11-09T02:00:00Z", "周一 10:00 北京 → 峰"],
  ["2026-11-09T06:30:00Z", "周一 14:30 北京 → 峰"],
  ["2026-11-09T01:30:00Z", "周一 09:30 北京 → 峰"],
  ["2026-11-09T04:30:00Z", "周一 12:30 北京 → 谷"],
  ["2026-11-09T12:00:00Z", "周一 20:00 北京 → 谷"],
];
for (const [iso, name] of cases) console.log(name.padEnd(24), isPeakHour(t(iso)) ? "PEAK" : "off");
const split = { hit: 900_000, miss: 100_000, out: 20_000 };
console.log("100万输入(90%命中)+2万输出 峰:", costUsd("deepseek-flash", split, t("2026-11-09T06:30:00Z")).toFixed(5), "USD");
console.log("同一次 谷:", costUsd("deepseek-flash", split, t("2026-11-09T12:00:00Z")).toFixed(5), "USD");
console.log("splitUsage:", JSON.stringify(splitUsage({ input: 1000, cacheRead: 800, output: 50 })));
