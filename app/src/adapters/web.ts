/**
 * 网页直聊适配器：没有外部长连接，用户消息由 REST API 直接 ingest。
 *
 * hub.send() 仍然按平台找适配器：这里只负责「发出去」这件事在平台侧成功，
 * 消息内容由 hub 统一写入池（from_self），网页前端轮询池消息即可看到。
 */
import crypto from "node:crypto";
import type { IMAdapter, SendResult } from "./types.ts";

export class WebAdapter implements IMAdapter {
  readonly platform = "web" as const;

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async sendText(_externalChatId: string, _text: string): Promise<SendResult> {
    return { msgId: `web-out-${crypto.randomUUID()}` };
  }
}
