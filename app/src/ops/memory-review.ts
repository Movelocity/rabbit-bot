/**
 * 后台记忆梳理：设置与计数状态。
 *
 * 只有记忆是后台自动的；技能和业务关系都走主动（UFA 读 ufa-maintenance 技能后决定）。
 * 设置和状态放在专属运行时目录（默认 ~/.config/rabbit-bot/runtime/）。
 */
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";
import { runtimePath } from "../core/runtime.ts";

export interface MemoryReviewSettings {
  /** 总开关；默认关 */
  enabled: boolean;
  /** 每多少个用户回合触发一次 */
  everyTurns: number;
  /** 两次之间的最小间隔（秒） */
  minIntervalSec: number;
}

export interface MemoryReviewState {
  turns: number;
  lastReviewAt: number;
  lastOutcome: string;
}

export const DEFAULT_MEMORY_REVIEW_SETTINGS: MemoryReviewSettings = {
  enabled: false,
  everyTurns: 10,
  minIntervalSec: 300,
};

export const EMPTY_MEMORY_REVIEW_STATE: MemoryReviewState = {
  turns: 0,
  lastReviewAt: 0,
  lastOutcome: "",
};

function settingsFile(cfg: Config): string {
  return runtimePath(cfg, "memory-review.json");
}

function stateFile(cfg: Config): string {
  return runtimePath(cfg, "memory-review-state.json");
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function atomicWrite(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
}

function pickInt(raw: Record<string, unknown>, key: string, min: number, max: number, fallback: number): number {
  const v = raw[key];
  if (v === undefined || v === null) return fallback;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${key} 必须是 ${min}~${max} 的整数`);
  return n;
}

export function effectiveMemoryReviewSettings(cfg: Config): MemoryReviewSettings {
  const raw = readJson(settingsFile(cfg));
  if (!raw) return { ...DEFAULT_MEMORY_REVIEW_SETTINGS };
  const base = DEFAULT_MEMORY_REVIEW_SETTINGS;
  try {
    return {
      enabled: raw.enabled === true,
      everyTurns: pickInt(raw, "everyTurns", 1, 1000, base.everyTurns),
      minIntervalSec: pickInt(raw, "minIntervalSec", 30, 86400, base.minIntervalSec),
    };
  } catch {
    return { ...base };
  }
}

export function validateMemoryReviewSettings(raw: unknown): MemoryReviewSettings {
  if (!raw || typeof raw !== "object") throw new Error("设置要是一个对象");
  const x = raw as Record<string, unknown>;
  const base = DEFAULT_MEMORY_REVIEW_SETTINGS;
  return {
    enabled: x.enabled === true,
    everyTurns: pickInt(x, "everyTurns", 1, 1000, base.everyTurns),
    minIntervalSec: pickInt(x, "minIntervalSec", 30, 86400, base.minIntervalSec),
  };
}

export function saveMemoryReviewSettings(cfg: Config, s: MemoryReviewSettings): void {
  atomicWrite(settingsFile(cfg), { ...s, updated_at: new Date().toISOString() });
}

export function loadMemoryReviewState(cfg: Config): MemoryReviewState {
  const raw = readJson(stateFile(cfg));
  if (!raw) return { ...EMPTY_MEMORY_REVIEW_STATE };
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  return {
    turns: num(raw.turns),
    lastReviewAt: num(raw.lastReviewAt),
    lastOutcome: typeof raw.lastOutcome === "string" ? raw.lastOutcome : "",
  };
}

export function saveMemoryReviewState(cfg: Config, s: MemoryReviewState): void {
  atomicWrite(stateFile(cfg), s);
}

/** 纯函数：现在该不该跑一次记忆梳理。 */
export function memoryReviewDue(settings: MemoryReviewSettings, state: MemoryReviewState, now: number): boolean {
  if (!settings.enabled) return false;
  if (now - state.lastReviewAt < settings.minIntervalSec * 1000) return false;
  return state.turns >= settings.everyTurns;
}
