/**
 * 表情：Agent 统一使用 [emoji:中文id]。
 * - 出站：只有 [emoji:中文id] 才解析；id/别名匹配不上则原样作为文本。普通 [xxx] 不做处理。
 * - 入站：飞书文本里的 [名字]（名字是表里的 id/别名/emoji_type）和富文本 emotion 元素都转成 [emoji:中文id]。
 * 映射表在 config/emoji-feishu.json（数据，不在代码里）。
 */
import fs from "node:fs";
import type { EmojiTarget } from "../config.ts";

export interface EmojiEntry {
  id: string;
  /** 飞书 emoji_type（大小写敏感） */
  feishu?: string;
  aliases?: string[];
  common?: boolean;
  /** 覆盖：表情包 file_key（发 sticker） */
  sticker?: string;
  /** 覆盖：替换成文字 */
  text?: string;
}

const norm = (s: string) => s.trim().toLowerCase();

export class EmojiTable {
  private byName = new Map<string, EmojiEntry>();
  private byKey = new Map<string, EmojiEntry>();
  readonly entries: EmojiEntry[] = [];

  constructor(entries: EmojiEntry[] = [], overrides: Record<string, EmojiTarget> = {}) {
    for (const e of entries) this.add({ ...e });
    for (const [id, t] of Object.entries(overrides)) {
      const hit = this.resolve(id);
      if (hit) Object.assign(hit, t);
      else this.add({ id, ...t });
    }
  }

  static load(file: string | null, overrides: Record<string, EmojiTarget> = {}): EmojiTable {
    let entries: EmojiEntry[] = [];
    if (file && fs.existsSync(file)) entries = (JSON.parse(fs.readFileSync(file, "utf8")).emojis ?? []) as EmojiEntry[];
    return new EmojiTable(entries, overrides);
  }

  private add(e: EmojiEntry) {
    this.entries.push(e);
    for (const n of [e.id, ...(e.aliases ?? []), ...(e.feishu ? [e.feishu] : [])]) {
      const k = norm(n);
      if (k && !this.byName.has(k)) this.byName.set(k, e);
    }
    if (e.feishu && !this.byKey.has(e.feishu)) this.byKey.set(e.feishu, e);
  }

  /** id / 别名 / emoji_type（ASCII 不区分大小写） */
  resolve(name: string): EmojiEntry | undefined {
    return this.byName.get(norm(name));
  }
  byFeishuKey(key: string): EmojiEntry | undefined {
    return this.byKey.get(key) ?? this.resolve(key);
  }
  /** 能渲染的（有飞书 key、表情包或文字替换） */
  usable(e: EmojiEntry | undefined): e is EmojiEntry {
    return !!e && (!!e.feishu || !!e.sticker || e.text !== undefined);
  }
  commonIds(): string[] {
    return this.entries.filter((e) => e.common && this.usable(e)).map((e) => e.id);
  }
  get size() { return this.entries.length; }
}

export type Segment = { type: "text"; text: string } | { type: "emoji"; id: string; entry: EmojiEntry };

const EMOJI_RE = /\[emoji:([^\[\]\s:]{1,32})\]/g;

/** 出站解析。文字型表情直接内联进文本。 */
export function parseEmoji(content: string, table: EmojiTable): Segment[] {
  const out: Segment[] = [];
  let buf = "";
  let last = 0;
  for (const m of content.matchAll(EMOJI_RE)) {
    const entry = table.resolve(m[1]);
    if (!table.usable(entry)) continue; // 匹配不上：保留原文
    buf += content.slice(last, m.index);
    last = m.index! + m[0].length;
    if (entry.text !== undefined && !entry.sticker) { buf += entry.text; continue; }
    if (buf) out.push({ type: "text", text: buf });
    buf = "";
    out.push({ type: "emoji", id: entry.id, entry });
  }
  buf += content.slice(last);
  if (buf) out.push({ type: "text", text: buf });
  return out;
}

/** 入站：把平台文本中的 [名字] 转成 [emoji:中文id]；不认识的、以及 [文字](链接) 保持原样。 */
export function inboundEmojiText(text: string, table: EmojiTable): string {
  return text.replace(/\[([^\[\]\n]{1,24})\](?!\()/g, (all, name: string) => {
    if (name.startsWith("emoji:")) return all;
    const e = table.resolve(name);
    return e ? `[emoji:${e.id}]` : all;
  });
}
