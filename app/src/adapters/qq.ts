/** QQ 适配器：v1 仅预留槽位（需求 §0），不接收也不发送。 */
import type { IMAdapter, SendResult } from "./types.ts";
import type { InboundMessage } from "../types.ts";

export class QQAdapter implements IMAdapter {
  readonly platform = "qq" as const;
  async start(_sink: (m: InboundMessage) => void): Promise<void> {
    // TODO: 选定 QQ 接入方案（官方 QQ 机器人开放平台 / OneBot 等）后实现
  }
  async stop(): Promise<void> {}
  async sendText(_chat: string, _text: string): Promise<SendResult> {
    throw new Error("QQ 适配器尚未实现");
  }
}
