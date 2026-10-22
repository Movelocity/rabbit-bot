/**
 * 表情包解析：只有 [emoji:中文id] 才解析；id 不在映射表里则原样作为文本。
 * 普通 [xxx] 不做任何处理。
 */
import type { EmojiTarget } from "../config.ts";

export type Segment = { type: "text"; text: string } | { type: "emoji"; id: string; target: EmojiTarget };

const EMOJI_RE = /\[emoji:([^\[\]\s:]{1,32})\]/g;

export function parseEmoji(content: string, map: Record<string, EmojiTarget>): Segment[] {
  const out: Segment[] = [];
  let buf = "";
  let last = 0;
  for (const m of content.matchAll(EMOJI_RE)) {
    const id = m[1];
    const target = Object.prototype.hasOwnProperty.call(map, id) ? map[id] : undefined;
    if (!target || (!target.sticker && target.text === undefined)) continue; // 匹配不上：保留原文
    buf += content.slice(last, m.index);
    if (target.sticker) {
      if (buf) out.push({ type: "text", text: buf });
      buf = "";
      out.push({ type: "emoji", id, target });
    } else {
      buf += target.text; // 文本型表情直接内联
    }
    last = m.index! + m[0].length;
  }
  buf += content.slice(last);
  if (buf) out.push({ type: "text", text: buf });
  // 去掉只含空白的文本段（例如表情前后的空格）
  return out.filter((s) => s.type !== "text" || s.text.trim() !== "" || out.length === 1);
}
