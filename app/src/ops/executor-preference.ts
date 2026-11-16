/**
 * 默认 worker 偏好：Web 设置里选完后写 <dataDir>/run/executor.json，
 * 重启时在创建 App 之前覆盖回 cfg.tasks.preferredExecutor。
 *
 * 只影响“建任务时没显式指定 executor”的情况；已有任务和显式指定的 executor 不变。
 */
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";
import { DEFAULT_EXECUTOR, isExecutor, normalizeExecutor, type Executor } from "../core/executor.ts";

const FILE = "executor.json";

function settingsPath(cfg: Config): string {
  return path.join(cfg.dataDir, "run", FILE);
}

/** 当前生效的默认 worker；未配置或值非法时回退 opencode。 */
export function effectiveExecutorPreference(cfg: Config): Executor {
  return normalizeExecutor(cfg.tasks?.preferredExecutor);
}

/** 启动时读保存值并应用；文件不存在跳过，坏文件只 warn。 */
export function loadExecutorPreference(cfg: Config, log?: { warn: (msg: string) => void }): Executor {
  const file = settingsPath(cfg);
  if (!fs.existsSync(file)) return effectiveExecutorPreference(cfg);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    log?.warn(`默认 worker 偏好读取失败（${file}）：${(e as Error).message}`);
    return effectiveExecutorPreference(cfg);
  }
  const value = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>).executor : undefined;
  if (!isExecutor(value)) {
    log?.warn(`默认 worker 偏好无效（${file}）：${JSON.stringify(value)}，沿用 ${effectiveExecutorPreference(cfg)}`);
    return effectiveExecutorPreference(cfg);
  }
  cfg.tasks = { ...(cfg.tasks ?? {}), preferredExecutor: value };
  return value;
}

/** 保存偏好并更新 cfg；调用方负责先把值校验成 Executor。 */
export function saveExecutorPreference(cfg: Config, executor: Executor): Executor {
  const value = executor || DEFAULT_EXECUTOR;
  cfg.tasks = { ...(cfg.tasks ?? {}), preferredExecutor: value };
  const file = settingsPath(cfg);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    executor: value,
    updated_at: new Date().toISOString(),
  }, null, 2) + "\n", "utf8");
  return value;
}
