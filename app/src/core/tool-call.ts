/** 工具调用的判定：chat 是二级入口，看名字不够，还要看 action。 */
export interface ToolCallShape {
  name: string;
  args?: unknown;
  isError?: boolean;
}

export function toolAction(c: ToolCallShape): string {
  const a = c.args as Record<string, unknown> | undefined;
  return typeof a?.action === "string" ? a.action : "";
}

/** 是不是 chat 的某个动作（send / skip / view / list / search） */
export function isChatCall(c: ToolCallShape, action: string): boolean {
  return c.name === "chat" && toolAction(c) === action;
}

/** 她这一轮真的发了话 */
export function didSend(c: ToolCallShape): boolean {
  return isChatCall(c, "send") && !c.isError;
}

/** 她这一轮明确决定不说 */
export function didSkip(c: ToolCallShape): boolean {
  return isChatCall(c, "skip") && !c.isError;
}


