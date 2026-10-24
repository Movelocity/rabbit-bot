export type Platform = "feishu" | "qq" | "mock";
export type PoolKind = "private" | "group";
export type MediaType = "text" | "image" | "audio" | "file" | "sticker" | "video" | "reaction" | "other";

/** 落到本地的一张图片（已压缩）。path 是绝对路径，喂模型时读成 base64。 */
export interface Attachment {
  path: string;
  mime: string;
  width: number;
  height: number;
  bytes: number;
}

/** 统一消息字段（需求 §2） */
export interface PoolMessage {
  pool_id: string;
  platform: Platform;
  msg_id: string;
  sender_id: string; // 平台账号 id
  sender_name: string;
  ts: number; // ms epoch
  text: string;
  reply_to: string | null;
  mentions: string[]; // 被 @ 的平台账号 id
  is_mention_me: boolean;
  media_type: MediaType;
  /** 图片消息落盘后的信息（非图片为空） */
  attachment?: Attachment | null;
  /** 是否为本 Agent 自己发出的消息 */
  from_self?: boolean;
}

export interface StoredMessage extends PoolMessage {
  seq: number; // 自增，游标基于它
  user_id: string | null; // 身份映射后的统一 user_id
}

export interface Pool {
  pool_id: string;
  platform: Platform;
  external_id: string; // 飞书 chat_id 等
  kind: PoolKind;
  title: string;
}

/** 适配器把平台消息转成这个结构交给池 */
export interface InboundMessage extends Omit<PoolMessage, "pool_id"> {
  external_chat_id: string;
  pool_kind: PoolKind;
  pool_title?: string;
}

export type WakeType = "tick" | "message" | "plan";
export interface Wake {
  type: WakeType;
  pools: Set<string>; // 触发的池
  planFires: { planId: number; fireTs: number }[];
  reasons: string[];
  enqueuedAt: number;
}

export type PlanStatus = "pending" | "done" | "cancelled" | "expired";
export interface Plan {
  id: number;
  title: string;
  content: string;
  pool_id: string | null;
  schedule_kind: "once" | "cron" | "none";
  schedule: string | null; // ISO 时间或 cron 表达式
  status: PlanStatus;
  expires_at: number | null;
  created_at: number;
}

export type MemoryScope = "pool" | "private" | "group" | "all";
