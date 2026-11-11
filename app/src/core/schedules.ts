/**
 * 日程：到点把一段话交给 agent 的定时唤醒。
 *
 * 两种写法：
 *   - cron：重复日程（每天 / 每周 / 自定义表达式），最小粒度 1 分钟；
 *   - delay：创建后 N 分钟一次性触发。
 *
 * 不追求 100% 准时：由 Scheduler 的日程 tick 轮询到点，事件写进共用的常驻日程池，
 * 再交给运行队列串行处理。单条日程自己的周期不能低于 1 分钟（cron 校验）。
 */
import crypto from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import type { Schedule, ScheduleKind, ScheduleStatus, StoredMessage } from "../types.ts";
import type { Store } from "./db.ts";
import { fmtLocal } from "./time.ts";

/** 所有日程共用一个常驻池：到点事件只追加，不清空、不归档。 */
export const SCHEDULE_POOL_PLATFORM = "schedule";
export const SCHEDULE_POOL_EXTERNAL_ID = "schedule";
export const SCHEDULE_POOL_TITLE = "日程";

export function ensureSchedulePool(store: Store): string {
  return store.upsertPool(
    SCHEDULE_POOL_PLATFORM, SCHEDULE_POOL_EXTERNAL_ID, "schedule", SCHEDULE_POOL_TITLE,
  ).pool_id;
}

/** 到点事件写进常驻日程池；normal 消息，tick 正常能看到。 */
export function appendScheduleEvent(store: Store, s: Schedule, firedAt: number): StoredMessage {
  ensureSchedulePool(store);
  const stored = store.insertMessage({
    platform: SCHEDULE_POOL_PLATFORM,
    external_chat_id: SCHEDULE_POOL_EXTERNAL_ID,
    pool_kind: "schedule",
    pool_title: SCHEDULE_POOL_TITLE,
    msg_id: `schedule-${s.id}-${firedAt}-${crypto.randomUUID().slice(0, 8)}`,
    sender_id: "schedule",
    sender_name: "日程",
    ts: firedAt,
    text: `#${s.id}「${s.title}」\n${s.content}`,
    reply_to: null,
    mentions: [],
    is_mention_me: false,
    media_type: "text",
    from_self: false,
  });
  if (!stored) throw new Error(`日程 #${s.id} 的事件写入失败`);
  return stored;
}

export const MIN_SCHEDULE_GAP_MS = 60_000;
export const SCHEDULE_STATUSES: ScheduleStatus[] = ["active", "cancelled", "done"];
export function isScheduleStatus(v: string): v is ScheduleStatus {
  return (SCHEDULE_STATUSES as string[]).includes(v);
}

export interface ScheduleInput {
  title?: unknown;
  content?: unknown;
  kind?: unknown;
  cron?: unknown;
  delay_minutes?: unknown;
}

export interface NormalizedSchedule {
  title: string;
  content: string;
  kind: ScheduleKind;
  cron: string | null;
  delay_minutes: number | null;
  next_at: number;
}

function clean(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function positiveInt(v: unknown, name: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} 要是正整数`);
  return n;
}

/** 解析 cron 并算出下一次触发；拒绝 30 秒级表达式（日程最小间隔 1 分钟）。 */
export function nextCronAt(expr: string, from: number, tz: string): number {
  const raw = String(expr ?? "").trim();
  if (!raw) throw new Error("缺少 cron 表达式");
  let it;
  try {
    it = CronExpressionParser.parse(raw, { currentDate: new Date(from), tz });
  } catch (e) {
    throw new Error(`cron 表达式看不懂：${(e as Error).message}`);
  }
  const first = it.next().getTime();
  const second = it.next().getTime();
  if (!(first > from)) throw new Error("cron 没有下一次触发时间");
  if (second - first < MIN_SCHEDULE_GAP_MS) {
    throw new Error("cron 触发间隔不能低于 1 分钟（秒位请写 0，或用 5 段式表达式）");
  }
  return first;
}

export function normalizeScheduleInput(raw: ScheduleInput, now: number, tz: string): NormalizedSchedule {
  const content = clean(raw.content);
  if (!content) throw new Error("缺少 content：到点要带给 agent 的话");
  const title = clean(raw.title) || content.slice(0, 40);
  const cron = clean(raw.cron);
  const inferred = cron ? "cron" : raw.delay_minutes !== undefined && raw.delay_minutes !== null ? "delay" : "";
  const kindRaw = clean(raw.kind).toLowerCase() || inferred;

  if (kindRaw === "cron") {
    if (!cron) throw new Error("cron 日程要给 cron 表达式");
    return {
      title, content, kind: "cron", cron, delay_minutes: null,
      next_at: nextCronAt(cron, now, tz),
    };
  }
  if (kindRaw === "delay") {
    const delay = positiveInt(raw.delay_minutes, "delay_minutes");
    return {
      title, content, kind: "delay", cron: null, delay_minutes: delay,
      next_at: now + delay * 60_000,
    };
  }
  throw new Error("kind 只能是 cron（重复）或 delay（N 分钟后一次）");
}

export function createSchedule(store: Store, input: ScheduleInput, now: number, tz: string): Schedule {
  const s = normalizeScheduleInput(input, now, tz);
  return store.insertSchedule({ ...s, status: "active", now });
}

/** 触发后推进下一条；cron 会按当前时间重新算，delay 直接结束。返回更新后的日程。 */
export function fireSchedule(store: Store, s: Schedule, now: number, tz: string): Schedule | undefined {
  if (s.kind === "cron" && s.cron) {
    let next: number | null = null;
    try {
      next = nextCronAt(s.cron, now, tz);
    } catch {
      next = null;
    }
    const status: ScheduleStatus = next === null ? "done" : "active";
    store.advanceSchedule(s.id, s.next_at, next, now, status);
  } else {
    store.advanceSchedule(s.id, s.next_at, null, now, "done");
  }
  return store.getSchedule(s.id);
}

export function formatSchedule(s: Schedule, tz: string) {
  return {
    id: s.id,
    title: s.title,
    content: s.content,
    kind: s.kind,
    cron: s.cron,
    delay_minutes: s.delay_minutes,
    status: s.status,
    next_at: s.next_at,
    next_at_local: fmtLocal(s.next_at, tz),
    last_fired_at: s.last_fired_at,
    last_fired_at_local: s.last_fired_at === null ? null : fmtLocal(s.last_fired_at, tz),
    created_at: s.created_at,
    created_at_local: fmtLocal(s.created_at, tz),
  };
}
