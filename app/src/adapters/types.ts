/** IM 适配层插件接口：飞书是实现，mock 用于本地模拟/测试。 */
import type { InboundMessage, Platform } from "../types.ts";

export interface SendResult { msgId: string }

/** 一条消息内的富文本片段：文字 + 平台内置表情 */
export type RichPart = { type: "text"; text: string } | { type: "emoji"; id: string; key: string };

export interface IMAdapter {
  readonly platform: Platform;
  /** 开始接收消息；适配器把平台消息转换成 InboundMessage 交给 sink */
  start(sink: (m: InboundMessage) => void): Promise<void>;
  stop(): Promise<void>;
  sendText(externalChatId: string, text: string): Promise<SendResult>;
  /** 发送表情包（如飞书 sticker file_key）；不支持的平台可抛错，上层回退为文本 */
  sendSticker?(externalChatId: string, stickerKey: string): Promise<SendResult>;
  /** 发送含平台内置表情的消息（飞书：post + emotion 元素）。未实现时上层把表情退回为 [emoji:id] 文本 */
  sendRich?(externalChatId: string, parts: RichPart[]): Promise<SendResult>;
  /** 检查消息是否已出现在聊天里（可选；未实现视为发送接口成功即确认） */
  confirm?(msgId: string): Promise<boolean>;
}
