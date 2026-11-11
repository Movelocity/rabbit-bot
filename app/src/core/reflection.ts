/**
 * 自省（reflection）：让模型在没人说话的时候想一下，输出「有多想说」。
 *
 * 这是整套主动机制的关键一步——urgency 是**她自己的判断**，不是代码拍的骰子。
 * 代码能做的只是：什么时候让她想、想完怎么解析、想不通怎么办。
 *
 * 输出是纯 JSON，六个键，不许有别的。解析失败不抛错，按 urgency=0 处理，
 * 因为「她今天没想好」是合法状态，不是故障。
 */

export interface Reflection {
  /** 她此刻在想什么。不给用户看，只进她自己的上下文 */
  thought: string;
  /** 用什么语气说 */
  styleHint: string;
  /** 0..1，想说的程度 */
  urgency: number;
  /** 想聊的话题（可空） */
  topicPick: string;
  /** 从哪个角度切 */
  topicAngle: string;
  /** 下次什么时候再想（秒），模型自己定节奏，不是固定间隔 */
  nextReflectionInSec: number | null;
}

/** 解析失败时的兜底：等于「想了想，没什么想说的」 */
export const EMPTY_REFLECTION: Reflection = {
  thought: "", styleHint: "", urgency: 0, topicPick: "", topicAngle: "", nextReflectionInSec: null,
};

export type ParseResult =
  | { ok: true; value: Reflection }
  | { ok: false; error: string };

/** 下次自省的间隔夹逼：太短会一直烧 token，太长她就「睡着了」 */
export const MIN_NEXT_SEC = 300;
export const MAX_NEXT_SEC = 3 * 3600;

function clamp01(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** 从模型输出里抠出第一个完整的 JSON 对象（容忍 ```json 围栏和前后废话） */
export function extractJsonObject(text: string): string | null {
  const s = String(text ?? "");
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : s;
  const start = body.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < body.length; i++) {
    const c = body[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === "\"") inStr = false;
      continue;
    }
    if (c === "\"") { inStr = true; continue; }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return body.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * 解析自省输出。
 * 容忍：代码围栏、前后废话、数字是字符串、多余的空键。
 * 不容忍：找不到 JSON、urgency 完全缺失（缺了就没法门控，按失败处理）。
 */
export function parseReflection(text: string): ParseResult {
  const json = extractJsonObject(text);
  if (!json) return { ok: false, error: "no-json" };
  let raw: any;
  try {
    raw = JSON.parse(json);
  } catch {
    return { ok: false, error: "bad-json" };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "not-object" };
  if (!("urgency" in raw)) return { ok: false, error: "missing-urgency" };

  const next = Number(raw.next_reflection_in);
  const nextReflectionInSec = Number.isFinite(next) && next > 0
    ? Math.min(MAX_NEXT_SEC, Math.max(MIN_NEXT_SEC, Math.round(next)))
    : null;

  return {
    ok: true,
    value: {
      thought: str(raw.thought),
      styleHint: str(raw.style_hint),
      urgency: clamp01(raw.urgency),
      topicPick: str(raw.topic_pick),
      topicAngle: str(raw.topic_angle),
      nextReflectionInSec,
    },
  };
}

export interface ReflectionPromptInput {
  now: number;
  tz: string;
  agentName: string;
  /** 最近若干条消息，已格式化成一行一条 */
  recentLines: string[];
  /** 距用户最后一条消息多少分钟 */
  silentMinutes: number;
  /** 上次主动开口说的话（没有就 null） */
  lastProactive: { text: string; replied: boolean } | null;
  /** 上次自省的 thought，用来保持想事情的连续性 */
  prevThought: string | null;
  /** 连续说了几次没人回 */
  consecutiveSpeaks: number;
}

/** urgency 的锚点。不写这张表，模型会全给 0.5，门控就形同虚设 */
export const URGENCY_ANCHORS = `0.0–0.2  手上没有正事，也没有新结果
0.3–0.5  有个待确认项或小进展，但不急，可以等下次一起说
0.6–0.8  有可交付的结果、需要他决定的事，或任务有风险
0.9–1.0  任务卡住/有风险/到点必须提醒，再不说会误事`;

function fmtTime(ts: number, tz: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: tz, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(ts));
}

/**
 * 自省的提示词。
 *
 * 只给她看「最近发生了什么」，不给全部聊天记录——自省是为了判断「现在该不该开口」，
 * 不是为了复盘。给太多她会开始写读后感，urgency 就不准了。
 */
export function buildReflectionPrompt(i: ReflectionPromptInput): string {
  const parts: string[] = [];
  parts.push(`现在是 ${fmtTime(i.now, i.tz)}，距离对方最后一次说话已经过去 ${Math.round(i.silentMinutes)} 分钟。`);
  parts.push("");
  parts.push("最近的对话（从早到晚）：");
  parts.push(i.recentLines.length ? i.recentLines.join("\n") : "（还没有聊过）");
  parts.push("");

  if (i.lastProactive) {
    parts.push(`你上次主动开口说的是：「${i.lastProactive.text.slice(0, 120)}」`);
    parts.push(i.lastProactive.replied ? "对方回了。" : "对方没回。");
    parts.push("");
  }
  if (i.prevThought) {
    parts.push(`上一次你在想：${i.prevThought.slice(0, 160)}`);
    parts.push("（那是你当时自己的想法，不是事实。上面最近对话里如果找不到支撑它的原话，就别拿它当证据继续往下推——换个方向想。）");
    parts.push("");
  }
  if (i.consecutiveSpeaks > 0) {
    parts.push(`注意：你已经连着主动说了 ${i.consecutiveSpeaks} 次，对方一次都没回。这一次要么真有话说，要么就别开口。`);
    parts.push("");
  }

  parts.push(`你是${i.agentName}。此刻没人跟你说话。扫一眼手上的任务、计划和待确认项，判断有没有需要主动开口的正事。`);
  parts.push("不要为了找话说而找话题；没有正事就不说。想清楚之后，只输出一个 JSON 对象，六个键，不要别的任何内容：");
  parts.push(`{
  "thought": "你此刻手上正事的进展和判断，一到两句话。写具体的任务号、状态、卡点，别写心情和空话",
  "style_hint": "如果开口，用什么语气。默认：同事同步，先结论后依据",
  "urgency": 0.0,
  "topic_pick": "要提醒的事或待确认项，没有就空字符串",
  "topic_angle": "从哪个角度切入，没有就空字符串",
  "next_reflection_in": 1800
}`);
  parts.push("");
  parts.push("urgency 的锚（必须对着这个表给分，不要都给 0.5）：");
  parts.push(URGENCY_ANCHORS);
  parts.push("");
  parts.push("next_reflection_in 是「过多少秒之后你愿意再想一次」，自己定，300 到 10800 之间。");
  parts.push("没有正事就给低于 0.3 的分；别硬找话题，也别为了刷存在感开口。");

  return parts.join("\n");
}
