export type Platform = "feishu" | "mock" | "matrix" | "task";
export type PoolKind = "private" | "group" | "task";
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
  /** 表情回复指向的事件 id（只有 media_type="reaction" 时有值） */
  reaction_to?: string | null;
  /** 表情原始 key（飞书 emoji_type / Matrix 的 key），审批只认 OK / No */
  reaction_key?: string | null;
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
  /** 归档 = 不再出现在默认列表、不参与唤醒/主动开口；来新消息会自动解档 */
  archived: boolean;
}

/** 适配器把平台消息转成这个结构交给池 */
export interface InboundMessage extends Omit<PoolMessage, "pool_id"> {
  external_chat_id: string;
  pool_kind: PoolKind;
  pool_title?: string;
}

export type WakeType = "tick" | "message" | "plan" | "task-updated";
export interface Wake {
  type: WakeType;
  pools: Set<string>; // 触发的池
  planFires: { planId: number; fireTs: number }[];
  /** 水位退潮到档：可以自己找话题开口，也可以不发 */
  proactive?: { pool: string | null; stage: number; a: number; peak: number; sessionTs: number; detail: string }[];
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
  /** 锚点档位：L0 日期 / L1 跟进到期 / L2 普通关心；NULL 按 L2 处理 */
  anchor_kind?: AnchorKind | null;
  /** 排这条计划时的理由，唤醒剧本里会用 */
  why?: string | null;
}

export type AnchorKind = "L0" | "L1" | "L2";

/** 计划看板（md 文件）：一条计划一张卡，最新实现，和旧 plans 表无关。 */
export type BoardStatus = "active" | "done" | "archived";
export interface BoardGoal {
  text: string;
  done: boolean;
}
export interface BoardProgress {
  at: number | null;
  at_local: string | null;
  text: string;
}
export interface Board {
  slug: string;
  title: string;
  status: BoardStatus;
  pool: string | null;
  tags: string[];
  background: string;
  goals: BoardGoal[];
  goals_total: number;
  goals_done: number;
  progress: BoardProgress[];
  created_at: number | null;
  created_at_local: string | null;
  updated_at: number | null;
  updated_at_local: string | null;
  path: string;
}

export type MemoryScope = "pool" | "private" | "group" | "all";
