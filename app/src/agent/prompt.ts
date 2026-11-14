/** 提示词与消息格式化（尽量紧凑以省 token）。 */
import os from "node:os";
import type { Config } from "../config.ts";
import type { Store } from "../core/db.ts";
import { fmtLocal, fmtShort } from "../core/time.ts";
import type { Pool, StoredMessage, Wake } from "../types.ts";
import { isOwnerId } from "../core/owners.ts";
import { loadPersona, personaPath } from "./persona.ts";
import { render } from "./template.ts";
import { businessIndexLine, businessIndexLineFromDir } from "../ops/business-map.ts";
import { businessDir, runtimeDir, sharedDir, topicsEnabled } from "../core/runtime.ts";
import { readWorkingMemory } from "../core/working-memory.ts";
import { knowledgeIndexLine } from "../ops/knowledge.ts";
import { memoryIndexLine } from "../ops/memories.ts";

export function systemPrompt(cfg: Config, emojis: string[], store?: Store): string {
  // 「[当前状态]」那一段借的是破甲提示词的形式：配置项比祈使句管用。
  // 模型把 key=value 当状态，把「你不要…」当建议——同一个要求，写成参数执行率明显更高。
  // 文案本身在 config/prompt/system.md，改它不用动这里。
  // 路径不写死用户名：home 取当前进程的家目录，desktop_dir 由配置按 ~ 展开
  const home = os.homedir();
  const desktop_dir = cfg.paths?.desktopDir || `${home}/Desktop`;
  const base = render("system", {
    agent_name: cfg.agent.name,
    persona: loadPersona(cfg, personaPath(cfg)),
    emoji_block: emojis.length
      ? `；常用：${emojis.join(" ")}（微信式叫法基本都认）`
      : "（当前没有可用表情，别用）",
    business_block: store ? businessIndexLine(store) : businessIndexLineFromDir(businessDir(cfg)),
    // 知识索引只给标题和标签：让模型知道「有这些知识该去查」，又不把正文常驻在上下文里。
    knowledge_block: store ? knowledgeIndexLine(store) : "",
    topics_rule: topicsEnabled(cfg) ? "- `topics/` 只放闲聊谈资；业务知识用 `knowledge`。" : "",
    home,
    desktop_dir,
    runtime_host: runtimeDir(cfg),
    shared_host: sharedDir(cfg),
  });
  return `${base}\n\n${workingMemoryBlock(cfg)}`;
}

function workingMemoryBlock(cfg: Config): string {
  const wm = readWorkingMemory(cfg);
  const shown = wm.truncated ? Array.from(wm.content).slice(0, wm.limit).join("") : wm.content;
  const lines = [
    "## 工作记忆（跨会话共享）",
    `文件：\`memory.md\`（沙盒 \`/work/memory.md\`，宿主 \`${wm.path}\`）。这是所有会话和主体共用的工作记忆，不是长期存储。只放当前还在进行的事、约定、坑、待办；一条一句，过时删掉。`,
    "每个会话开头读取一次；会话中改了文件，下一个会话才生效。用 `working_memory` 工具或直接改文件都行。",
    "",
    shown || "（空）",
  ];
  if (wm.truncated) lines.push("", `（文件超过 ${wm.limit} 字，这里只显示前 ${wm.limit} 字；请删掉过时内容。）`);
  return lines.join("\n");
}

export function poolLabel(store: Store, p: Pool): string {
  const kind = p.kind === "private" ? "私聊"
    : p.kind === "task" ? "任务"
    : p.kind === "schedule" ? "日程"
    : "群聊";
  return `${store.poolAlias(p.pool_id)} ${p.platform}${kind}「${store.poolDisplayTitle(p) || "-"}」`;
}

export function fmtMsg(store: Store, m: StoredMessage, withSeq = true): string {
  const display = store.userDisplayName(m.platform, m.sender_id) || m.sender_name;
  const who = m.from_self ? "我" : `${display}(${m.user_id ?? m.sender_id})`;
  // [主人] 是她判断"这句必须接"的依据：群聊里其他人的话可以不接，主人的不行
  const tag = `${m.is_mention_me ? "[@我]" : ""}${!m.from_self && isOwnerId(m.sender_id) ? "[主人]" : ""}`;
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
    for (const m of ms) out.push(fmtMsg(store, m));
  }
  return out.join("\n");
}

