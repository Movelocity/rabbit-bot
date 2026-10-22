/**
 * 飞书适配器：官方 @larksuiteoapi/node-sdk，长连接（WebSocket）事件模式，无需公网回调地址。
 * 需要环境变量 FEISHU_APP_ID / FEISHU_APP_SECRET。
 * 需在开发者后台开通：机器人能力；事件 im.message.receive_v1（订阅方式选“长连接”）；
 * 权限：im:message（收发消息）、im:message.group_at_msg（群 @）、im:message.group_msg（可选：读群里所有消息）、
 *       im:message.p2p_msg（私聊）、im:chat:readonly（群名，可选）、contact:user.base:readonly（用户名，可选）。
 */
import * as lark from "@larksuiteoapi/node-sdk";
import type { IMAdapter, SendResult } from "./types.ts";
import type { InboundMessage, MediaType } from "../types.ts";
import type { Logger } from "../core/logger.ts";

export interface FeishuOptions { appId: string; appSecret: string; domain: "feishu" | "lark"; fetchSenderName: boolean }

const PLACEHOLDER: Record<string, [MediaType, string]> = {
  image: ["image", "[图片]"], audio: ["audio", "[语音]"], media: ["video", "[视频]"], file: ["file", "[文件]"],
  sticker: ["sticker", "[表情包]"], share_chat: ["other", "[群名片]"], share_user: ["other", "[个人名片]"],
  location: ["other", "[位置]"], video_chat: ["other", "[视频会议]"], merge_forward: ["other", "[合并转发]"],
};

/** 把飞书消息 content 转成纯文本（非文字消息用占位描述）。导出以便测试。 */
export function feishuContentToText(msgType: string, content: string, mentions: { key: string; name: string }[] = []): { text: string; media: MediaType } {
  let obj: any = {};
  try { obj = JSON.parse(content); } catch { /* ignore */ }
  const fixMentions = (s: string) => mentions.reduce((acc, m) => acc.split(m.key).join(`@${m.name}`), s);
  if (msgType === "text") return { text: fixMentions(String(obj.text ?? "")), media: "text" };
  if (msgType === "post") {
    const body = obj.content ? obj : (obj.zh_cn ?? obj.en_us ?? Object.values(obj)[0] ?? {});
    const parts: string[] = [];
    if (body.title) parts.push(body.title);
    for (const line of body.content ?? []) {
      parts.push((line as any[]).map((el) => el.tag === "text" || el.tag === "a" ? el.text ?? "" : el.tag === "at" ? `@${el.user_name ?? ""}` : el.tag === "img" ? "[图片]" : el.tag === "emotion" ? `[${el.emoji_type ?? "表情"}]` : "").join(""));
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

    const dispatcher = new lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data) => {
        try { sink(await this.toInbound(data)); } catch (e) { this.log.error("feishu: 处理消息失败", e); }
      },
    });
    const domain = this.opts.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;
    this.ws = new lark.WSClient({
      appId: this.opts.appId, appSecret: this.opts.appSecret, domain, loggerLevel: lark.LoggerLevel.warn, autoReconnect: true,
      onReady: () => this.log.info("feishu: 长连接已建立"),
      onReconnecting: () => this.log.warn("feishu: 长连接重连中"),
      onReconnected: () => this.log.info("feishu: 长连接已恢复"),
      onError: (e) => this.log.error("feishu: 长连接失败", e),
    });
    await this.ws.start({ eventDispatcher: dispatcher });
  }

  async stop() { try { (this.ws as any)?.close?.(); } catch { /* ignore */ } this.ws = null; }

  private async toInbound(data: any): Promise<InboundMessage> {
    const msg = data.message;
    const senderOpenId: string = data.sender?.sender_id?.open_id ?? data.sender?.sender_id?.user_id ?? "unknown";
    const mentions: { key: string; name: string; id: string }[] = (msg.mentions ?? []).map((m: any) => ({ key: m.key, name: m.name, id: m.id?.open_id ?? "" }));
    for (const m of mentions) if (m.id && m.name) this.names.set(m.id, m.name);
    const { text, media } = feishuContentToText(msg.message_type, msg.content, mentions);
    const kind = msg.chat_type === "p2p" ? "private" : "group";
    return {
      platform: "feishu", external_chat_id: msg.chat_id, pool_kind: kind, pool_title: await this.chatTitle(msg.chat_id, kind),
      msg_id: msg.message_id, sender_id: senderOpenId, sender_name: await this.senderName(senderOpenId),
      ts: Number(msg.create_time) || Date.now(), text, reply_to: msg.parent_id || null,
      mentions: mentions.map((m) => m.id).filter(Boolean),
      is_mention_me: !!this.botOpenId && mentions.some((m) => m.id === this.botOpenId),
      media_type: media, from_self: data.sender?.sender_type === "app" && senderOpenId === this.botOpenId,
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
  sendSticker(chatId: string, fileKey: string) { return this.create(chatId, "sticker", { file_key: fileKey }); }

  async confirm(msgId: string): Promise<boolean> {
    try {
      const r: any = await this.client.im.v1.message.get({ path: { message_id: msgId } });
      return r?.code === 0;
    } catch { return false; }
  }
}
