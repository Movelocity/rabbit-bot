import { didSend, didPlanAdd } from "./tool-call.ts";

/** 主动唤醒的「没排下次」判定（纯函数，便于单测）。 */

export interface ToolCallLike { name: string; isError?: boolean; args?: unknown }

export interface NudgeInput {
  wakeType: string;
  error?: string | null;
  aborted?: boolean;
  toolCalls: ToolCallLike[];
}

/**
 * 只在「计划唤醒 + 成功跑完 + 确实发了消息 + 没排下次计划」时补提醒。
 * 没说话时不劝（沉默是合法选择）；回消息的唤醒不管（那是对话，不是它自己的节奏）。
 */
export function needsPlanNudge(i: NudgeInput): boolean {
  if (i.wakeType !== "plan" || i.error || i.aborted) return false;
  const sent = i.toolCalls.some((c) => didSend(c));
  const planned = i.toolCalls.some((c) => didPlanAdd(c));
  return sent && !planned;
}
