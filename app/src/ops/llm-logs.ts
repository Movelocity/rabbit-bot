/**
 * 大模型实际日志：读 pi 落盘的 session JSONL（data/sessions/*.jsonl）。
 *
 * 管理台按会话加载，避免一次把所有轮次都吐给浏览器：
 *   - 列表只回最近 N 个会话的摘要；
 *   - 详情只回指定会话的一段消息（默认最新 40 条，可往前翻）；
 *   - 单条正文超长就截断并标记 truncated。
 */
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";

const DEFAULT_SESSION_LIMIT = 30;
const MAX_SESSION_LIMIT = 100;
const DEFAULT_MESSAGE_LIMIT = 40;
const MAX_MESSAGE_LIMIT = 200;
/** 单条正文最多回这么多字；够看现场，又不至于把一条工具输出撑爆页面 */
const MAX_TEXT_CHARS = 12_000;
const MAX_ARGS_CHARS = 4_000;
const ID_RE = /^[A-Za-z0-9._-]+$/;

export interface LlmSessionSummary {
  id: string;
  started_at: number | null;
  updated_at: number;
  size: number;
  messages: number;
  model: string;
  provider: string;
  preview: string;
  pools: string[];
}

export interface LlmToolCall {
  id?: string;
  name: string;
  args: string;
  args_truncated?: boolean;
}

export interface LlmUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  totalTokens?: number;
  costUsd?: number;
}

export interface LlmLogMessage {
  index: number;
  ts: number | null;
  role: string;
  text: string;
  truncated?: boolean;
  tool_calls?: LlmToolCall[];
  tool_name?: string;
  tool_call_id?: string;
  is_error?: boolean;
  model?: string;
  provider?: string;
  stop_reason?: string;
  duration_ms?: number;
  usage?: LlmUsage;
}

export interface LlmSessionDetail {
  id: string;
  started_at: number | null;
  updated_at: number;
  size: number;
  model: string;
  provider: string;
  pools: string[];
  total: number;
  /** 下一次往前翻时传 before=next_before；null = 到头了 */
  next_before: number | null;
  messages: LlmLogMessage[];
}

function sessionDir(cfg: Config): string {
  return path.resolve(cfg.dataDir, "sessions");
}

function clamp(n: number | undefined, def: number, min: number, max: number): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return def;
  return Math.max(min, Math.min(max, Math.floor(v)));
}

function asText(content: unknown): string {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part: any) => {
      if (typeof part === "string") return part;
      if (part?.type === "text") return String(part.text ?? "");
      if (part?.type === "image") return "[图片]";
      return "";
    }).filter(Boolean).join("\n");
  }
  if (typeof content === "object" && (content as any).text !== undefined) return String((content as any).text);
  return String(content);
}

function systemText(msg: any): string {
  const sections = msg?.sections;
  if (!sections || typeof sections !== "object") return asText(msg?.content);
  return Object.values(sections).map((v) => String(v ?? "")).filter(Boolean).join("\n\n");
}

function clip(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}

function readLines(file: string): any[] {
  const raw = fs.readFileSync(file, "utf8");
  const out: any[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* 损坏行跳过，不让整份日志打不开 */ }
  }
  return out;
}

function sessionId(file: string): string {
  return path.basename(file).replace(/\.jsonl$/, "");
}

function fileFor(cfg: Config, id: string): string | null {
  if (!ID_RE.test(id)) return null;
  const dir = sessionDir(cfg);
  const file = path.join(dir, `${id}.jsonl`);
  if (path.dirname(file) !== dir) return null;
  try { return fs.statSync(file).isFile() ? file : null; } catch { return null; }
}

