/** 运维命令：pause / resume / status / usage / wakes / plans / handoffs / identities / link / models */
import "./env-defaults.ts";
import path from "node:path";
import { loadConfig } from "./config.ts";
import { Store } from "./core/db.ts";
import { dayKey, fmtLocal } from "./core/time.ts";

async function main() {
  const [cmd = "status", ...args] = process.argv.slice(2);
  const cfg = loadConfig();
  if (cmd === "models") {
    const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
    const rt = await ModelRuntime.create({ authPath: path.join(cfg.dataDir, "pi-agent/auth.json"), modelsPath: path.join(cfg.dataDir, "pi-agent/models.json") });
    const by = new Map<string, string[]>();
    for (const m of rt.getModels(args[0])) (by.get(m.provider) ?? by.set(m.provider, []).get(m.provider)!).push(m.id);
    for (const [p, ids] of by) console.log(`${p} (${ids.length}): ${args[0] ? ids.join(", ") : ids.slice(0, 6).join(", ") + (ids.length > 6 ? " …" : "")}`);
    const avail = await rt.getAvailable();
    console.log(`\n当前有凭据可用的 provider：${[...new Set(avail.map((m) => m.provider))].join(", ") || "（无）"}`);
    return;
  }
  const store = new Store(path.join(cfg.dataDir, "rabbit-bot.db"));
  const out = (x: unknown) => console.log(typeof x === "string" ? x : JSON.stringify(x, null, 2));
  switch (cmd) {
    case "pause": store.setPaused(true); out("已暂停（消息仍会入池，但不会唤醒 Agent）"); break;
    case "resume": store.setPaused(false); out("已恢复"); break;
    case "status": {
      const day = dayKey(Date.now());
      out({ paused: store.isPaused(), today: day, usage: store.getUsage(day), limits: cfg.limits, pools: store.listPools().length, unreadPools: store.poolsWithUnread(), pendingPlans: store.listPlans("pending").length, handoffs: store.listHandoffs().length });
      break;
    }
    case "usage": out(store.db.prepare("SELECT * FROM usage_daily ORDER BY day DESC LIMIT 14").all()); break;
    case "wakes": out(store.recentWakeLogs(Number(args[0] ?? 10))); break;
    case "pools": out(store.listPools().map((p) => ({ alias: store.poolAlias(p.pool_id), ...p, last: p.last_msg_at ? fmtLocal(p.last_msg_at) : null }))); break;
    case "plans": out(store.listPlans()); break;
    case "handoffs": out(store.listHandoffs()); break;
    case "identities": out(store.listIdentities()); break;
    case "link": {
      const [platform, pid, uid] = args;
      if (!platform || !pid || !uid) { out("用法：ctl link <platform> <platform_user_id> <user_id>"); process.exit(1); }
      store.linkIdentity(platform, pid, uid); out(`已把 ${platform}:${pid} 映射到 ${uid}`); break;
    }
    default: out(`未知命令 ${cmd}`); process.exit(1);
  }
  store.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
