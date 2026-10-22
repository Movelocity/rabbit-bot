/** 提示词与消息格式化（尽量紧凑以省 token）。 */
import type { Config } from "../config.ts";
import type { Store } from "../core/db.ts";
import { fmtLocal, fmtShort } from "../core/time.ts";
import type { Plan, Pool, StoredMessage, Wake } from "../types.ts";

export function systemPrompt(cfg: Config, emojis: string[]): string {
  return [
    `你是「${cfg.agent.name}」。${cfg.agent.persona}`,
    "你在多个聊天池（飞书私聊/群聊）里和人聊天。消息不会直接推给你：程序在定时 tick、被@、私聊或计划到点时唤醒你，并把未读消息交给你。",
    "规则：",
    "1. 你的普通回复不会发给任何人，只记入后台日志。只有调用 send(pool, content) 的内容才会出现在聊天里。本轮不调用 send 就等于不回复。",
    "2. 像真人一样发短消息：想说多句就多次调用 send，每次一条。",
    "3. 每次 send 的返回值里会带上这期间别人新发的消息，据此调整，必要时继续回复或停止。",
    "4. 私聊和群里被@要回应；群里没被@时自己判断，多数时候保持安静。",
    `5. 表情写成 [emoji:中文id]，会显示成真表情${emojis.length ? `；常用：${emojis.join(" ")}（微信式叫法基本都认）` : "（当前没有可用表情，别用）"}。别人发的表情也会以这种形式给你。普通 [xxx] 原样显示。适度使用。`,
    "6. 不要用相同参数反复调用同一个工具；没有新进展就结束本轮。",
    "7. 需要以后再做的事用 plan_add 写计划（一次性用 ISO 时间，重复用 cron，时区 Asia/Shanghai）。",
    "8. 值得长期记住的事用 memory_add 按 user_id 记下。群里得到的信息不要带到私聊，反之亦然（scope 默认按来源）。",
    "9. 结束本轮时，用一句话写下你做了什么（只进日志）。",
  ].join("\n");
}

export function poolLabel(store: Store, p: Pool): string {
  return `${store.poolAlias(p.pool_id)} ${p.platform}${p.kind === "private" ? "私聊" : "群聊"}「${p.title || "-"}」`;
}

export function fmtMsg(m: StoredMessage, withSeq = true): string {
  const who = m.from_self ? "我" : `${m.sender_name}(${m.user_id ?? m.sender_id})`;
  const tag = m.is_mention_me ? "[@我]" : "";
  return `${withSeq ? `#${m.seq} ` : ""}${fmtShort(m.ts)} ${who}${tag}: ${m.text}`;
}

/** 按池分组格式化 */
export function fmtGrouped(store: Store, msgs: StoredMessage[]): string {
  const by = new Map<string, StoredMessage[]>();
  for (const m of msgs) (by.get(m.pool_id) ?? by.set(m.pool_id, []).get(m.pool_id)!).push(m);
  const out: string[] = [];
  for (const [pid, ms] of by) {
    const p = store.getPool(pid);
    out.push(`[${p ? poolLabel(store, p) : pid}]`);
    for (const m of ms) out.push(fmtMsg(m));
  }
  return out.join("\n");
}

export interface WakePromptInput {
  wake: Wake;
  now: number;
  unread: StoredMessage[];
  /** 首次在本会话出现的池：附近期上下文 */
  context: Map<string, StoredMessage[]>;
  memories: Map<string, { user_id: string; items: { id: number; content: string }[] }[]>;
  plans: Plan[];
  handoff?: string | null;
}

export function wakePrompt(store: Store, x: WakePromptInput): string {
  const lines: string[] = [];
  if (x.handoff) lines.push("【上一会话的交接文档】", x.handoff, "【交接文档结束】", "");
  lines.push(`现在 ${fmtLocal(x.now)} (Asia/Shanghai)。唤醒原因：${x.wake.type} / ${x.wake.reasons.join("；") || "-"}`);
  if (x.plans.length) {
    lines.push("到点的计划：");
    for (const p of x.plans) lines.push(`- 计划#${p.id}「${p.title}」${p.content ? `：${p.content}` : ""}${p.pool_id ? `（池 ${store.poolAlias(p.pool_id)}）` : ""}`);
  }
  for (const [pid, ctx] of x.context) {
    if (!ctx.length) continue;
    const p = store.getPool(pid)!;
    lines.push(`近期上下文 [${poolLabel(store, p)}]：`);
    for (const m of ctx) lines.push(fmtMsg(m, false));
  }
  for (const [pid, users] of x.memories) {
    for (const u of users) {
      if (!u.items.length) continue;
      lines.push(`记忆 ${u.user_id}（在 ${store.poolAlias(pid)} 可见）：${u.items.map((i) => i.content).join("；")}`);
    }
  }
  if (x.unread.length) lines.push("未读消息：", fmtGrouped(store, x.unread));
  else lines.push("没有未读消息。");
  return lines.join("\n");
}

export const HANDOFF_PROMPT =
  "上下文快满了，程序将新开会话。请写一份交接文档（不要调用任何工具），供新会话的你继续：" +
  "进行中的话题（按池和 user_id）、各人的状态与情绪、你承诺过但还没做的事、重要约定与计划、注意事项。要紧凑，用要点。";
