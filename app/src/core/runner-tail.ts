/**
 * 执行器日志摘要：从 runner.jsonl 尾部还原“最后在干什么”。
 *
 * 只读尾部，不整读大日志；只取 text / tool_use，不搬工具输出全文；
 * 所有内容写回任务池前统一脱敏、截断。执行器主格式是 opencode / mimo，
 * claude / codex 做尽力而为的兜底解析。
 */
import fs from "node:fs";
import { fmtShort } from "./time.ts";
import { runnerLogPath } from "./task-usage.ts";

export const RUNNER_TAIL_BYTES = 512 * 1024;
export const RUNNER_SUMMARY_MAX_CHARS = 1500;
export const RUNNER_RECENT_LIMIT = 8;

export interface RunnerToolSummary {
  at: number;
  name: string;
  status: string;
  input: string;
  output: string;
}

export interface RunnerRecentEvent {
  at: number;
  kind: "text" | "tool";
  text: string;
}

export interface RunnerDigest {
  taskId: number;
  executor: string;
  sessionId: string;
  attempt: number;
  /** 这一轮最后一条事件的时间；没有事件时为 null */
  lastEventAt: number | null;
  /** 距最后活动过了多久；lastEventAt 为 null 时按 runnerStartedAt 算 */
  silentMs: number;
  stuck: boolean;
  lastText: string | null;
  lastTool: RunnerToolSummary | null;
  recent: RunnerRecentEvent[];
  truncated: boolean;
}

export interface RunnerDigestOptions {
  now?: number;
  /** 只看这个时间之后的事件（通常是 runner_started_at），默认不过滤 */
  since?: number | null;
  tailBytes?: number;
  maxChars?: number;
  recentLimit?: number;
  /** 进程是否还活着；false 时 stuck 恒为 false */
  alive?: boolean;
  /** 静默超过多少毫秒算卡住；默认 5 分钟 */
  stuckMs?: number;
}

export interface RunnerDigestSource {
  id: number;
  executor: string;
  session_id: string;
  attempt: number;
  runner_started_at: number | null;
}

const SECRET_KV = /\b(password|passwd|pwd|token|secret|api[_-]?key|authorization)\b\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const MYSQL_P = /\b(mysql\b[^\n]*?)\s-p[^\s]+/gi;
const IMAGE_DATA = /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/gi;
const LONG_B64 = /[A-Za-z0-9+/]{200,}={0,2}/g;
const URL_SECRET = /([?&](?:token|key|access_token|signature|password)=)[^&\s]+/gi;
const SK_PREFIX = /\b(sk|pk|ghp|gho|glpat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/g;

/** 脱敏：密钥、Bearer、mysql -p、base64 图片、URL 里的 token。 */
export function redactText(raw: unknown, maxChars = 4000): string {
  let s = String(raw ?? "");
  if (!s) return "";
  s = s.replace(IMAGE_DATA, "[base64 image]");
  // Bearer 先处理：否则 Authorization 的 kv 规则会把 "Bearer" 当成值，留下后面的 token
  s = s.replace(BEARER, "Bearer ***");
  s = s.replace(SECRET_KV, (_m, k) => `${k}=***`);
  s = s.replace(MYSQL_P, (_m, head) => `${head} -p***`);
  s = s.replace(URL_SECRET, (_m, head) => `${head}***`);
  s = s.replace(SK_PREFIX, "***");
  s = s.replace(LONG_B64, "[base64]");
  return s.length > maxChars ? `${s.slice(0, maxChars)}…` : s;
}

/** 单行截断，保留换行结构。 */
function clipLines(text: string, maxLine = 160, head = 3, tail = 3): string {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((l) => redactText(l, maxLine).trimEnd())
    .filter((l) => l.trim().length > 0);
  if (!lines.length) return "";
  if (lines.length <= head + tail) return lines.join("\n");
  return [...lines.slice(0, head), "…", ...lines.slice(-tail)].join("\n");
}

/** 取文件尾部若干字节的完整行；文件不存在返回空数组。 */
export function tailRunnerLines(file: string, maxBytes = RUNNER_TAIL_BYTES): string[] {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - Math.max(1024, maxBytes));
    const len = size - start;
    if (len <= 0) return [];
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    const text = buf.toString("utf8");
    // 从中间开始读时第一行通常是半截，丢掉
    const lines = text.split(/\r?\n/);
    if (start > 0) lines.shift();
    return lines.filter((l) => l.trim().length > 0);
  } catch {
    return [];
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function eventTs(e: any): number | null {
  return num(e?.timestamp) ?? num(e?.time) ?? num(e?.ts) ?? null;
}

function contentToText(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const block of content) {
    if (typeof block === "string") out.push(block);
    else if (block && typeof block === "object" && (block as any).type === "text" && typeof (block as any).text === "string") {
      out.push((block as any).text);
    }
  }
  return out;
}

