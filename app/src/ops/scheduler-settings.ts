/**
 * 调度设置的持久化：Web 管理台改完写 <dataDir>/run/scheduler.json，
 * 重启时在创建 App 之前把保存值覆盖回 cfg.scheduler。
 *
 * API / 前端按「秒」展示，这里和配置内部统一按毫秒。
 */
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";

export interface SchedulerSettings {
  privateWakeMs: number;
  groupWakeMs: number;
  taskWakeMs: number;
}

export const DEFAULT_SCHEDULER_SETTINGS: SchedulerSettings = {
  privateWakeMs: 5000,
  groupWakeMs: 180000,
  taskWakeMs: 180000,
};

const MIN_MS = 1000;
const MAX_MS = 86400000;

function settingsPath(cfg: Config): string {
  return path.join(cfg.dataDir, "run", "scheduler.json");
}

/** 当前生效值（配置里缺省时用默认值） */
export function effectiveSchedulerSettings(cfg: Config): SchedulerSettings {
  const s = cfg.scheduler;
  return {
    privateWakeMs: s.privateWakeMs ?? DEFAULT_SCHEDULER_SETTINGS.privateWakeMs,
    groupWakeMs: s.tickMs ?? DEFAULT_SCHEDULER_SETTINGS.groupWakeMs,
    taskWakeMs: s.taskTickMs ?? DEFAULT_SCHEDULER_SETTINGS.taskWakeMs,
  };
}

function pickMs(raw: unknown, key: keyof SchedulerSettings): number {
  const v = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>)[key] : undefined;
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new Error(`${key} 必须是整数（毫秒）`);
  }
  if (v < MIN_MS || v > MAX_MS) {
    throw new Error(`${key} 必须在 ${MIN_MS}~${MAX_MS} 毫秒之间`);
  }
  return v;
}

/** 校验并规范成三个毫秒值；错误里带字段名，供 API 直接回 400 */
export function validateSchedulerSettings(raw: unknown): SchedulerSettings {
  return {
    privateWakeMs: pickMs(raw, "privateWakeMs"),
    groupWakeMs: pickMs(raw, "groupWakeMs"),
    taskWakeMs: pickMs(raw, "taskWakeMs"),
  };
}

/** 写回配置：私聊延迟、群聊 tick、任务事件 tick */
export function applySchedulerSettings(cfg: Config, s: SchedulerSettings): void {
  cfg.scheduler.privateWakeMs = s.privateWakeMs;
  cfg.scheduler.tickMs = s.groupWakeMs;
  cfg.scheduler.taskTickMs = s.taskWakeMs;
}

/** 启动时读保存值并应用；文件不存在跳过，坏文件只 warn */
export function loadSchedulerSettings(
  cfg: Config,
  log?: { warn: (msg: string) => void },
): SchedulerSettings | null {
  const file = settingsPath(cfg);
  if (!fs.existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    log?.warn(`调度设置读取失败（${file}）：${(e as Error).message}`);
    return null;
  }
  try {
    const current = effectiveSchedulerSettings(cfg);
    const source = raw !== null && typeof raw === "object" ? raw as Record<string, unknown> : {};
    // 旧版 scheduler.json 可能缺 taskWakeMs：缺哪个就用当前生效值（默认值）补上
    const settings = validateSchedulerSettings({
      privateWakeMs: source.privateWakeMs ?? current.privateWakeMs,
      groupWakeMs: source.groupWakeMs ?? current.groupWakeMs,
      taskWakeMs: source.taskWakeMs ?? current.taskWakeMs,
    });
    applySchedulerSettings(cfg, settings);
    return settings;
  } catch (e) {
    log?.warn(`调度设置无效（${file}）：${(e as Error).message}`);
    return null;
  }
}

/** 写文件；目录不存在就建。失败抛出，由调用方回 500 且不应用 */
export function saveSchedulerSettings(cfg: Config, s: SchedulerSettings): void {
  const file = settingsPath(cfg);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    privateWakeMs: s.privateWakeMs,
    groupWakeMs: s.groupWakeMs,
    taskWakeMs: s.taskWakeMs,
    updated_at: new Date().toISOString(),
  }, null, 2) + "\n", "utf8");
}
