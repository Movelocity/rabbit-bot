/**
 * 服务端风格闸：她的话发出去之前，代码先过一遍。
 *
 * 为什么不是靠提示词：套话是**提示词自己教出来的**——要求「像人一样说话」的同时
 * 又给她一堆规则，模型最省力的解就是套模板。提示词改十遍，模板换个样子回来。
 * 所以这一层用代码兜：拦下来，把理由退回去让她重写。
 *
 * 只拦三类，且都能说出「为什么」：
 *   1. 客服腔 / 八股腔：正常人聊天不会这么说
 *   2. 七天内的原样重复：跨天重复提示词管不住，只有代码管得住
 *   3. 太长：IM 里读着累（这条只提醒，不拦）
 *
 * 不拦短话。「嗯」「哈」「笑死」是好的，一半的话本来就该是废话——别把真人感一起拦掉。
 */

export type StyleReason = "banned" | "duplicate" | "too_long";

export interface StyleVerdict {
  ok: boolean;
  reason?: StyleReason;
  /** 退给模型的话：说清哪句不行、为什么，但不要给替换稿（给了就变成模板） */
  hint?: string;
}

/** 客服腔与八股腔。全是「单看这一句就知道不是朋友在说话」的表达 */
const BANNED: { re: RegExp; why: string }[] = [
  { re: /希望(对你|能帮到你)有?(所)?帮助/, why: "「希望对你有帮助」是客服结语" },
  { re: /有什么(可以|能)(帮|为)(你|您)/, why: "「有什么可以帮你」是客服开场" },
  { re: /请随时(告诉|联系|找)我/, why: "「请随时告诉我」是客服结语" },
  { re: /作为\s*(一个)?\s*(AI|人工智能|语言模型)/i, why: "没人聊天时提自己是 AI" },
  { re: /我(只)?是\s*(一个)?\s*(AI|人工智能|语言模型)/i, why: "没人聊天时提自己是 AI" },
  { re: /^(首先|第一)[，,、].*(其次|第二)[，,、]?/s, why: "「首先…其次」是报告体，不是在聊天" },
  { re: /^(总之|综上所述|总而言之)[，,、]/, why: "「总之」是在做总结陈词" },
  { re: /不仅(仅)?是.{0,12}(更|而且)是/, why: "「不仅仅是…更是」是文案腔" },
  { re: /在这个.{0,8}(时代|社会)/, why: "「在这个…的时代」是文案腔" },
  { re: /^(收到|好的|明白)[，,。!！~～]?\s*(我这就|马上|稍等)/, why: "「收到，我这就…」是客服应答" },
  { re: /(还有什么|有其他)(可以|需要)(帮|为)(你|您)/, why: "客服收尾" },
];

/** 去掉标点空白，用来判重：「钥匙弄了吗」和「钥匙弄了吗？」算同一句 */
export function normalize(text: string): string {
  return String(text ?? "")
    .replace(/\[emoji:[^\]]*\]/g, "")
    .replace(/[\s，,。.！!？?、…~～：:；;"'“”‘’（）()]/g, "")
    .toLowerCase();
}

const DAY = 24 * 3600e3;

export interface StyleInput {
  text: string;
  /** 她自己最近说过的话（带时间戳），用来判重 */
  recentSelf?: { text: string; ts: number }[];
  now?: number;
  /** 判重窗口 */
  dupWindowMs?: number;
  /** 单条字数上限；超了只提醒不拦 */
  maxChars?: number;
}

export function checkStyle(i: StyleInput): StyleVerdict {
  const text = String(i.text ?? "");
  const now = i.now ?? Date.now();

  for (const b of BANNED) {
    if (b.re.test(text)) {
      return { ok: false, reason: "banned", hint: `${b.why}。这句话别发，换你自己的说法重写一条——不用解释为什么换。` };
    }
  }

  const n = normalize(text);
  // 太短的句子不判重：「嗯」「我也是」本来就该反复说，拦掉等于不让她敷衍你
  if (n.length >= 5) {
    const win = i.dupWindowMs ?? 7 * DAY;
    const hit = (i.recentSelf ?? []).find((m) => now - m.ts <= win && normalize(m.text) === n);
    if (hit) {
      const days = Math.max(1, Math.round((now - hit.ts) / DAY));
      return {
        ok: false, reason: "duplicate",
        hint: `${days} 天前你已经说过一模一样的话。同一个意思就换个说法，或者干脆这次不说。`,
      };
    }
  }

  const max = i.maxChars ?? 160;
  if (text.length > max) {
    return { ok: true, reason: "too_long", hint: `这条 ${text.length} 字，有点长。已经发了，下次可以拆成两三条。` };
  }

  return { ok: true };
}