function previewOf(msgs: any[]): { preview: string; pools: string[]; model: string; provider: string; messages: number; started_at: number | null; updated_at: number | null } {
  let preview = "";
  let model = "";
  let provider = "";
  let started: number | null = null;
  let updated: number | null = null;
  let messages = 0;
  const pools = new Set<string>();
  for (const entry of msgs) {
    const t = entry?.timestamp ? Date.parse(String(entry.timestamp)) : NaN;
    if (Number.isFinite(t)) {
      if (started === null) started = t;
      updated = t;
    }
    if (entry?.type === "model_change") {
      provider ||= String(entry.provider ?? "");
      model ||= String(entry.modelId ?? "");
      continue;
    }
    if (entry?.type !== "message") continue;
    const m = entry.message ?? {};
    const role = String(m.role ?? "");
    messages++;
    if (role === "system") continue;
    if (role === "assistant") {
      provider ||= String(m.provider ?? "");
      model ||= String(m.model ?? "");
    }
    if (role === "user" && !preview) {
      const raw = asText(m.content);
      const reason = /唤醒原因：([^\n]+)/.exec(raw)?.[1]?.trim();
      const firstUnread = raw.split("未读消息：\n")[1]?.split("\n")[0]?.trim();
      const text = (reason || firstUnread || raw).replace(/\s+/g, " ").trim();
      preview = text.slice(0, 160);
      for (const x of raw.matchAll(/\[(p\d+) /g)) pools.add(x[1]);
    }
  }
  return { preview, pools: [...pools].slice(0, 6), model, provider, messages, started_at: started, updated_at: updated };
}

/** 最近 N 个会话，按文件修改时间倒序。 */
export function listLlmSessions(cfg: Config, opts: { limit?: number } = {}): LlmSessionSummary[] {
  const dir = sessionDir(cfg);
  let names: string[];
  try { names = fs.readdirSync(dir).filter((x) => x.endsWith(".jsonl")); } catch { return []; }
  const files = names.map((name) => {
    const file = path.join(dir, name);
    try {
      const st = fs.statSync(file);
      return st.isFile() ? { file, name, mtime: st.mtimeMs, size: st.size } : null;
    } catch { return null; }
  }).filter((x): x is { file: string; name: string; mtime: number; size: number } => !!x);
  files.sort((a, b) => b.mtime - a.mtime);
  const limit = clamp(opts.limit, DEFAULT_SESSION_LIMIT, 1, MAX_SESSION_LIMIT);
  return files.slice(0, limit).map((f) => {
    const msgs = readLines(f.file);
    const p = previewOf(msgs);
    return {
      id: sessionId(f.file),
      started_at: p.started_at,
      updated_at: p.updated_at ?? f.mtime,
      size: f.size,
      messages: p.messages,
      model: p.model,
      provider: p.provider,
      preview: p.preview,
      pools: p.pools,
    };
  });
}

function toLogMessage(entry: any, index: number): LlmLogMessage | null {
  const m = entry?.message;
  if (!m || typeof m !== "object") return null;
  const role = String(m.role ?? "");
  const ts = entry?.timestamp ? Date.parse(String(entry.timestamp)) : (Number(m.timestamp) || null);
  const rawText = role === "system" ? systemText(m) : asText(m.content);
  const clipped = clip(rawText, MAX_TEXT_CHARS);
  const out: LlmLogMessage = {
    index,
    ts: Number.isFinite(ts as number) ? ts : null,
    role,
    text: clipped.text,
    ...(clipped.truncated ? { truncated: true } : {}),
  };
  if (role === "assistant") {
    const calls = Array.isArray(m.content)
      ? m.content.filter((c: any) => c?.type === "toolCall").map((c: any) => {
        const rawArgs = (() => {
          try { return JSON.stringify(c.arguments ?? {}); } catch { return String(c.arguments ?? ""); }
        })();
        const a = clip(rawArgs, MAX_ARGS_CHARS);
        return { id: c.id ? String(c.id) : undefined, name: String(c.name ?? ""), args: a.text, ...(a.truncated ? { args_truncated: true } : {}) };
      })
      : [];
    if (calls.length) out.tool_calls = calls;
    if (m.model) out.model = String(m.model);
    if (m.provider) out.provider = String(m.provider);
    if (m.stopReason) out.stop_reason = String(m.stopReason);
    if (m.durationMs !== undefined) out.duration_ms = Number(m.durationMs);
    const u = m.usage;
    if (u && typeof u === "object") {
      out.usage = {
        input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite,
        reasoning: u.reasoning, totalTokens: u.totalTokens, costUsd: u.cost?.total,
      };
    }
  }
  if (role === "toolResult") {
    if (m.toolName) out.tool_name = String(m.toolName);
    if (m.toolCallId) out.tool_call_id = String(m.toolCallId);
    if (m.isError) out.is_error = true;
    if (m.durationMs !== undefined) out.duration_ms = Number(m.durationMs);
  }
  return out;
}

/** 一个会话的实际消息；默认从最新往前取 limit 条。 */
export function readLlmSession(
  cfg: Config,
  id: string,
  opts: { limit?: number; before?: number } = {},
): LlmSessionDetail | null {
  const file = fileFor(cfg, id);
  if (!file) return null;
  let st: fs.Stats;
  try { st = fs.statSync(file); } catch { return null; }
  const entries = readLines(file);
  const meta = previewOf(entries);
  const all: LlmLogMessage[] = [];
  let index = 0;
  for (const entry of entries) {
    if (entry?.type !== "message") continue;
    const m = toLogMessage(entry, index++);
    if (m) all.push(m);
  }
  const total = all.length;
  const limit = clamp(opts.limit, DEFAULT_MESSAGE_LIMIT, 1, MAX_MESSAGE_LIMIT);
  const before = Number.isFinite(Number(opts.before))
    ? Math.max(0, Math.min(total, Math.floor(Number(opts.before))))
    : total;
  const start = Math.max(0, before - limit);
  const messages = all.slice(start, before);
  return {
    id,
    started_at: meta.started_at,
    updated_at: meta.updated_at ?? st.mtimeMs,
    size: st.size,
    model: meta.model,
    provider: meta.provider,
    pools: meta.pools,
    total,
    next_before: start > 0 ? start : null,
    messages,
  };
}