function inputSummary(tool: string, input: any): string {
  if (!input || typeof input !== "object") return String(input ?? "");
  const t = tool.toLowerCase();
  const pick = (k: string) => typeof input[k] === "string" ? input[k] : "";
  if (t === "bash" || t === "shell") return pick("command") || pick("cmd");
  if (t === "read" || t === "write" || t === "edit" || t === "read_file" || t === "write_file" || t === "edit_file") {
    return pick("filePath") || pick("path");
  }
  if (t === "grep" || t === "glob" || t === "find" || t === "ls") {
    return [pick("pattern"), pick("path")].filter(Boolean).join(" @ ");
  }
  if (t === "skill") return pick("name");
  if (t === "terminal") return pick("command");
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

function toolEvent(e: any, at: number): RunnerToolSummary | null {
  const part = e?.part;
  if (part && typeof part === "object" && part.type === "tool") {
    const state = part.state ?? {};
    const name = String(part.tool ?? "tool");
    return {
      at,
      name,
      status: String(state.status ?? ""),
      input: redactText(inputSummary(name, state.input), 240),
      output: clipLines(String(state.output ?? state.error ?? ""), 160, 3, 3),
    };
  }
  // claude stream-json 的 tool_use 块
  if (e?.type === "assistant" && Array.isArray(e?.message?.content)) {
    const block = e.message.content.find((b: any) => b?.type === "tool_use");
    if (block) {
      return {
        at,
        name: String(block.name ?? "tool"),
        status: "completed",
        input: redactText(inputSummary(String(block.name ?? ""), block.input), 240),
        output: "",
      };
    }
  }
  // codex exec --json 的 item 事件（尽力而为）
  if (e?.type === "item.completed" && e?.item?.type === "command_execution") {
    return {
      at,
      name: "shell",
      status: String(e.item.status ?? ""),
      input: redactText(String(e.item.command ?? ""), 240),
      output: clipLines(String(e.item.aggregated_output ?? e.item.output ?? ""), 160, 3, 3),
    };
  }
  return null;
}

interface ParsedRunner {
  lastEventAt: number | null;
  lastText: string | null;
  lastTool: RunnerToolSummary | null;
  recent: RunnerRecentEvent[];
}

function parseRunnerLines(lines: string[], since: number | null): ParsedRunner {
  let lastEventAt: number | null = null;
  let lastText: string | null = null;
  let lastTool: RunnerToolSummary | null = null;
  const recent: RunnerRecentEvent[] = [];
  const sinceTs = since && since > 0 ? since - 5000 : null;

  for (const line of lines) {
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!e || typeof e !== "object") continue;
    const at = eventTs(e);
    if (sinceTs !== null && at !== null && at < sinceTs) continue;

    if (e.type === "ufa-dispatch") continue; // 调度器自己的标记，不算执行器活动

    let text = "";
    if (e.type === "text" && typeof e.part?.text === "string") {
      text = e.part.text;
    } else if (e.type === "assistant") {
      const blocks = contentToText(e.message?.content ?? e.content);
      text = blocks.join("\n");
    } else if (e.type === "result" && typeof e.result === "string") {
      text = e.result;
    } else if (e.type === "item.completed" && e?.item?.type === "agent_message") {
      text = String(e.item.text ?? e.item.message ?? "");
    }

    if (text.trim()) {
      const clean = redactText(text, 600);
      const when = at ?? 0;
      if (at !== null) lastEventAt = lastEventAt === null ? at : Math.max(lastEventAt, at);
      lastText = clean;
      recent.push({ at: when, kind: "text", text: `助手：${clipLines(clean, 240, 2, 0)}` });
    }

    const tool = toolEvent(e, at ?? 0);
    if (tool && (at !== null || tool.at > 0)) {
      const when = at ?? tool.at;
      lastEventAt = lastEventAt === null ? when : Math.max(lastEventAt, when);
      lastTool = tool;
      recent.push({
        at: when,
        kind: "tool",
        text: `工具 ${tool.name}${tool.status ? `（${tool.status}）` : ""}：${tool.input || "（无参数）"}`,
      });
      continue;
    }

    // step_start / step_finish / thread.started / system / turn.completed 等：只推进活动时间
    if (!text.trim() && at !== null && e.type !== "turn.completed") {
      lastEventAt = lastEventAt === null ? at : Math.max(lastEventAt, at);
    }
  }

  recent.sort((a, b) => a.at - b.at);
  return { lastEventAt, lastText, lastTool, recent };
}

