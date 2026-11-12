/**
 * 聊天池中枢：适配器 → 入池（去重、身份映射）→ 通知调度器；
 * 以及 send 工具用的“发送 → 等待确认 → 收集期间新消息”。
 */
import type { IMAdapter } from "../adapters/types.ts";
import type { Config } from "../config.ts";
import type { Store } from "./db.ts";
import { parseEmoji, type EmojiTable } from "./emoji.ts";
import { isOwnerId } from "./owners.ts";
import { waitBefore, visibleLen } from "./pacing.ts";
import type { RichPart } from "../adapters/types.ts";
import type { Logger } from "./logger.ts";
import type { Scheduler } from "./scheduler.ts";
import type { InboundMessage, StoredMessage } from "../types.ts";
import type { ProposeResult, SendReviewRequest } from "./send-review.ts";
import path from "node:path";

export interface SendOutcome {
  ok: boolean;
  error?: string;
  /** true = 已进审核队列，主人批准后才会真正发到目标聊天 */
  queuedForReview?: boolean;
  /** 审核序号（queuedForReview=true 时有值） */
  reviewId?: number;
  /** true = 没发出去，因为发之前来了新消息，把话原样退回去让她重新判断 */
  held?: boolean;
  /** held 时被压住的那句（原样） */
  heldText?: string;
  sentParts: { kind: "text" | "sticker"; content: string; msgId: string; confirmed: boolean }[];
  newMessages: StoredMessage[];
}

