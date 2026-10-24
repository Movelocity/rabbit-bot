/** 正式服务入口：飞书长连接 + pi。缺少凭据直接退出，不会空跑。 */
import "./env-defaults.ts";
import { loadConfig, missingEnv } from "./config.ts";
import { App } from "./app.ts";
import { resolveModel } from "./agent/engine.ts";
import { FeishuAdapter } from "./adapters/feishu.ts";
import { Logger } from "./core/logger.ts";
import { startInjectServer } from "./inject.ts";
import { acquireLock, releaseLock } from "./core/lockfile.ts";
import path from "node:path";

async function main() {
  const cfg = loadConfig();
  const log = new Logger(cfg.logDir);
  if (cfg.llm.provider === "faux") throw new Error("正式服务不能使用 faux 桩模型；请在 config/local.json 设置 llm.provider/model");
  if (cfg.adapters.feishu.enabled) {
    const miss = missingEnv(["FEISHU_APP_ID", "FEISHU_APP_SECRET"]);
    if (miss.length) { log.error(`缺少环境变量：${miss.join(", ")}，退出`); process.exit(2); }
  }
  let model;
  try { model = await resolveModel(cfg); } catch (e) { log.error(`LLM 配置不可用：${(e as Error).message}`); process.exit(2); }

  // 单实例锁：两个进程同时连飞书会抢同一条消息、各推各的游标（10-23 踩过：孤儿进程活了 27 小时，
  // 表现成"图有时能看有时看不到""日志时有时无"）。实现见 core/lockfile.ts ——
  // 原子占锁（O_EXCL）、确认持有者真的是 poolchat（防 pid 复用误判）、残锁自愈。
  const lockFile = path.join(cfg.dataDir, "run", "main.pid");
  const got = acquireLock(lockFile);
  if (!got.ok) {
    const since = got.holder.startedAt ? new Date(got.holder.startedAt).toLocaleString("zh-CN") : "未知";
    log.error(`已有实例在跑（pid ${got.holder.pid}，起于 ${since}），本次不启动。确认真死透了再 kill ${got.holder.pid}`);
    process.exit(3);
  }
  if (got.tookOver) log.warn("接手上一个实例留下的锁（那个进程已经不在了）");
  process.on("exit", () => releaseLock(lockFile));

  const app = new App({ cfg, model: model.model, modelRuntime: model.modelRuntime, logger: log });
  if (cfg.adapters.feishu.enabled)
    app.hub.addAdapter(new FeishuAdapter({ appId: process.env.FEISHU_APP_ID!, appSecret: process.env.FEISHU_APP_SECRET!, domain: cfg.adapters.feishu.domain, fetchSenderName: cfg.adapters.feishu.fetchSenderName, reactions: cfg.adapters.feishu.reactions, logRawEmoji: cfg.adapters.feishu.logRawEmoji, emoji: app.emoji, media: { dir: path.join(cfg.dataDir, "media"), maxEdge: cfg.media.maxEdge, maxBytes: cfg.media.maxBytes } }, log));

  let stopping = false;
  let injectSrv: Awaited<ReturnType<typeof startInjectServer>> = null;
  const shutdown = async (sig: string) => {
    if (stopping) return; stopping = true;
    log.info(`收到 ${sig}，等待当前唤醒结束后退出`);
    const force = setTimeout(() => process.exit(1), 30_000); force.unref();
    if (injectSrv) await new Promise<void>((r) => injectSrv!.close(() => r()));
    await app.stop().catch((e) => log.error("退出异常", e));
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("unhandledRejection", (e) => log.error("unhandledRejection", e));
  await app.start();
  injectSrv = await startInjectServer({ cfg, hub: app.hub, store: app.store, log });
}

main().catch((e) => { console.error(e); process.exit(1); });
