/**
 * 任务池：一条任务一个池，WA 的领取/进度/完成/失败/权限申请都写成池里的消息。
 *
 * 这样 UFA 不用另造一套「进度面板」，直接按读聊天的方式读时间戳就够了；
 * 外部 WA 只需要通过回环 API 提交反馈，不需要知道任务池怎么建。
 */
import crypto from "node:crypto";
import type { Store } from "./db.ts";
import { ensureTaskPool } from "./tasks.ts";
import { fmtLocal } from "./time.ts";

export interface AppendTaskEventInput {
  text: string;
  sender: string;
  senderName?: string;
  /** 测试/回放注入「现在」；默认 Date.now() */
  ts?: number;
}

export interface TaskEvent {
  seq: number;
  ts: number;
  local: string;
  sender: string;
  text: string;
}

function requireTaskId(taskId: unknown): number {
  const id = Number(taskId);
  if (!Number.isInteger(id) || id <= 0) throw new Error("task_id 要是正整数");
  return id;
}

/** 写一条事件；任务不存在抛错，没有池就补一个。 */
export function appendTaskEvent(store: Store, taskId: number, input: AppendTaskEventInput): TaskEvent {
  const id = requireTaskId(taskId);
  const text = String(input.text ?? "").trim();
  if (!text) throw new Error("事件内容不能为空");
  const sender = String(input.sender ?? "").trim() || "task";
  const senderName = String(input.senderName ?? "").trim() || sender;
  const ts = input.ts ?? Date.now();

  const task = ensureTaskPool(store, id);
  const msgId = `task-${id}-${ts}-${crypto.randomUUID().slice(0, 8)}`;
  const stored = store.insertMessage({
    platform: "task",
    external_chat_id: `task:${id}`,
    pool_kind: "task",
    pool_title: `任务 #${id}`,
    msg_id: msgId,
    sender_id: sender,
    sender_name: senderName,
    ts,
    text,
    reply_to: null,
    mentions: [],
    is_mention_me: false,
    media_type: "text",
    from_self: false,
  });
  if (!stored) throw new Error(`任务 #${id} 的事件写入失败`);
  return { seq: stored.seq, ts, local: fmtLocal(ts), sender: senderName, text };
}

export interface ListTaskEventsOptions {
  /** 最近 n 条（仍然按时间正序返回） */
  limit?: number;
}

/** 按时间正序读任务池；任务不存在抛错，没有池就补一个。 */
export function listTaskEvents(store: Store, taskId: number, opts: ListTaskEventsOptions = {}): TaskEvent[] {
  const id = requireTaskId(taskId);
  const task = ensureTaskPool(store, id);
  const toEvent = (r: any): TaskEvent => ({
    seq: r.seq,
    ts: r.ts,
    local: fmtLocal(r.ts),
    sender: r.sender_name,
    text: r.text,
  });

  const n = opts.limit === undefined ? undefined : Math.floor(Number(opts.limit));
  if (n !== undefined && Number.isFinite(n) && n > 0) {
    const rows = store.db.prepare(
      "SELECT * FROM messages WHERE pool_id=? ORDER BY seq DESC LIMIT ?",
    ).all(task.task_pool_id, n) as any[];
    return rows.reverse().map(toEvent);
  }
  const rows = store.db.prepare(
    "SELECT * FROM messages WHERE pool_id=? ORDER BY seq ASC",
  ).all(task.task_pool_id) as any[];
  return rows.map(toEvent);
}
