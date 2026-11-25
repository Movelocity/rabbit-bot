/**
 * 任务操作审计：工具/API 改任务时，往任务池写一条 internal 的 `/...` 指令。
 *
 * 只留痕，不驱动执行：这些消息 `internal=1`，不计未读、不进上下文、不唤醒；
 * `meta.audit_only=true` 明确标记，避免以后误加监听器把审计记录再执行一遍。
 */
import type { Store } from "./db.ts";
import { appendTaskEvent } from "./task-events.ts";
import { redactText } from "./runner-tail.ts";

export type TaskAuditSource = "tool" | "api" | "dispatcher";

export interface TaskAuditInput {
  taskId: number;
  action: string;
  text: string;
  source: TaskAuditSource;
  args?: Record<string, unknown> | null;
  ok?: boolean;
  result?: string | null;
  sender?: string;
  senderName?: string;
}

/** 规范化一条审计指令：`/resume #307 "..."`。 */
export function buildAuditLine(action: string, taskId: number, detail = ""): string {
  const head = `/${String(action ?? "").trim()} #${taskId}`;
  const tail = String(detail ?? "").trim();
  return tail ? `${head} ${tail}` : head;
}

/** 给指令里的自由文本加引号，避免空格/引号把一行拆成多段。 */
export function quoteArg(value: unknown, maxChars = 2000): string {
  const s = redactText(value, maxChars);
  if (!s) return '""';
  return JSON.stringify(s);
}

const SECRET_KEY = /(password|passwd|pwd|token|secret|api[_-]?key|authorization|cookie|credential)/i;

function cleanArgs(args: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!args) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined) continue;
    if (SECRET_KEY.test(k)) { out[k] = "***"; continue; }
    if (v === null || typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (typeof v === "string") out[k] = redactText(v, 800);
    else {
      try { out[k] = redactText(JSON.stringify(v), 800); } catch { out[k] = String(v); }
    }
  }
  return Object.keys(out).length ? out : null;
}

/**
 * 写一条审计事件。失败只吞掉（审计不能影响主操作），返回是否写入成功。
 */
export function appendTaskAudit(store: Store, input: TaskAuditInput): boolean {
  const text = redactText(input.text, 1200).trim();
  if (!text) return false;
  const meta: Record<string, unknown> = {
    kind: "task_command",
    audit_only: true,
    source: input.source,
    action: String(input.action ?? ""),
    ok: input.ok !== false,
  };
  const args = cleanArgs(input.args);
  if (args) meta.args = args;
  if (input.result) meta.result = redactText(input.result, 800);
  try {
    appendTaskEvent(store, input.taskId, {
      text,
      sender: input.sender || "bot",
      senderName: input.senderName || "bot",
      internal: true,
      notify: false,
      meta,
    });
    return true;
  } catch {
    return false;
  }
}
