/** 主动唤醒的「没排下次」判定（纯函数，便于单测）。 */

export interface ToolCallLike { name: string; isError?: boolean }

export interface NudgeInput {
  wakeType: string;
  error?: string | null;
  aborted?: boolean;
  toolCalls: ToolCallLike[];
}

/**
 * 只在「计划唤醒 + 成功跑完 + 确实发了消息 + 没调 plan_add」时补提醒。
 * 没说话时不劝（沉默是合法选择）；回消息的唤醒不管（那是对话，不是它自己的节奏）。
 */
export function needsPlanNudge(i: NudgeInput): boolean {
  if (i.wakeType !== "plan" || i.error || i.aborted) return false;
  const didSend = i.toolCalls.some((c) => c.name === "send" && !c.isError);
  const didPlanAdd = i.toolCalls.some((c) => c.name === "plan_add" && !c.isError);
  return didSend && !didPlanAdd;
}
