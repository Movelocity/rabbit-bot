#!/usr/bin/env node
/**
 * npm run idle —— 看聊天活跃度算得对不对。
 * 打印 24 小时直方图 + 当前值 + 样本量，不然这套只能靠猜。
 */
import { Store } from "../dist/core/db.js";
import { computeIdle, idleNow } from "../dist/core/idle.js";

const store = new Store(new URL("../data/poolchat.db", import.meta.url).pathname);
const now = Date.now();
const m = computeIdle(store, now, "Asia/Shanghai");
const nowIdle = idleNow(m, store, now, "Asia/Shanghai");

const BAR = "▁▂▃▄▅▆▇█";
const bar = (s) => BAR[Math.min(7, Math.max(0, Math.round(s * 7)))];

console.log(`\n样本：${m.samples} 条消息 / ${m.days} 天   置信度：${m.confidence}`);
console.log(`他的回复时延分位：p25=${m.p25 === null ? "-" : (m.p25 / 1000).toFixed(0) + "s"}  p75=${m.p75 === null ? "-" : (m.p75 / 1000).toFixed(0) + "s"}`);
console.log(m.confidence === "low"
  ? "\n小时活跃度（0-23）——注意：样本不够，下面这条是默认曲线，不是从你的数据学的；\n此时 idleNow 恒为 0.5，闸门不拦也不放大。攒够 7 天 + 80 条才切个性化。"
  : "\n小时活跃度（0-23，从你自己的数据算）：");
for (let h = 0; h < 24; h += 6) {
  const row = m.buckets.slice(h, h + 6);
  console.log(
    "  " + row.map((b) => String(b.h).padStart(2, "0")).join("  ")
    + "\n  " + row.map((b) => ` ${bar(b.score)} `).join("  ")
    + "\n  " + row.map((b) => String(Math.round(b.score * 100)).padStart(2, " ")).join("  ")
    + "\n",
  );
}
const h = new Date(now).toLocaleString("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", hour12: false });
console.log(`现在是 ${h} 点，idleNow = ${nowIdle.toFixed(2)}（${nowIdle >= 0.6 ? "高活跃：L2 额度翻倍" : nowIdle >= 0.3 ? "中性：L2 正常 1 条" : "忙：L2 不发"}）`);
if (nowIdle === 1) console.log("（当前 30 分钟内有互动，直接给 1.0）");
