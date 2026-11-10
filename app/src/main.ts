/** 正式服务入口：飞书长连接 + pi。缺少凭据直接退出，不会空跑。 */
import "./env-defaults.ts";
import { loadConfig, missingEnv } from "./config.ts";
import { App } from "./app.ts";
import { resolveModel } from "./agent/engine.ts";
import { FeishuAdapter } from "./adapters/feishu.ts";
import { MatrixAdapter } from "./adapters/matrix.ts";
import { MockAdapter } from "./adapters/mock.ts";
import { Logger } from "./core/logger.ts";
import { makeWake } from "./core/queue.ts";
import { setOwnerIds } from "./core/owners.ts";
import { startInjectServer } from "./inject.ts";
import { startApiServer } from "./api.ts";
import { resolveApiToken } from "./api-token.ts";
import { ensureSandboxContainer } from "./core/shell-runner.ts";
import { shellRunnerOptions } from "./ops/exec.ts";
import { ensureSkillDataDirs } from "./ops/skills.ts";
import { acquireLock, releaseLock } from "./core/lockfile.ts";
import { ensureRuntime, ensureHostSandboxLinks, RUNTIME_SUBDIRS, sharedDir, filesDir } from "./core/runtime.ts";
import { useRuntimePrompts } from "./agent/template.ts";
import { loadSchedulerSettings } from "./ops/scheduler-settings.ts";
import path from "node:path";

async function main() {
  const cfg = loadConfig();
  const log = new Logger(cfg.logDir);
  // Web 管理台保存过的调度间隔：先应用再建 App，重启后照旧生效
  loadSchedulerSettings(cfg, log);
  // 运行时内容（人设/提示词/话题库/汇报/附件）在仓库外：先保证目录在，再把模板目录指过去
  ensureRuntime(cfg, [...RUNTIME_SUBDIRS, "shared", "files", "business"]);
  log.info(`人设与提示词取自 ${useRuntimePrompts(cfg)}`);
  log.info(`沙盒根：${cfg.exec.dir}（/work），worker 汇报落点：${sharedDir(cfg)}`);
  // host 模式下没有 volume 挂载：exec.dir 不在运行时目录时，把 prompt/ topics/ 换成软链，
  // 否则她读的是运行时、写的是 exec.dir 里的陈旧副本，很快就分叉
  const linked = ensureHostSandboxLinks(cfg);
  if (linked.length) log.info(`宿主机模式已把沙盒子目录接到运行时：${linked.join("、")}`);
  // 主人名单：群聊里他说的话不 @ 也要回（hub 判唤醒、prompt 标 [主人] 都用它）
  setOwnerIds([...(cfg.adapters.matrix.ownerIds ?? [])]);
  if (cfg.llm.provider === "faux") throw new Error("正式服务不能使用 faux 桩模型；请在 config/local.json 设置 llm.provider/model");
  if (cfg.adapters.feishu.enabled) {
    const miss = missingEnv(["FEISHU_APP_ID", "FEISHU_APP_SECRET"]);
    if (miss.length) { log.error(`缺少环境变量：${miss.join(", ")}，退出`); process.exit(2); }
  }
  let model;
  try { model = await resolveModel(cfg); } catch (e) { log.error(`LLM 配置不可用：${(e as Error).message}`); process.exit(2); }

  // 单实例锁：两个进程同时连飞书会抢同一条消息、各推各的游标（10-23 踩过：孤儿进程活了 27 小时，
  // 表现成"图有时能看有时看不到""日志时有时无"）。实现见 core/lockfile.ts ——
  // 原子占锁（O_EXCL）、确认持有者真的是 rabbit-bot（防 pid 复用误判）、残锁自愈。
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
  // 技能约定：skills/<name>/SKILL.md 进 git，data/ 是运行时。空目录 clone 不下来，启动时补。
  const madeDirs = ensureSkillDataDirs(cfg);
  if (madeDirs.length) log.info(`补了 ${madeDirs.length} 个技能 data 目录`);
  if (cfg.adapters.feishu.enabled)
    app.hub.addAdapter(new FeishuAdapter({ appId: process.env.FEISHU_APP_ID!, appSecret: process.env.FEISHU_APP_SECRET!, domain: cfg.adapters.feishu.domain, fetchSenderName: cfg.adapters.feishu.fetchSenderName, reactions: cfg.adapters.feishu.reactions, logRawEmoji: cfg.adapters.feishu.logRawEmoji, emoji: app.emoji, media: { dir: path.join(cfg.dataDir, "media"), maxEdge: cfg.media.maxEdge, maxBytes: cfg.media.maxBytes } }, log));
  if (cfg.adapters.matrix.enabled && process.env.MATRIX_TOKEN)
    app.hub.addAdapter(
      new MatrixAdapter(
        {
          homeserver: cfg.adapters.matrix.homeserver,
          userId: cfg.adapters.matrix.userId,
          accessToken: process.env.MATRIX_TOKEN,
          stateFile: path.join(cfg.dataDir, "matrix-sync.json"),
          media: { dir: path.join(cfg.dataDir, "media"), maxEdge: cfg.media.maxEdge, maxBytes: cfg.media.maxBytes },
          filesDir: filesDir(cfg),
        },
        log,
      ),
    );
  else if (cfg.adapters.matrix.enabled) log.warn("adapters.matrix 开着但没有 MATRIX_TOKEN，跳过");

  // 测试池（platform=mock）：send 只记在内存里，不发任何真实 IM。
  // 测试注入走 INJECT_POOL=mock:test，这样她的回复不会落到主人的飞书。
  app.hub.addAdapter(new MockAdapter());

  let stopping = false;
  let injectSrv: Awaited<ReturnType<typeof startInjectServer>> = null;
  let apiSrv: Awaited<ReturnType<typeof startApiServer>> = null;
  const shutdown = async (sig: string) => {
    if (stopping) return; stopping = true;
    log.info(`收到 ${sig}，等待当前唤醒结束后退出`);
    const force = setTimeout(() => process.exit(1), 30_000); force.unref();
    if (injectSrv) await new Promise<void>((r) => injectSrv!.close(() => r()));
    if (apiSrv) await new Promise<void>((r) => apiSrv!.close(() => r()));
    await app.stop().catch((e) => log.error("退出异常", e));
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("unhandledRejection", (e) => log.error("unhandledRejection", e));
  await app.start();
  injectSrv = await startInjectServer({ cfg, hub: app.hub, store: app.store, log });

  // REST API：沙盒里的技能脚本靠它访问池/计划/记忆/沙盒文件。
  // 先起服务，再按 mode=docker 把容器拉起来（容器里拿到 RB_API_URL / RB_API_TOKEN）。
  try {
    const token = resolveApiToken(cfg);
    apiSrv = await startApiServer({
      cfg, store: app.store, log, token,
      scheduler: app.scheduler,
      enqueue: () => { app.queue.enqueue(makeWake("task-updated", [], "task updated")); },
    });
    if (cfg.exec.shell.enabled && cfg.exec.shell.mode === "docker") {
      const r = await ensureSandboxContainer(shellRunnerOptions(cfg));
      if (r.ok) log.info(`沙盒容器 ${cfg.exec.shell.container}：${r.message}`);
      else log.warn(`沙盒容器没起来：${r.message}（sb run 时会再试）`);
    }
  } catch (e) {
    log.error("api 启动失败（沙盒里的技能脚本会连不上）", e);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