/** 读一条任务的 runner 日志并生成摘要。日志不存在时返回空摘要，不抛错。 */
export function readRunnerDigest(
  task: RunnerDigestSource,
  dataDir: string,
  opts: RunnerDigestOptions = {},
): RunnerDigest {
  const now = opts.now ?? Date.now();
  const lines = tailRunnerLines(runnerLogPath(dataDir, task.id), opts.tailBytes ?? RUNNER_TAIL_BYTES);
  const parsed = parseRunnerLines(lines, opts.since ?? task.runner_started_at ?? null);
  const lastEventAt = parsed.lastEventAt;
  const baseline = lastEventAt ?? task.runner_started_at ?? null;
  const silentMs = baseline ? Math.max(0, now - baseline) : 0;
  const stuckMs = opts.stuckMs ?? 5 * 60_000;
  const alive = opts.alive !== false;
  const recentLimit = Math.max(1, Math.floor(opts.recentLimit ?? RUNNER_RECENT_LIMIT));
  const allRecent = parsed.recent.slice(-recentLimit);
  const truncated = parsed.recent.length > allRecent.length;
  return {
    taskId: task.id,
    executor: String(task.executor ?? ""),
    sessionId: String(task.session_id ?? ""),
    attempt: Number(task.attempt ?? 0),
    lastEventAt,
    silentMs,
    stuck: alive && stuckMs > 0 && silentMs >= stuckMs,
    lastText: parsed.lastText,
    lastTool: parsed.lastTool,
    recent: allRecent,
    truncated,
  };
}

function humanAge(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec} 秒`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分 ${sec % 60} 秒`;
  const hour = Math.floor(min / 60);
  return `${hour} 小时 ${min % 60} 分`;
}

function shortSession(s: string): string {
  const v = String(s ?? "").trim();
  if (!v) return "（未捕获）";
  return v.length > 12 ? `${v.slice(0, 12)}…` : v;
}

/** 人话摘要；写进任务池 / 返回给 bot 都用这一份。 */
export function formatRunnerDigest(d: RunnerDigest, maxChars = RUNNER_SUMMARY_MAX_CHARS): string {
  const head = `任务 #${d.taskId} 最近活动（${d.executor || "执行器"}，session ${shortSession(d.sessionId)}`
    + (d.lastEventAt ? `，最后活动 ${fmtShort(d.lastEventAt)}，已静默 ${humanAge(d.silentMs)}` : "，本轮还没有事件")
    + "）";
  const lines: string[] = [head];
  for (const e of d.recent) {
    lines.push(`- ${e.at ? fmtShort(e.at) : "（无时间）"} ${e.text}`);
  }
  if (d.lastTool?.output) {
    lines.push(`最近一次工具输出：\n${d.lastTool.output}`);
  }
  if (!d.recent.length && d.lastText) {
    lines.push(`最后助手文本：${clipLines(d.lastText, 240, 2, 0)}`);
  }
  const text = lines.join("\n");
  return text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 8))}\n（已截断）` : text;
}
