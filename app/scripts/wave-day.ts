#!/usr/bin/env node
/**
 * 用具体钟点讲清楚触发时机：三个晚上，逐分钟算水位，只打印有变化的时刻。
 *
 *   npx tsx scripts/wave-day.ts > ../docs/wave-timing-simple.md
 */
import { level, waveCfg, type Pulse } from "../src/core/wave.ts";

const MIN = 60_000;
const BASE = Date.parse("2026-10-26T22:00:00+08:00");
const cfg = waveCfg();
const WINDOW_MIN = 130;

const hm = (ts: number) =>
  new Date(ts).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false, hour: "2-digit", minute: "2-digit" });

function at(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(BASE);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

interface Row { t: number; a: number; recent: boolean; ok: boolean; fired: boolean; msgs: string[] }

function scene(title: string, lines: [string, string][], lead = "") {
  const pulses: Pulse[] = lines.map(([time]) => ({ ts: at(time), fromSelf: false }));
  const textOf = new Map<number, string>();
  for (const [time, text] of lines) {
    const t = at(time);
    textOf.set(t, (textOf.get(t) ?? "") + `${textOf.has(t) ? " " : ""}「${text}」`);
  }

  const rows: Row[] = [];
  let drained = 0;
  for (let t = pulses[0].ts; t <= pulses[0].ts + WINDOW_MIN * MIN; t += MIN) {
    const lv = level(pulses.filter((p) => p.ts <= t), t, cfg, drained);
    const recent = lv.ageMin !== null && lv.ageMin <= cfg.idleExemptMin;
    const ok = !recent || lv.a >= cfg.thr;
    const fired = recent && lv.a >= cfg.thr;
    rows.push({ t, a: lv.a, recent, ok, fired, msgs: textOf.has(t) ? [textOf.get(t)!] : [] });
    if (fired) drained = t;
  }

  console.log(`\n## ${title}\n`);
  if (lead) console.log(`${lead}\n`);
  console.log("| 时刻 | 发生了什么 | 水位 | 能开口吗 |");
  console.log("|---|---|---|---|");

  let prevOk = false;
  const out: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const risingAfter = i + 1 < rows.length && rows[i + 1].a > r.a;
    const isPeak = r.a > 0 && !risingAfter && (i === 0 || rows[i - 1].a <= r.a) && !r.fired;
    const coldStart = !r.recent && i > 0 && rows[i - 1].recent;

    if (r.msgs.length) {
      const verdict = r.fired ? `**开口**（水位 ${r.a.toFixed(2)} ≥ ${cfg.thr}），说完清零`
        : !r.recent ? "能，但交给每日额度管"
        : (r.t - (rows[i - 1]?.t ?? r.t)) / MIN < cfg.delayMin ? "不能，还在不打扰期" : "不能，水还不够";
      out.push(`| ${hm(r.t)} | ${r.msgs[0]} | ${r.a.toFixed(2)} | ${verdict} |`);
    } else if (r.fired && !prevOk) {
      const full = r.a >= cfg.thr * 2 ? "，水很满" : "";
      out.push(`| ${hm(r.t)} | **水位过线** | ${r.a.toFixed(2)} | **开口**${full}，说完清零，之后要重新蓄水 |`);
    } else if (isPeak && r.a < cfg.thr) {
      out.push(`| ${hm(r.t)} | 水位最高点 | ${r.a.toFixed(2)} | 不能，还差 ${(cfg.thr - r.a).toFixed(2)} |`);
    } else if (coldStart) {
      out.push(`| ${hm(r.t)} | 最后一条已经 3 小时 | 0.00 | 闸门不再管，交给每日额度 |`);
    }
    prevOk = r.ok;
  }
  console.log(out.join("\n"));
}

console.log("# 什么时候会开口：三个晚上");
console.log(`\n> 规则很简单：每句话往池子里加水，水过 ${cfg.thr} 才能开口，说完清空重来。`
  + `\n> 他的一句话加 ${cfg.wUser}，她自己说的加 ${cfg.wSelf}；刚说完的 ${cfg.delayMin} 分钟里水一直是 0。`);

scene("场景一：他只说了一句", [["22:03", "今天加班到九点"]],
  "一句话的水永远不够开一次口。");

scene("场景二：连说了三句", [
  ["22:03", "今天加班到九点"],
  ["22:06", "饭都没吃"],
  ["22:10", "刚到家"],
], "三句话叠起来，等她说完最后一句、再等 30 分钟就够线了。");

scene("场景三：聊了半小时", [
  ["22:00", "下班了"],
  ["22:04", "地铁上人好多"],
  ["22:09", "你今天吃啥了"],
  ["22:13", "我买了半个西瓜"],
  ["22:21", "好困"],
  ["22:28", "我先去洗澡"],
], "聊得越久水越满，但要等她说完最后一句、再等 30 分钟才开始算。");

console.log("\n## 记住三条就够了\n");
console.log("1. **刚聊完不开口**：最后一句之后的 30 分钟里，水位一直是 0。");
console.log(`2. **一句话不够**：单句最多加 ${cfg.wUser}，永远到不了 ${cfg.thr}，要两三句叠起来。`);
console.log("3. **开口一次就清空**：说完水位归零，下一次得靠新的对话重新攒。");
