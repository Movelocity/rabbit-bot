/**
 * 本地模拟器：mock 适配器 + 桩 LLM（pi faux provider），走完整管线。
 *   npm run sim -- --demo     跑一遍脚本化演示（约 40 秒）
 *   npm run sim               交互模式：
 *       p <会话> <文字>   私聊消息        g <会话> <文字>  群消息（未@）
 *       @ <会话> <文字>   群消息并@我      tick  手动 tick
 *       pause / resume    暂停开关         wakes 最近唤醒日志     quit
 * 数据写到 data-sim/（每次启动清空），不碰正式数据。
 */
import "./env-defaults.ts";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { APP_ROOT, loadConfig } from "./config.ts";
import { App } from "./app.ts";
import { MockAdapter } from "./adapters/mock.ts";
import { createFauxModel } from "./agent/faux.ts";
import { Logger } from "./core/logger.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const demo = process.argv.includes("--demo");

async function main() {
  const dataDir = path.join(APP_ROOT, "data-sim");
  fs.rmSync(dataDir, { recursive: true, force: true });
  const cfg = loadConfig({
    dataDir, logDir: path.join(dataDir, "logs"),
    scheduler: { tickMs: 6000, activeTickMs: 3000, activeWindowMs: 20000, debounceMs: 1500, debounceMaxWaitMs: 5000 },
    send: { confirmWaitMs: 400 },
    handoff: { contextTokenLimit: 1300 },
    llm: { provider: "faux", model: "faux-brain" },
    emoji: { map: { 微笑: { text: "🙂" }, 666: { sticker: "mock_sticker_666" } } },
  });
  const { model, modelRuntime } = await createFauxModel(dataDir);
  const app = new App({ cfg, model, modelRuntime, logger: new Logger(cfg.logDir, true), inMemorySessions: true });
  const mock = new MockAdapter();
  mock.deliveryDelayMs = 100;
  app.hub.addAdapter(mock);
  mock.onSent = (s) => console.log(`  🤖 → [${s.chat}] ${s.kind === "sticker" ? `<表情包 ${s.content}>` : s.content}`);
  app.onWakeDone = (e) => {
    const tools = (e.tools ?? []).map((t: any) => t.name + (t.isError ? "!" : "")).join(",");
    console.log(`  📋 唤醒[${e.type}] ${e.reasons.join("；")} → ${e.outcome}；读 ${e.read?.length ?? 0} 条；工具 ${tools || "-"}；tokens ${e.tokens ?? 0}${e.handoffId ? `；交接#${e.handoffId}` : ""}`);
    if (e.assistantText) console.log(`     (后台日志) ${e.assistantText.replace(/\n/g, " / ").slice(0, 140)}`);
  };
  await app.start();
  const say = (kind: "p" | "g" | "@", chat: string, text: string, from = kind === "p" ? "alice" : "bob") => {
    console.log(`👤 ${from} @ ${chat}${kind === "@" ? "（@我）" : ""}: ${text}`);
    mock.inject({ chat, kind: kind === "p" ? "private" : "group", from, name: from === "alice" ? "爱丽丝" : from === "bob" ? "鲍勃" : from, text: kind === "@" ? `@小池 ${text}` : text, mentionMe: kind === "@", title: kind === "p" ? "私聊" : "测试群" });
  };

  if (demo) {
    console.log("\n=== 1. 私聊连发两条（去抖合并成一次唤醒），发送后用户又插话（经 send 返回值实时送达） ===");
    let interjected = false;
    const prevOnSent = mock.onSent;
    mock.onSent = (s) => { prevOnSent?.(s); if (!interjected && s.chat === "dm-alice") { interjected = true; setTimeout(() => say("p", "dm-alice", "对了，周末有空吗"), 50); } };
    say("p", "dm-alice", "你好呀");
    await sleep(300);
    say("p", "dm-alice", "在吗 [emoji:微笑]");
    await sleep(4000); await app.queue.idle();

    console.log("\n=== 2. 群聊未@（只在 tick 时读到，桩模型选择不说话）+ 群里@我 ===");
    say("g", "grp-1", "今天天气不错", "bob");
    await sleep(7000); await app.queue.idle();
    say("@", "grp-1", "帮我看下这个 [普通方括号] [emoji:666]", "carol");
    await sleep(3000); await app.queue.idle();

    console.log("\n=== 3. 写计划（LLM 工具 plan_add）+ 程序侧计划到点唤醒 ===");
    say("p", "dm-alice", "/plan 一分钟后提醒我喝水，记住我喜欢喝茶");
    await sleep(3000); await app.queue.idle();
    const pool = app.store.resolvePool("p1")!;
    const when = new Date(Date.now() + 2000).toISOString();
    const pl = app.store.insertPlan({ title: "喝水时间到", content: "", pool_id: pool.pool_id, schedule_kind: "once", schedule: when, expires_at: null });
    console.log(`  (程序插入一次性计划#${pl.id}，2 秒后到点；tick 时命中)`);
    await sleep(7000); await app.queue.idle();

    console.log("\n=== 4. 防死循环：桩模型用相同参数反复调用 read_pool ===");
    say("p", "dm-alice", "/loop");
    await sleep(3000); await app.queue.idle();

    console.log("\n=== 5. 暂停开关 ===");
    app.store.setPaused(true);
    say("p", "dm-alice", "暂停时发的消息");
    await sleep(2500); await app.queue.idle();
    app.store.setPaused(false);
    console.log("  (恢复后，下一次 tick 读到暂停期间的消息)");
    await sleep(7000); await app.queue.idle();

    const hs = app.store.listHandoffs();
    console.log(`\n=== 汇总 ===\n交接文档存档 ${hs.length} 份：${hs.map((h: any) => h.file).join(", ") || "-"}`);
    console.log(`计划：${JSON.stringify(app.store.listPlans().map((p) => ({ id: p.id, title: p.title, status: p.status })))}`);
    console.log(`用量：${JSON.stringify(app.store.getUsage(new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(new Date())))}`);
    console.log(`唤醒日志：${path.join(cfg.logDir, "wakes.jsonl")}`);
    await app.stop();
    process.exit(0);
  }

  console.log("交互模式。命令：p <会话> <文字> | g <会话> <文字> | @ <会话> <文字> | tick | pause | resume | wakes | quit");
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    const [cmd, chat, ...rest] = line.trim().split(/\s+/);
    if (cmd === "quit") { await app.stop(); process.exit(0); }
    else if (cmd === "tick") console.log(app.scheduler.tick() ? "已入队" : "无事");
    else if (cmd === "pause" || cmd === "resume") { app.store.setPaused(cmd === "pause"); console.log(cmd); }
    else if (cmd === "wakes") console.log(JSON.stringify(app.store.recentWakeLogs(3), null, 1));
    else if ((cmd === "p" || cmd === "g" || cmd === "@") && chat && rest.length) say(cmd, chat, rest.join(" "));
    else if (cmd) console.log("?");
  });
}
main().catch((e) => { console.error(e); process.exit(1); });