export interface RecallOutcome {
  ok: boolean;
  error?: string;
  /** 撤回的消息 id（失败时也有，方便定位） */
  msgId?: string;
  /** 被撤回消息的内容（失败时也有） */
  text?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Hub {
  private adapters = new Map<string, IMAdapter>();
  /** 投递节奏的基准：上一条发出的时刻和可见字数（见 core/pacing.ts） */
  private lastSendAt = 0;
  private lastSendLen = 0;
  scheduler: Scheduler | null = null;
  /** 审批闸门：入站先过它，命中的不进池、不进她的上下文（见 core/approval.ts） */
  approval?: { tryHandle(m: InboundMessage): boolean };
  /** 出站审核：这个池要不要审由 App 按配置实时判断；要审时先提交预览，贴 OK 才真正发 */
  review?: {
    shouldReview(poolId: string): boolean;
    propose(req: SendReviewRequest): Promise<ProposeResult>;
  };
  /** 每次 send 的回调（日志/测试）；seq 是最后一段消息的本地序号 */
  onSent?: (poolId: string, text: string, seq?: number) => void;
  /** 被 takeUnread 消费掉、但还没喂给模型的图片消息（send 的"期间新消息"会顺带把游标推过图片） */
  private pendingMedia: StoredMessage[] = [];

  constructor(private store: Store, private cfg: Config, private log: Logger, readonly emoji: EmojiTable) {}

  addAdapter(a: IMAdapter) { this.adapters.set(a.platform, a); }
  async startAdapters() {
    for (const a of this.adapters.values()) await a.start((m) => this.ingest(m));
  }
  async stopAdapters() { for (const a of this.adapters.values()) await a.stop(); }

  /** 入池；返回入库后的消息（重复则 null） */
  ingest(m: InboundMessage): StoredMessage | null {
    // 只有闸门明确认领的审批裁决才不进池；同一聊天里的正常消息照常入池
    if (this.approval?.tryHandle(m)) return null;
    const saved = this.store.insertMessage(m);
    if (!saved) {
      if (!m.from_self) this.log.info(`重复消息已忽略（平台重投？）${m.platform}:${m.msg_id}`);
      return null;
    }
    if (saved.from_self) return saved;
    const pool = this.store.getPool(saved.pool_id)!;
    // 群聊和私聊是两种节奏：
    //   私聊＝对话，消息进来就该醒（表情回复除外，等 tick 省 token）
    //   群聊＝默认潜水，攒到 tick 周期一起看；只有被 @ 才立刻看这一屏
    //          （"被点到名"是别人明确在跟你说话，等 tick 就错过了对话时机）
    //   主人没有特权：谁的消息都一样等 tick，标 [主人] 只是给她一个"这是谁"的线索
    const urgent = saved.media_type !== "reaction" && (pool.kind === "private" || saved.is_mention_me);
    const where = pool.kind === "private" ? "私聊" : saved.is_mention_me ? "群聊被@：立刻看" : "群聊：等 tick";
    this.log.info(`入池 ${saved.pool_id} #${saved.seq} ${saved.sender_name}: ${saved.text.slice(0, 60)}〔${where}〕`);
    this.scheduler?.onMessage(
      saved.pool_id,
      urgent,
      pool.kind === "private" ? "私聊新消息" : "群聊被@",
      pool.kind === "private" ? "private" : "group",
      pool.kind === "group" && saved.is_mention_me,
    );
    return saved;
  }

  /** 直接往某个聊天发一条系统通知（审批用）：不经过池、不走节奏、不入她的话 */
  async sendSystem(
    platform: string,
    chatId: string,
    text: string,
  ): Promise<{ ok: boolean; error?: string; msgId?: string }> {
    const adapter = this.adapters.get(platform);
    if (!adapter) return { ok: false, error: `平台 ${platform} 没有可用的适配器` };
    try {
      // msgId 要往上带：审批闸门靠它认「表情贴在哪一条上」
      const r = await adapter.sendText(chatId, text);
      return { ok: true, msgId: r?.msgId };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /** 收集所有池的未读并推进游标（send 返回值、唤醒时读池都走这里） */
  takeUnread(poolIds?: string[], opts: { excludeTask?: boolean } = {}): StoredMessage[] {
    const ids = poolIds ?? this.store.poolsWithUnread();
    const out: StoredMessage[] = [];
    for (const id of ids) {
      // 任务池事件只是进度，不是「他又说话了」：send 时不拿它打断正常对话
      if (opts.excludeTask && this.store.getPool(id)?.kind === "task") continue;
      const msgs = this.store.unread(id, this.cfg.context.maxUnreadPerPool);
      if (!msgs.length) continue;
      out.push(...msgs);
      // 图片消息额外留一份：send 的"期间新消息"会顺带把游标推过它，那一轮只拿到文字，
      // 不留档的话这张图永远不会进任何一轮 prompt
      for (const m of msgs) if (m.media_type === "image" && m.attachment) this.rememberPendingMedia(m);
      // 游标推进到池内最新（含被截断的旧消息，避免无限堆积）
      this.store.advanceCursor(id, Math.max(msgs[msgs.length - 1].seq, this.store.maxSeq(id)));
    }
    return out;
  }

  private rememberPendingMedia(m: StoredMessage) {
    if (this.pendingMedia.some((x) => x.seq === m.seq)) return;
    this.pendingMedia.push(m);
    if (this.pendingMedia.length > 20) this.pendingMedia.splice(0, this.pendingMedia.length - 20);
  }

  /** 取出还没给模型看过的图片消息（取完清空） */
  takePendingMedia(): StoredMessage[] {
    const out = this.pendingMedia;
    this.pendingMedia = [];
    return out;
  }

  /**
   * 按消息里的附件 id 主动下载远端文件（飞书文件默认不落盘）。
   * 下载成功后回写 attachment，后续再要直接返回本地路径。
   */
  async downloadAttachment(id: string): Promise<{ ok: boolean; path?: string; bytes?: number; name?: string; error?: string }> {
    const key = id.trim();
    if (!key) return { ok: false, error: "缺少附件 id" };
    const found = this.store.findAttachment(key);
    if (!found) return { ok: false, error: `没有这个附件 id：${key}（消息里会写成 file_xxx）` };
    const { message, attachment } = found;
    if (attachment.path) return { ok: true, path: attachment.path, bytes: attachment.bytes, name: path.basename(attachment.path) };
    const remote = attachment.remote;
    if (!remote) return { ok: false, error: "这个附件没有可下载的远端信息" };
    const adapter = this.adapters.get(message.platform);
    if (!adapter?.downloadRemote) return { ok: false, error: `平台 ${message.platform} 不支持主动下载附件` };
    try {
      const saved = await adapter.downloadRemote(remote);
      this.store.updateAttachment(message.seq, { ...attachment, path: saved.path, bytes: saved.bytes, remote: null });
      return { ok: true, path: saved.path, bytes: saved.bytes, name: path.basename(saved.path) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /**
   * 撤回自己发出的一条消息。不给 msgId 就撤这个池里最后一条自己发的。
   * 平台失败原因原样带回（权限、时限、已删除等），不要吞成 false。
   */
  async recall(poolRef: string, msgId?: string): Promise<RecallOutcome> {
    const pool = this.store.resolvePool(poolRef);
    if (!pool) return { ok: false, error: `未知的池 ${poolRef}` };
    const adapter = this.adapters.get(pool.platform);
    if (!adapter) return { ok: false, error: `平台 ${pool.platform} 没有可用的适配器` };
    if (!adapter.recall) return { ok: false, error: `平台 ${pool.platform} 不支持撤回消息` };

    const key = msgId?.trim();
    const target = key
      ? this.store.messageByMsgId(pool.platform, key)
      : this.store.lastSelfMessageRow(pool.pool_id);
    if (!target) return { ok: false, error: key ? `没有找到消息 ${key}` : "这个池里还没有你发过的消息" };
    if (target.pool_id !== pool.pool_id) return { ok: false, msgId: target.msg_id, error: `消息 ${target.msg_id} 不在池 ${poolRef} 里` };
    if (!target.from_self) return { ok: false, msgId: target.msg_id, text: target.text, error: "只能撤回自己发出的消息" };

    try {
      const r = await adapter.recall(pool.external_id, target.msg_id);
      if (!r.ok) return { ok: false, msgId: target.msg_id, text: target.text, error: r.error ?? "平台没有返回失败原因" };
      this.log.info(`已撤回 ${pool.pool_id} ${target.msg_id}: ${target.text.slice(0, 40)}`);
      return { ok: true, msgId: target.msg_id, text: target.text };
    } catch (e) {
      return { ok: false, msgId: target.msg_id, text: target.text, error: (e as Error).message };
    }
  }

  /** send(pool, content)：审核 → 表情解析 → 发送 → 等待约 1 秒确认 → 收集期间新消息 */
  async send(poolRef: string, content: string, opts: { internal?: boolean; reviewed?: boolean } = {}): Promise<SendOutcome> {
    const pool = this.store.resolvePool(poolRef);
    if (!pool) return { ok: false, error: `未知的池 ${poolRef}`, sentParts: [], newMessages: [] };
    const adapter = this.adapters.get(pool.platform);
    if (!adapter) return { ok: false, error: `平台 ${pool.platform} 没有可用的适配器`, sentParts: [], newMessages: [] };
    if (!content.trim()) return { ok: false, error: "内容为空", sentParts: [], newMessages: [] };

    // 节奏：想是一次想完的，发要一条一条发。系统提示不排队（那是通知，不是她说话）
    if (!opts.internal && this.cfg.send.pacing?.enabled) {
      const wait = waitBefore(this.lastSendLen, this.lastSendAt, Date.now());
      if (wait > 0) await sleep(wait);
    }

    // 这期间他要是又说话了，这一句就先压住不发。
    // 她是在「上一条消息」的基础上想好这几句的；人已经补了新信息，
    // 照着旧前提继续说是最像机器的一件事。原话退回去，让她看完再决定发不发、改不改。
    if (!opts.internal && !opts.reviewed) {
      const fresh = this.takeUnread(undefined, { excludeTask: true });
      if (fresh.length) {
        return { ok: false, held: true, heldText: content, error: "发之前来了新消息", sentParts: [], newMessages: fresh };
      }
    }

    // 出站审核：这里只把预览发到审批聊天，目标聊天一个字都还没收到。
    // 主人贴 OK 后 gate 会再调一次 send({ reviewed: true }) 真正发送。
    if (!opts.internal && !opts.reviewed && this.review?.shouldReview(pool.pool_id)) {
      const r = await this.review.propose({
        platform: pool.platform,
        chatId: pool.external_id,
        poolRef: pool.pool_id,
        poolTitle: pool.title,
        kind: pool.kind,
        content,
        deliver: async () => {
          const sent = await this.send(poolRef, content, { reviewed: true });
          return { ok: sent.ok, error: sent.error };
        },
      });
      if (r.queued) {
        return { ok: true, queuedForReview: true, reviewId: r.id, sentParts: [], newMessages: [] };
      }
      return { ok: false, error: r.error ?? "发送审核不可用，这条没有发", sentParts: [], newMessages: [] };
    }

    const parts: SendOutcome["sentParts"] = [];
    // 把片段组装成消息：文字+内置表情合成一条（富文本），表情包单独一条
    let rich: RichPart[] = [];
    const flush = async () => {
      if (!rich.length) return;
      const chunk = rich; rich = [];
      const asText = chunk.map((p) => (p.type === "text" ? p.text : `[emoji:${p.id}]`)).join("");
      if (chunk.some((p) => p.type === "emoji") && adapter.sendRich) {
        const r = await adapter.sendRich(pool.external_id, chunk);
        parts.push({ kind: "text", content: asText, msgId: r.msgId, confirmed: false });
      } else {
        const r = await adapter.sendText(pool.external_id, asText);
        parts.push({ kind: "text", content: asText, msgId: r.msgId, confirmed: false });
      }
    };
    try {
      for (const seg of parseEmoji(content, this.emoji)) {
        if (seg.type === "text") rich.push({ type: "text", text: seg.text });
        else if (seg.entry.sticker && adapter.sendSticker) {
          await flush();
          const r = await adapter.sendSticker(pool.external_id, seg.entry.sticker);
          parts.push({ kind: "sticker", content: `[emoji:${seg.id}]`, msgId: r.msgId, confirmed: false });
        } else if (seg.entry.feishu) rich.push({ type: "emoji", id: seg.id, key: seg.entry.feishu });
        else rich.push({ type: "text", text: `[emoji:${seg.id}]` });
      }
      await flush();
    } catch (e) {
      this.log.error(`发送失败 ${pool.pool_id}`, e);
      return { ok: false, error: (e as Error).message, sentParts: parts, newMessages: opts.internal || opts.reviewed ? [] : this.takeUnread(undefined, { excludeTask: true }) };
    }
    // 节奏的基准：这一条发出去的时刻和长度，决定下一条要等多久
    if (!opts.internal && parts.length) {
      this.lastSendAt = Date.now();
      this.lastSendLen = visibleLen(content);
    }

    await sleep(this.cfg.send.confirmWaitMs);
    let lastSeq = 0;
    for (const p of parts) {
      p.confirmed = adapter.confirm && (this.cfg.send.confirmViaApi || adapter.platform === "mock") ? await adapter.confirm(p.msgId) : true;
      // 自己发的消息也入池（from_self），保证池里是完整对话；
      // internal=true 的是系统提示（额度用尽等）：入库留痕，但 recentMessages 会排掉，不污染上下文
      const saved = this.store.insertMessage({
        platform: pool.platform, external_chat_id: pool.external_id, pool_kind: pool.kind, msg_id: p.msgId,
        sender_id: "self", sender_name: this.cfg.agent.name, ts: Date.now(), text: p.content, reply_to: null,
        mentions: [], is_mention_me: false, media_type: p.kind === "sticker" ? "sticker" : "text", from_self: true,
        internal: opts.internal === true,
      });
      if (saved) lastSeq = saved.seq;
    }
    this.scheduler?.markActive();
    this.onSent?.(pool.pool_id, content, lastSeq || undefined);
    // internal 的系统提示不能吃掉未读：它只是通知，用户的话还得等下次唤醒去读。
    // reviewed 是审核通过后的补发，此刻没有一轮 agent 在等返回值；吃掉未读会让新消息
    // 既没进下一轮 prompt、也不再触发唤醒。留着，交给调度器下一次唤醒去读。
    return { ok: true, sentParts: parts, newMessages: opts.internal || opts.reviewed ? [] : this.takeUnread(undefined, { excludeTask: true }) };
  }
}
