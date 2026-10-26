/**
 * 飞书适配器：官方 @larksuiteoapi/node-sdk，长连接（WebSocket）事件模式，无需公网回调地址。
 * 需要环境变量 FEISHU_APP_ID / FEISHU_APP_SECRET。
 * 需在开发者后台开通：机器人能力；事件 im.message.receive_v1（订阅方式选“长连接”）；
 * 权限：im:message（收发消息）、im:message.group_at_msg（群 @）、im:message.group_msg（可选：读群里所有消息）、
 *       im:message.p2p_msg（私聊）、im:chat:readonly（群名，可选）、contact:user.base:readonly（用户名，可选）。
 * 表情回复（可选）：事件 im.message.reaction.created_v1 + 权限 im:message.reactions:read 或 im:message:readonly。
 * 表情：出站含内置表情时发富文本 post（emotion 元素）；入站 emotion / 文本 [名字] 统一转成 [emoji:中文id]。
 */
import * as lark from "@larksuiteoapi/node-sdk";
import type { IMAdapter, RichPart, SendResult } from "./types.ts";
import { inboundEmojiText, type EmojiTable } from "../core/emoji.ts";
import type { InboundMessage, MediaType, Attachment } from "../types.ts";
import type { Logger } from "../core/logger.ts";
import { saveImage, type MediaOptions } from "../core/media.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface FeishuOptions { appId: string; appSecret: string; domain: "feishu" | "lark"; fetchSenderName: boolean; reactions?: boolean; logRawEmoji?: boolean; emoji?: EmojiTable; media?: MediaOptions }

/** 从 image / post 消息里取第一张图的 image_key；取不到返回 null。 */
export function imageKeyOf(msgType: string, content: string): string | null {
  let obj: any = {};
  try { obj = JSON.parse(content); } catch { return null; }
  if (msgType === "image") return typeof obj.image_key === "string" ? obj.image_key : null;
  if (msgType === "post") {
    const body = obj.content ? obj : (obj.zh_cn ?? obj.en_us ?? Object.values(obj)[0] ?? {});
    for (const line of (body as any).content ?? []) for (const el of line ?? []) if (el?.tag === "img" && el.image_key) return el.image_key;
  }
  return null;
}

const PLACEHOLDER: Record<string, [MediaType, string]> = {
  image: ["image", "[图片]"], audio: ["audio", "[语音]"], media: ["video", "[视频]"], file: ["file", "[文件]"],
  sticker: ["sticker", "[表情包]"], share_chat: ["other", "[群名片]"], share_user: ["other", "[个人名片]"],
  location: ["other", "[位置]"], video_chat: ["other", "[视频会议]"], merge_forward: ["other", "[合并转发]"],
};

/** 文字 + 表情片段 → 飞书富文本 post 内容（按换行分段）。导出以便测试。 */
export function buildFeishuPost(parts: RichPart[]): { zh_cn: { content: object[][] } } {
  const lines: object[][] = [[]];
  for (const p of parts) {
    if (p.type === "emoji") { lines[lines.length - 1].push({ tag: "emotion", emoji_type: p.key }); continue; }
    p.text.split("\n").forEach((seg, i) => {
      if (i > 0) lines.push([]);
      if (seg) lines[lines.length - 1].push({ tag: "text", text: seg });
    });
  }
  return { zh_cn: { content: lines.map((l) => (l.length ? l : [{ tag: "text", text: "" }])) } };
}

