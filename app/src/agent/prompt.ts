/** 提示词与消息格式化（尽量紧凑以省 token）。 */
import type { Config } from "../config.ts";
import type { Store } from "../core/db.ts";
import { fmtLocal, fmtShort } from "../core/time.ts";
import type { Plan, Pool, StoredMessage, Wake } from "../types.ts";
import { localDay } from "../core/tide.ts";
import { loadPersona } from "./persona.ts";
import { render } from "./template.ts";

export function systemPrompt(cfg: Config, emojis: string[]): string {
  // 「[当前状态]」那一段借的是破甲提示词的形式：配置项比祈使句管用。
  // 模型把 key=value 当状态，把「你不要…」当建议——同一个要求，写成参数执行率明显更高。
  // 文案本身在 config/prompt/system.md，改它不用动这里。
  return render("system", {
    agent_name: cfg.agent.name,
    persona: loadPersona(cfg),
    emoji_block: emojis.length
      ? `；常用：${emojis.join(" ")}（微信式叫法基本都认）`
      : "（当前没有可用表情，别用）",
  });
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
  /** 可聊的谈资（只在主动 tick 时给，有人说话时不需要） */
  topics?: { id: number; kind: string; content: string; source?: string }[];
}

export function wakePrompt(store: Store, x: WakePromptInput): string {
  // 数据在这边拼好，文案在 config/prompt/wake.md 和 scene-*.md 里。
  // 模板没有条件分支——要分岔就选不同的模板文件（比如有理由/没理由的计划）。
  const blocks: string[] = [];
  if (x.plans.length) {
    blocks.push(
      "到点的计划：\n" +
        x.plans
          .map((p) => `- 计划#${p.id}「${p.title}」${p.content ? `：${p.content}` : ""}${p.pool_id ? `（池 ${store.poolAlias(p.pool_id)}）` : ""}`)
          .join("\n"),
    );
  }
  for (const [pid, ctx] of x.context) {
    if (!ctx.length) continue;
    const pool = store.getPool(pid)!;
    blocks.push(`近期上下文 [${poolLabel(store, pool)}]：\n` + ctx.map((m) => fmtMsg(m, false)).join("\n"));
  }
  for (const [pid, users] of x.memories) {
    for (const u of users) {
      if (!u.items.length) continue;
      blocks.push(`记忆 ${u.user_id}（在 ${store.poolAlias(pid)} 可见）：${u.items.map((i) => i.content).join("；")}`);
    }
  }
  if (x.unread.length) blocks.push("未读消息：\n" + fmtGrouped(store, x.unread));
  else blocks.push("没有未读消息。");
  // 话题库住在沙盒里（/work/topics），不往提示词里塞条目——她要用自己去读。
  // 每轮只给一句「在哪儿、怎么看」，翻不翻由她判断。
  blocks.push(render("part-topics", {}));

  // 潮汐状态：它现在根本不知道自己说过几次、有没有人理——这两行直接决定该不该开口
  const primaryPool = x.unread[0]?.pool_id ?? [...x.context.keys()][0] ?? null;
  // 时间感：她得知道「我们多久没说话了」，否则主动性没有重量
  const lastChatTs = primaryPool ? store.lastMessageTs(primaryPool) : null;
  // 连憋了几次：这句话只在数到 2 以上时才出现（模板里无条件，靠这里给空串）
  const silentN = primaryPool ? store.silentWaveStreak(primaryPool) : 0;
  const silentNote = silentN >= 2 ? `你已经连着 ${silentN} 次醒过来又什么都没说。这次别挑了。` : "";
  const last = store.lastTideFired(primaryPool);
  const day = localDay(x.now, "Asia/Shanghai");
  const firedL2 = store.countTideFired(day, primaryPool, "L2");

  const plan0 = x.plans[0];
  return render("wake", {
    handoff_block: x.handoff ? `【上一会话的交接文档】\n${x.handoff}\n【交接文档结束】\n\n` : "",
    now: fmtLocal(x.now),
    wake_type: x.wake.type,
    reasons: x.wake.reasons.join("；") || "-",
    blocks: blocks.join("\n"),
    tide_block: render("part-tide", {
      last: last
        ? `${fmtAgo(x.now - last.ts)}${last.why ? `（当时说的理由：${last.why}）` : ""}`
        : "（这是第一次主动开口）",
      fired: String(firedL2),
      chat_gap: lastChatTs ? fmtAgo(x.now - lastChatTs) : "（没有记录）",
    }),
    scene: render(`scene-${x.wake.type}`, {
      silent_note: silentNote,
      proactive_block: x.wake.proactive?.length
        ? render("part-proactive", { detail: x.wake.proactive.map((p) => p.detail).join("；") })
        : "",
      plan_label: plan0 ? `：#${plan0.id}「${plan0.title}」` : "",
      plan_why: plan0?.why
        ? render("part-plan-why", { why: plan0.why })
        : render("part-plan-nowhy", {}),
    }),
  });
}

function fmtAgo(ms: number): string {
  const h = Math.floor(ms / 3600_000);
  if (h < 1) return `${Math.max(1, Math.floor(ms / 60_000))} 分钟前`;
  if (h < 48) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

/** 交接要求（上下文将满时发给它自己）。文案在 config/prompt/handoff.md。 */
export function handoffPrompt(): string {
  return render("handoff", {});
}
