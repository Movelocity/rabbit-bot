/**
 * 聊天池中枢：适配器 → 入池（去重、身份映射）→ 通知调度器；
 * 以及 send 工具用的“发送 → 等待确认 → 收集期间新消息”。
 */
import type { IMAdapter } from "../adapters/types.ts";
import type { Config } from "../config.ts";
import type { Store } from "./db.ts";
import { parseEmoji } from "./emoji.ts";
import type { Logger } from "./logger.ts";
import type { Scheduler } from "./scheduler.ts";
import type { InboundMessage, StoredMessage } from "../types.ts";

export interface SendOutcome {
  ok: boolean;
  error?: string;
  sentParts: { kind: "text" | "sticker"; content: string; msgId: string; confirmed: boolean }[];
  newMessages: StoredMessage[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Hub {
  private adapters = new Map<string, IMAdapter>();
  scheduler: Scheduler | null = null;
  /** 每次 send 的回调（日志/测试） */
  onSent?: (poolId: string, text: string) => void;

  constructor(private store: Store, private cfg: Config, private log: Logger) {}

  addAdapter(a: IMAdapter) { this.adapters.set(a.platform, a); }
  async startAdapters() {
    for (const a of this.adapters.values()) await a.start((m) => this.ingest(m));
  }
  async stopAdapters() { for (const a of this.adapters.values()) await a.stop(); }

  /** 入池；返回入库后的消息（重复则 null） */
  ingest(m: InboundMessage): StoredMessage | null {
    const saved = this.store.insertMessage(m);
    if (!saved) return null;
    if (saved.from_self) return saved;
    const pool = this.store.getPool(saved.pool_id)!;
    const urgent = pool.kind === "private" || saved.is_mention_me;
    this.log.info(`入池 ${saved.pool_id} #${saved.seq} ${saved.sender_name}: ${saved.text.slice(0, 60)}${urgent ? " [唤醒]" : ""}`);
    this.scheduler?.onMessage(saved.pool_id, urgent, pool.kind === "private" ? "私聊新消息" : "群聊被@");
    return saved;
  }

  /** 收集所有池的未读并推进游标（send 返回值、唤醒时读池都走这里） */
  takeUnread(poolIds?: string[]): StoredMessage[] {
    const ids = poolIds ?? this.store.poolsWithUnread();
    const out: StoredMessage[] = [];
    for (const id of ids) {
      const msgs = this.store.unread(id, this.cfg.context.maxUnreadPerPool);
      if (!msgs.length) continue;
      out.push(...msgs);
      // 游标推进到池内最新（含被截断的旧消息，避免无限堆积）
      this.store.advanceCursor(id, Math.max(msgs[msgs.length - 1].seq, this.store.maxSeq(id)));
    }
    return out;
  }

  /** send(pool, content)：表情解析 → 发送 → 等待约 1 秒确认 → 收集期间新消息 */
  async send(poolRef: string, content: string): Promise<SendOutcome> {
    const pool = this.store.resolvePool(poolRef);
    if (!pool) return { ok: false, error: `未知的池 ${poolRef}`, sentParts: [], newMessages: [] };
    const adapter = this.adapters.get(pool.platform);
    if (!adapter) return { ok: false, error: `平台 ${pool.platform} 没有可用的适配器`, sentParts: [], newMessages: [] };
    if (!content.trim()) return { ok: false, error: "内容为空", sentParts: [], newMessages: [] };

    const parts: SendOutcome["sentParts"] = [];
    try {
      for (const seg of parseEmoji(content, this.cfg.emoji.map)) {
        if (seg.type === "emoji" && seg.target.sticker && adapter.sendSticker) {
          const r = await adapter.sendSticker(pool.external_id, seg.target.sticker);
          parts.push({ kind: "sticker", content: `[emoji:${seg.id}]`, msgId: r.msgId, confirmed: false });
        } else {
          const text = seg.type === "text" ? seg.text : `[emoji:${seg.id}]`;
          const r = await adapter.sendText(pool.external_id, text);
          parts.push({ kind: "text", content: text, msgId: r.msgId, confirmed: false });
        }
      }
    } catch (e) {
      this.log.error(`发送失败 ${pool.pool_id}`, e);
      return { ok: false, error: (e as Error).message, sentParts: parts, newMessages: this.takeUnread() };
    }

    await sleep(this.cfg.send.confirmWaitMs);
    for (const p of parts) {
      p.confirmed = adapter.confirm && (this.cfg.send.confirmViaApi || adapter.platform === "mock") ? await adapter.confirm(p.msgId) : true;
      // 自己发的消息也入池（from_self），保证池里是完整对话
      this.store.insertMessage({
        platform: pool.platform, external_chat_id: pool.external_id, pool_kind: pool.kind, msg_id: p.msgId,
        sender_id: "self", sender_name: this.cfg.agent.name, ts: Date.now(), text: p.content, reply_to: null,
        mentions: [], is_mention_me: false, media_type: p.kind === "sticker" ? "sticker" : "text", from_self: true,
      });
    }
    this.scheduler?.markActive();
    this.onSent?.(pool.pool_id, content);
    return { ok: true, sentParts: parts, newMessages: this.takeUnread() };
  }
}
