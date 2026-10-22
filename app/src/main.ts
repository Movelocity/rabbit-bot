/** 正式服务入口：飞书长连接 + pi。缺少凭据直接退出，不会空跑。 */
import "./env-defaults.ts";
import { loadConfig, missingEnv } from "./config.ts";
import { App } from "./app.ts";
import { resolveModel } from "./agent/engine.ts";
import { FeishuAdapter } from "./adapters/feishu.ts";
import { QQAdapter } from "./adapters/qq.ts";
import { Logger } from "./core/logger.ts";

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

  const app = new App({ cfg, model: model.model, modelRuntime: model.modelRuntime, logger: log });
  if (cfg.adapters.feishu.enabled)
    app.hub.addAdapter(new FeishuAdapter({ appId: process.env.FEISHU_APP_ID!, appSecret: process.env.FEISHU_APP_SECRET!, domain: cfg.adapters.feishu.domain, fetchSenderName: cfg.adapters.feishu.fetchSenderName }, log));
  if (cfg.adapters.qq.enabled) app.hub.addAdapter(new QQAdapter());

  let stopping = false;
  const shutdown = async (sig: string) => {
    if (stopping) return; stopping = true;
    log.info(`收到 ${sig}，等待当前唤醒结束后退出`);
    const force = setTimeout(() => process.exit(1), 30_000); force.unref();
    await app.stop().catch((e) => log.error("退出异常", e));
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("unhandledRejection", (e) => log.error("unhandledRejection", e));
  await app.start();
}

main().catch((e) => { console.error(e); process.exit(1); });
