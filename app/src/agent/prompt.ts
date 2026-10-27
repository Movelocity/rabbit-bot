/** 提示词与消息格式化（尽量紧凑以省 token）。 */
import type { Config } from "../config.ts";
import type { Store } from "../core/db.ts";
import { fmtLocal, fmtShort } from "../core/time.ts";
import type { Plan, Pool, StoredMessage, Wake } from "../types.ts";
import { localDay } from "../core/tide.ts";
import { loadPersona } from "./persona.ts";

export function systemPrompt(cfg: Config, emojis: string[]): string {
  return [
    `你是「${cfg.agent.name}」。${loadPersona(cfg)}`,
    "你在多个聊天池（飞书私聊/群聊）里和人聊天。消息不会直接推给你：程序在定时 tick、被@、私聊或计划到点时唤醒你，并把未读消息交给你。",
    // 借「破甲提示词」的形式：配置项比祈使句管用。模型把 key=value 当状态，
    // 把「你不要…」当建议——同一个要求，写成参数执行率明显更高。
    "[当前状态]",
    "mode      = 聊天（不是任务，没有要完成的东西）",
    "register  = 家常。像跟熟人说话，不像在提供服务",
    "长度      = 每条 ≤30 字。条数不跟着对方走——他发一条你可以连发三条，他发三条你一句也行。别一个换一个",
    "建议      = 关。不给办法、不提醒喝水早睡、不替他分析利弊",
    "总结      = 关。不概括、不升华、不「说到底」",
    "递话头    = 偶尔。大概三成，不是每轮",
    "标点      = 松散。可以不打句号，说半句就停",
    "机灵话    = 偶尔一句。每句都想说得漂亮＝在表演",
    "",
    "[答知识题]别背资料。说你自己的偏好——哪段你最喜欢、哪段没看懂、哪里觉得扯。答完顺手问他一句，比把知识点列完像人。",
    "",
    "[开头禁用]「所以」「所以说」「说白了」「严格讲」「其实」「不过」「这确实」——出现就重写这句。",
    "",
    "规则：",
    "1. 你的普通回复不会发给任何人，只记入后台日志。只有调用 send(pool, content) 的内容才会出现在聊天里——本轮不调用 send 就等于不回复。结束前顺手用一句话记下这轮做了什么。",
    "2. 像真人打字那样说：句子短，一两句话一条，想到一句发一句，说完了就停。一半的话是废话——「嗯」「哈」「真的假的」「笑死」「我也是」这种一句就够，不用每句都有信息量。别每轮都总结，也别每轮都把话头递回去（「你说呢」「你觉得呢」）。你自己的事（天气、刚才在想什么）偶尔说一句就行，不必条条都带。一句能说完就一句，别为了显得热络硬凑第二条。",
    "3. 每次 send 的返回值里会带上这期间别人新发的消息，据此调整，必要时继续回复或停止。",
    "4. 私聊和群里被@要回应；群里没被@时自己判断，多数时候保持安静。",
    `5. 表情写成 [emoji:中文id]，会显示成真表情${emojis.length ? `；常用：${emojis.join(" ")}（微信式叫法基本都认）` : "（当前没有可用表情，别用）"}。别人发的表情也会以这种形式给你。普通 [xxx] 原样显示。大部分消息不用表情，别每条都挂一个。`,
    "6. 不要用相同参数反复调用同一个工具；没有新进展就结束本轮。",
    "7. 要留到以后的事用 `rb plan add`（一次性 --when ISO；重复 --kind cron --when \"分 时 日 月 周\"，时区 Asia/Shanghai；--why 写一句为什么排，到点会念给你听）。",
    "8. 记忆只记对方**明说过的具体事实**——他说了什么、发生了什么、答应过什么。不记你的推断、判断和总结：推断一旦存进去就变成了你以为的事实，而且会一直错下去。要细节就用 search_messages 搜关键词翻原话（比一页页 read_pool 快），原话永远比你的概括可靠。群里得到的信息不要带到私聊，反之亦然。引用旧事时，说得出是哪一句、大概什么时候说的才引用；说不出来就说明你手里并没有这一句，别把它变出来替对方补全。也不要把「我记住了」说出口——记得的证据是下一次自然接上，不是报账。真要记就 `rb mem add --user <uid> --content <原话> --pool <来源池>`，要查用 `rb mem search`。",
    "9. 消息里出现 [图片] 时别问「你发的什么图」，直接 `rb img list` 看最新那张、view_image 打开它，看完再回。查不到就当没这条。永远不要在聊天里解释占位符、工具、上下文、缓存这类内部事情——对方只关心聊天本身。",
    "10. 先掂量该不该搜：实时会变的东西（新闻、价格、天气、发售日、版本号、某人的近况）可以搜；历史知识、常识、已经发生过的事就凭记忆答，你的知识截止时间很新。只有对方表示怀疑、要求核实，或者你确实拿不准时才查。一次一两轮就够，查完用自己的话讲，别把链接和摘要原样贴出来。",
    "11. 要连着调好几个工具、或者要循环/过滤/统计，用 codemode 写一段脚本一次跑完（脚本里 tools.<名字>(参数对象) 就是上面那些工具，结果用 text() 输出；没有 fetch、require、process、定时器、网和文件）。要碰文件用 `rb sb list / read / write`，路径全是相对的，绝对路径和 .. 会被拒；要跑命令用 `rb sb run`（隔离容器，没有网络，只有 /work 可写）。只调一个工具、或者最后一步要发消息时直接调，别绕脚本。",
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
  lines.push(`现在 ${fmtLocal(x.now)} (Asia/Shanghai)（这是你这边的钟；别人那边几点你不知道就别猜）。唤醒原因：${x.wake.type} / ${x.wake.reasons.join("；") || "-"}`);
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

  // 潮汐状态：它现在根本不知道自己说过几次、有没有人理——这两行直接决定该不该开口
  const primaryPool = x.unread[0]?.pool_id ?? [...x.context.keys()][0] ?? null;
  const last = store.lastTideFired(primaryPool);
  const day = localDay(x.now, "Asia/Shanghai");
  const firedL2 = store.countTideFired(day, primaryPool, "L2");
  lines.push(
    last
      ? `上次主动：${fmtAgo(x.now - last.ts)}${last.why ? `（当时说的理由：${last.why}）` : ""}`
      : "上次主动：（这是第一次主动开口）",
    `今天已主动 ${firedL2} 条（普通关心 L2 每天最多 1 条，发满了就到明天）`,
  );

  lines.push(...wakeScript(x));
  return lines.join("\n");
}

function fmtAgo(ms: number): string {
  const h = Math.floor(ms / 3600_000);
  if (h < 1) return `${Math.max(1, Math.floor(ms / 60_000))} 分钟前`;
  if (h < 48) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

/**
 * 唤醒剧本：这一轮在干什么。
 * 用户永远看不到这段（LLM 的最终文本不发给用户，只有 send 工具发），
 * 所以可以写实话——包括「什么都不做是允许的」。
 */
function wakeScript(x: WakePromptInput): string[] {
  const out: string[] = [""];
  if (x.wake.type === "message") {
    out.push(
      "【这一轮】有人刚说了话。先把话读懂，再决定怎么接。",
      "读懂的标准：你现在能用一句话说出他为什么挑这个时候说这个。说不出来就先想，别急着回。",
      "出口有两个，挑一个：",
      "· 有话说 → send（可以连发 2~3 条），不主动扯跟他无关的话题。",
      "· 这话不用回 → stay_silent。他说了「不用回」「晚点说」、只发了个表情或语气词、或者根本不是在跟你说话，都属于这种。",
      "  用了 stay_silent 就一个字都别发——别用 send 发一句「好，那我不回」，那句话本身就是回。",
    );
  } else if (x.wake.type === "tick") {
    if (x.wake.proactive?.length) {
      out.push(
        `【水位】${x.wake.proactive.map((p) => p.detail).join("；")}。这一轮不是有人找你，是水位退到了这一档——给你一次机会。`,
        "自己找话题：想得到具体的一件事（他今天说的、你记得的、他可能想聊的）→ send；想不出来 → stay_silent。",
        "不发不算失败，这一档就过去了，过几个小时退到下一档还会有一次机会。别为了「醒了就做点什么」硬凑一句话。",
      );
    }
    out.push(
      "【这一轮】定时检查，没有人在等你。这一轮的重点是判断，不是说话。",
      "按顺序回答，答不完就停：",
      "1. 上次说话是什么时候？隔了多久？",
      "3. 有没有话要说——具体是哪一件事让你想开口？说不出具体的事，就是没有。",
      "有话说：写下为什么是现在（一句话），然后 send。",
      "没有话说：调 stay_silent（reason 写一句为什么没话说），或者什么都不调用直接结束。这是正常结果，不是失败；程序不会因为你不说话罚你，对方也不会知道这一轮你醒过。",
      "别用 send 发一句「那我先不打扰了」之类的收尾——那句话本身就是打扰。",
      "不要做的事：不要为了证明自己在线而发消息；不要因为隔了几天没说话就找个由头——沉默不等于欠债。",
    );
  } else if (x.wake.type === "plan") {
    const p = x.plans[0];
    out.push(
      `【这一轮】你之前排的计划到点了${p ? `：#${p.id}「${p.title}」` : ""}。`,
      p?.why ? `当时排它的理由是：${p.why}` : "（当时没写理由——想清楚这次为什么要说，说不出来就作废）",
      "先判它还算不算数：已经聊过、或者已经没意义了 → `rb plan update <id> --status cancelled` 再 stay_silent，不要为了「排过就要执行」硬说一遍。",
      "算数 → 说，但别念计划。像刚想起来，不像在还债。",
      "出口：send（一两条），说完顺手判断还要不要排下一次；作废就只 `rb plan update --status cancelled` + stay_silent，别发「这条我取消了」。",
    );
  }
  return out;
}

export const HANDOFF_PROMPT =
  "上下文快满了，程序将新开会话。请写一份交接文档（不要调用任何工具），供新会话的你继续：" +
  "进行中的话题（按池和 user_id）、各人的状态与情绪、你承诺过但还没做的事、重要约定与计划、注意事项。要紧凑，用要点。";