export interface WakePromptInput {
  wake: Wake;
  now: number;
  unread: StoredMessage[];
  /** 首次在本会话出现的池：附近期上下文 */
  context: Map<string, StoredMessage[]>;
  handoff?: string | null;
  /** 可聊的谈资（只在主动 tick 时给，有人说话时不需要） */
  topics?: { id: number; kind: string; content: string; source?: string }[];
  /** 主聊天（main chat）：任务汇报只能发到这里 */
  mainPool?: string | null;
}

export function wakePrompt(store: Store, x: WakePromptInput): string {
  // 数据在这边拼好，文案在 config/prompt/wake.md 和 scene-*.md 里。
  // 模板没有条件分支——要分岔就选不同的模板文件（比如有理由/没理由的计划）。
  const blocks: string[] = [];
  for (const [pid, ctx] of x.context) {
    if (!ctx.length) continue;
    const pool = store.getPool(pid)!;
    blocks.push(`近期上下文 [${poolLabel(store, pool)}]：\n` + ctx.map((m) => fmtMsg(store, m, false)).join("\n"));
  }
  // 记记忆要 user_id，但消息里只带名字。不给她这个，她要么猜、要么干脆不记
  const people = new Map<string, { name: string; owner: boolean }>();
  for (const m of x.unread) {
    if (!m.from_self && m.user_id) {
      // 用身份映射后的显示名：sender_name 可能是平台给的「用户144b」，别名才是本人名字
      const name = store.userDisplayName(m.platform, m.sender_id) || m.sender_name;
      people.set(m.user_id, { name, owner: isOwnerId(m.sender_id) });
    }
  }
  if (people.size) {
    blocks.push(`正在跟你说话的人：${[...people].map(([id, p]) => `${p.name}（user_id=${id}${p.owner ? "，主人" : ""}）`).join("、")}`);
  }
  // 长期记忆不整段注入：只给最近 5 条索引，细节让她自己 search / trace。
  // 只对真人聊天池注入；任务池和日程池没有长期记忆，注入了只会添噪。
  const memMsg = [...x.unread].reverse().find((m) => !m.from_self && m.user_id);
  const memPool = memMsg ? store.getPool(memMsg.pool_id) : undefined;
  if (memMsg?.user_id && memPool && !["task", "schedule"].includes(memPool.kind)) {
    const line = memoryIndexLine(store, { user: memMsg.user_id, pool: memPool, limit: 5 });
    if (line) blocks.push(line);
  }
  if (x.unread.length) blocks.push("未读消息：\n" + fmtGrouped(store, x.unread));
  else blocks.push("没有未读消息。");
  // 潮汐状态：它现在根本不知道自己说过几次、有没有人理——这几行直接决定该不该开口
  const primaryPool = x.unread[0]?.pool_id ?? [...x.context.keys()][0] ?? null;
  // 时间感：她得知道「我们多久没说话了」，否则主动性没有重量
  const lastChatTs = primaryPool ? store.lastMessageTs(primaryPool) : null;
  const silentN = primaryPool ? store.silentStreak(primaryPool) : 0;

  // 状态不写成模板片段，直接拼成几行数据：文案（怎么读这些数）在 scene-*.md 里
  const state: string[] = ["## 状态"];
  if (x.mainPool) {
    state.push(`- 主聊天：${store.poolAlias(x.mainPool)}（任务汇报只发这里，不发群聊）`);
  }
  state.push(`- 距上次对话：${lastChatTs ? fmtAgo(x.now - lastChatTs) : "（没有记录）"}`);
  if (x.wake.proactive?.length) {
    state.push(`- 独处时的念头：${x.wake.proactive.map((p) => p.detail).join("；")}（这一轮没有人在找你；只有正事才开口，没正事就 chat（action=skip），别硬找）`);
  }
  if (silentN >= 2) state.push(`- 你已经连着 ${silentN} 次醒过来没开口：说明确实没正事，继续保持沉默，别为了刷存在感硬找话说`);

  return render("wake", {
    handoff_block: x.handoff ? `【上一会话的交接文档】\n${x.handoff}\n【交接文档结束】\n\n` : "",
    now: fmtLocal(x.now),
    wake_type: x.wake.type,
    reasons: x.wake.reasons.join("；") || "-",
    blocks: blocks.join("\n"),
    state_block: state.join("\n"),
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