/** 把飞书消息 content 转成纯文本（非文字消息用占位描述）。导出以便测试。 */
export function feishuContentToText(msgType: string, content: string, mentions: { key: string; name: string }[] = [], emoji?: EmojiTable): { text: string; media: MediaType } {
  let obj: any = {};
  try { obj = JSON.parse(content); } catch { /* ignore */ }
  const fixMentions = (s: string) => mentions.reduce((acc, m) => acc.split(m.key).join(`@${m.name}`), s);
  const em = (s: string) => (emoji ? inboundEmojiText(s, emoji) : s);
  const emotion = (key?: string) => {
    const e = key && emoji ? emoji.byFeishuKey(key) : undefined;
    return e ? `[emoji:${e.id}]` : `[表情${key ? ":" + key : ""}]`;
  };
  if (msgType === "text") return { text: fixMentions(em(String(obj.text ?? ""))), media: "text" };
  if (msgType === "post") {
    const body = obj.content ? obj : (obj.zh_cn ?? obj.en_us ?? Object.values(obj)[0] ?? {});
    const parts: string[] = [];
    if (body.title) parts.push(body.title);
    for (const line of body.content ?? []) {
      parts.push((line as any[]).map((el) => el.tag === "text" ? em(el.text ?? "") : el.tag === "a" ? el.text ?? "" : el.tag === "at" ? `@${el.user_name ?? ""}` : el.tag === "img" ? "[图片]" : el.tag === "emotion" ? emotion(el.emoji_type) : el.tag === "media" ? "[视频]" : el.tag === "code_block" ? el.text ?? "" : el.tag === "md" ? em(el.text ?? "") : "").join(""));
    }
    return { text: fixMentions(parts.join("\n")), media: "text" };
  }
  if (msgType === "file" && obj.file_name) return { text: `[文件:${obj.file_name}]`, media: "file" };
  const ph = PLACEHOLDER[msgType];
  return ph ? { text: ph[1], media: ph[0] } : { text: `[${msgType}消息]`, media: "other" };
}

export class FeishuAdapter implements IMAdapter {
  readonly platform = "feishu" as const;
  private client: lark.Client;
  private ws: lark.WSClient | null = null;
  private botOpenId = "";
  private names = new Map<string, string>();
  private chatTitles = new Map<string, string>();
  private chatKinds = new Map<string, "private" | "group">();
  private sink: ((m: InboundMessage) => void) | null = null;
  /** 最近处理过的 message_id / 事件键（重连后平台会重投未确认的事件） */
  private seen = new Set<string>();
  /** 串行处理入站事件：事件回调立即返回（尽快 ack，减少重投），处理按到达顺序进行 */
  private chain: Promise<void> = Promise.resolve();
  private disconnectedAt: number | null = null;

  constructor(private opts: FeishuOptions, private log: Logger) {
    const domain = opts.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;
    this.client = new lark.Client({ appId: opts.appId, appSecret: opts.appSecret, domain, loggerLevel: lark.LoggerLevel.warn });
  }

  async start(sink: (m: InboundMessage) => void) {
    try {
      const info: any = await this.client.request({ method: "GET", url: "/open-apis/bot/v3/info" });
      this.botOpenId = info?.bot?.open_id ?? "";
      this.log.info(`feishu bot open_id=${this.botOpenId ? "ok" : "unknown"}`);
    } catch (e) { this.log.warn(`feishu: 获取机器人信息失败（@识别将不可用）：${(e as Error).message}`); }

    this.sink = sink;
    const handlers: Record<string, (data: any) => Promise<void>> = {
      "im.message.receive_v1": async (data) => {
        const id: string = data?.message?.message_id ?? "";
        if (this.markSeen(id)) return;
        this.enqueue(async () => sink(await this.toInbound(data)), "处理消息失败");
      },
    };
    if (this.opts.reactions) handlers["im.message.reaction.created_v1"] = async (data) => {
      const id = `reaction:${data?.message_id}:${data?.user_id?.open_id ?? ""}:${data?.reaction_type?.emoji_type ?? ""}:${data?.action_time ?? ""}`;
      if (this.markSeen(id)) return;
      this.enqueue(async () => { const m = await this.reactionToInbound(data); if (m) sink(m); }, "处理表情回复失败");
    };
    const dispatcher = new lark.EventDispatcher({}).register(handlers as any);
    const domain = this.opts.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;
    this.ws = new lark.WSClient({
      appId: this.opts.appId, appSecret: this.opts.appSecret, domain, loggerLevel: lark.LoggerLevel.warn, autoReconnect: true,
      onReady: () => this.log.info("feishu: 长连接已建立"),
      onReconnecting: () => {
        this.disconnectedAt ??= Date.now();
        this.log.warn("feishu: 长连接重连中（不影响定时唤醒与发送，发送走 HTTP）");
      },
      onReconnected: () => {
        const s = this.disconnectedAt ? Math.round((Date.now() - this.disconnectedAt) / 1000) : 0;
        this.disconnectedAt = null;
        this.log.info(`feishu: 长连接已恢复（断开约 ${s}s；期间的消息平台会补推，重复的按 message_id 去重）`);
      },
      onError: (e) => this.log.error("feishu: 长连接失败", e),
    });
    await this.ws.start({ eventDispatcher: dispatcher });
  }

