/**
 * 本地 Web 管理台 demo：不开飞书、不调模型，直接用现有 data/rabbit-bot.db 起 API + 静态页。
 *
 *   npm run web
 *   npm run web -- --port 3748          # 正式服务已经占着 3738 时
 *   npm run web -- --host 0.0.0.0       # 想让局域网也能打开
 *
 * 只读：页面只查询现有数据库，不提供任何写接口。收发消息请走飞书 IM。
 */
import "../src/env-defaults.ts";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/core/db.ts";
import { Logger } from "../src/core/logger.ts";
import { startApiServer } from "../src/api.ts";
import { resolveApiToken } from "../src/api-token.ts";
import { loadSchedulerSettings } from "../src/ops/scheduler-settings.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
  const pref = `${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pref));
  return hit ? hit.slice(pref.length) : undefined;
}

async function main() {
  const cfg = loadConfig();
  const rawPort = arg("--port") ?? process.env.RABBIT_BOT_WEB_PORT;
  const port = rawPort ? Number(rawPort) : (cfg.api?.port ?? 3738);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`端口不对：${rawPort}`);
  const host = arg("--host") ?? "127.0.0.1";
  cfg.api = { enabled: true, port, host };

  const log = new Logger(cfg.logDir);
  // demo 页面也显示正式服务保存过的调度值
  loadSchedulerSettings(cfg, log);
  const dbArg = arg("--db");
  const dbFile = dbArg ? path.resolve(dbArg) : path.join(cfg.dataDir, "rabbit-bot.db");
  const store = new Store(dbFile);
  const token = resolveApiToken(cfg);

  let server;
  try {
    server = await startApiServer({ cfg, store, log, token });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EADDRINUSE") {
      console.error(`端口 ${port} 已被占用（正式服务可能正在跑）。换一个：npm run web -- --port ${port + 1}`);
    } else {
      console.error("启动失败：", (e as Error).message);
    }
    store.close();
    process.exit(1);
  }

  const shownHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const tokenFile = path.join(cfg.dataDir, "run", "api.token");
  console.log("");
  console.log(`Web 管理台：http://${shownHost}:${port}/`);
  console.log(`数据库：${dbFile}`);
  console.log(`token：${token}`);
  console.log(`token 文件：${tokenFile}`);
  console.log("");
  console.log("管理台：会话/审批只读；人格、提示词、记忆可改。聊天和审批仍走飞书。Ctrl+C 退出。");

  const shutdown = () => {
    console.log("\n退出中…");
    server?.close(() => {
      store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
