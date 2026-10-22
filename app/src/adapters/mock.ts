/** 本地 mock 适配器：模拟器和测试用。inject() 模拟用户发言，sent 记录 Agent 发出的内容。 */
import type { IMAdapter, SendResult } from "./types.ts";
import type { InboundMessage, PoolKind } from "../types.ts";

export interface MockSent { chat: string; kind: "text" | "sticker"; content: string; msgId: string; ts: number }

export class MockAdapter implements IMAdapter {
  readonly platform = "mock" as const;
  sent: MockSent[] = [];
  private sink: ((m: InboundMessage) => void) | null = null;
  private n = 0;
  onSent?: (s: MockSent) => void;
  /** 发送后延迟“出现在聊天里”的毫秒数；-1 表示永不出现（测试确认失败） */
  deliveryDelayMs = 0;
  private delivered = new Set<string>();
  readonly selfId = "bot";

  async start(sink: (m: InboundMessage) => void) { this.sink = sink; }
  async stop() { this.sink = null; }

  inject(opts: { chat: string; kind: PoolKind; from: string; name?: string; text: string; mentionMe?: boolean; media?: InboundMessage["media_type"]; ts?: number; title?: string }) {
    if (!this.sink) throw new Error("mock adapter not started");
    const m: InboundMessage = {
      platform: "mock", external_chat_id: opts.chat, pool_kind: opts.kind, pool_title: opts.title ?? opts.chat,
      msg_id: `in-${++this.n}`, sender_id: opts.from, sender_name: opts.name ?? opts.from, ts: opts.ts ?? Date.now(),
      text: opts.text, reply_to: null, mentions: opts.mentionMe ? [this.selfId] : [], is_mention_me: !!opts.mentionMe,
      media_type: opts.media ?? "text",
    };
    this.sink(m);
    return m;
  }

  private record(chat: string, kind: "text" | "sticker", content: string): SendResult {
    const s: MockSent = { chat, kind, content, msgId: `out-${++this.n}`, ts: Date.now() };
    this.sent.push(s);
    if (this.deliveryDelayMs >= 0) setTimeout(() => this.delivered.add(s.msgId), this.deliveryDelayMs);
    this.onSent?.(s);
    return { msgId: s.msgId };
  }
  async sendText(chat: string, text: string) { return this.record(chat, "text", text); }
  async sendSticker(chat: string, key: string) { return this.record(chat, "sticker", key); }
  async confirm(msgId: string) { return this.delivered.has(msgId); }
}