  /** 返回 true 表示重复（已见过） */
  private markSeen(id: string): boolean {
    if (!id) return false;
    if (this.seen.has(id)) { this.log.info(`feishu: 重复投递已忽略 ${id}`); return true; }
    this.seen.add(id);
    if (this.seen.size > 5000) for (const k of [...this.seen].slice(0, 1000)) this.seen.delete(k);
    return false;
  }
  private enqueue(fn: () => Promise<void>, what: string) {
    this.chain = this.chain.then(fn).catch((e) => this.log.error(`feishu: ${what}`, e));
  }
  /** 测试用：直接投递一个原始事件 */
  async _deliver(event: "im.message.receive_v1", data: any) {
    const id: string = data?.message?.message_id ?? "";
    if (this.markSeen(id)) return;
    this.enqueue(async () => this.sink?.(await this.toInbound(data)), "处理消息失败");
    await this.chain;
  }

  async stop() { try { (this.ws as any)?.close?.(); } catch { /* ignore */ } this.ws = null; }

  private async toInbound(data: any): Promise<InboundMessage> {
    const msg = data.message;
    const senderOpenId: string = data.sender?.sender_id?.open_id ?? data.sender?.sender_id?.user_id ?? "unknown";
    const mentions: { key: string; name: string; id: string }[] = (msg.mentions ?? []).map((m: any) => ({ key: m.key, name: m.name, id: m.id?.open_id ?? "" }));
    for (const m of mentions) if (m.id && m.name) this.names.set(m.id, m.name);
    if (this.opts.logRawEmoji && /emotion|sticker|\[[^\]]{1,24}\]/.test(String(msg.content)))
      this.log.info(`feishu raw(${msg.message_type}): ${String(msg.content).slice(0, 400)}`);
    const { text, media } = feishuContentToText(msg.message_type, msg.content, mentions, this.opts.emoji);
    // 图片：入池前先落盘（压缩后存 data/media），唤醒时直接读，回复路径零等待
    let attachment: Attachment | null = null;
    // 临时探针：任何非文本消息都留一行，确认到底走没走进图片分支
    if (msg.message_type !== "text") this.log.info(`feishu: 非文本消息 ${msg.message_type} → media=${media} opts.media=${this.opts.media ? "有" : "无"}`);
    if (media === "image" && this.opts.media) {
      const key = imageKeyOf(msg.message_type, msg.content);
      this.log.info(`feishu: 图片消息 ${msg.message_id} key=${key ? key.slice(0, 18) + "…" : "(取不到)"}`);
      if (key) attachment = await this.downloadImage(msg.message_id, key)
        .catch((e) => { this.log.warn(`feishu: 图片下载失败（已降级为 [图片]）：${(e as Error).message}`); return null; });
      this.log.info(`feishu: 图片${attachment ? `已落盘 ${attachment.width}x${attachment.height} ${attachment.bytes}B` : "没拿到"}`);
    } else if (media === "image") {
      this.log.warn("feishu: 收到图片但没有配置 media（不会下载）");
    }
    const kind = msg.chat_type === "p2p" ? "private" : "group";
    this.chatKinds.set(msg.chat_id, kind);
    return {
      platform: "feishu", external_chat_id: msg.chat_id, pool_kind: kind, pool_title: await this.chatTitle(msg.chat_id, kind),
      msg_id: msg.message_id, sender_id: senderOpenId, sender_name: await this.senderName(senderOpenId),
      ts: Number(msg.create_time) || Date.now(), text, reply_to: msg.parent_id || null,
      mentions: mentions.map((m) => m.id).filter(Boolean),
      is_mention_me: !!this.botOpenId && mentions.some((m) => m.id === this.botOpenId),
      media_type: media, from_self: data.sender?.sender_type === "app" && senderOpenId === this.botOpenId,
      attachment,
    };
  }

  /** 拉取消息里的图片 → 压缩落盘。8 秒超时或失败返回 null，消息本身照常入池（文本降级为 [图片]）。 */
  private async downloadImage(messageId: string, imageKey: string): Promise<Attachment | null> {
    const work = (async () => {
      const tmp = path.join(os.tmpdir(), `rabbit-bot-${messageId}.img`);
      const res: any = await this.client.im.messageResource.get({
        path: { message_id: messageId, file_key: imageKey },
        params: { type: "image" },
      });
      await res.writeFile(tmp);
      try { return saveImage(fs.readFileSync(tmp), this.opts.media!, messageId); }
      finally { try { fs.unlinkSync(tmp); } catch { /* ignore */ } }
    })();
    let timer: any;
    try {
      return await Promise.race([
        work,
        new Promise<null>((r) => { timer = setTimeout(() => { this.log.warn(`feishu: 图片下载超时 8s（${messageId}）`); r(null); }, 8000); timer.unref?.(); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** 表情回复 → 一条池消息（不立即唤醒）。只处理真人的回复。 */
  private async reactionToInbound(data: any): Promise<InboundMessage | null> {
    if (data.operator_type && data.operator_type !== "user") return null;
    const key: string = data.reaction_type?.emoji_type ?? "";
    const userId: string = data.user_id?.open_id ?? data.user_id?.user_id ?? "unknown";
    const r: any = await this.client.im.v1.message.get({ path: { message_id: data.message_id } });
    const target = r?.data?.items?.[0];
    if (!target?.chat_id) return null;
    const chatId: string = target.chat_id;
    let kind = this.chatKinds.get(chatId);
    if (!kind) {
      try { const c: any = await this.client.im.v1.chat.get({ path: { chat_id: chatId } }); kind = c?.data?.chat_mode === "p2p" ? "private" : "group"; }
      catch { kind = "group"; }
      this.chatKinds.set(chatId, kind);
    }
    const e = this.opts.emoji?.byFeishuKey(key);
    const emo = e ? `[emoji:${e.id}]` : `[表情:${key}]`;
    const quoted = feishuContentToText(target.msg_type, target.body?.content ?? "{}", [], this.opts.emoji).text.replace(/\s+/g, " ").slice(0, 30);
    const mine = target.sender?.sender_type === "app" && (!this.botOpenId || target.sender?.id === this.botOpenId);
    return {
      platform: "feishu", external_chat_id: chatId, pool_kind: kind, pool_title: await this.chatTitle(chatId, kind),
      msg_id: `reaction:${data.message_id}:${userId}:${key}:${data.action_time ?? Date.now()}`,
      sender_id: userId, sender_name: await this.senderName(userId), ts: Number(data.action_time) || Date.now(),
      text: `[表情回复] 给${mine ? "你" : ""}「${quoted}」点了 ${emo}`, reply_to: data.message_id, mentions: [],
      is_mention_me: false, media_type: "reaction", from_self: false,
    };
  }

  private async senderName(openId: string): Promise<string> {
    const cached = this.names.get(openId);
    if (cached) return cached;
    let name = `用户${openId.slice(-4)}`;
    if (this.opts.fetchSenderName) {
      try {
        const r: any = await this.client.contact.v3.user.get({ path: { user_id: openId }, params: { user_id_type: "open_id" } });
        if (r?.data?.user?.name) name = r.data.user.name;
      } catch { /* 无通讯录权限时用占位名 */ }
    }
    this.names.set(openId, name);
    return name;
  }

  private async chatTitle(chatId: string, kind: string): Promise<string> {
    if (kind === "private") return "私聊";
    const cached = this.chatTitles.get(chatId);
    if (cached) return cached;
    let title = "群聊";
    try {
      const r: any = await this.client.im.v1.chat.get({ path: { chat_id: chatId } });
      if (r?.data?.name) title = r.data.name;
    } catch { /* ignore */ }
    this.chatTitles.set(chatId, title);
    return title;
  }

  private async create(chatId: string, msgType: string, content: object): Promise<SendResult> {
    const r: any = await this.client.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: chatId, msg_type: msgType, content: JSON.stringify(content) },
    });
    if (r?.code !== 0 || !r?.data?.message_id) throw new Error(`飞书发送失败 code=${r?.code} msg=${r?.msg}`);
    return { msgId: r.data.message_id };
  }
  sendText(chatId: string, text: string) { return this.create(chatId, "text", { text }); }
  sendRich(chatId: string, parts: RichPart[]) { return this.create(chatId, "post", buildFeishuPost(parts)); }
  sendSticker(chatId: string, fileKey: string) { return this.create(chatId, "sticker", { file_key: fileKey }); }

  async confirm(msgId: string): Promise<boolean> {
    try {
      const r: any = await this.client.im.v1.message.get({ path: { message_id: msgId } });
      return r?.code === 0;
    } catch { return false; }
  }
}
