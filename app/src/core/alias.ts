/**
 * 别名：把「他说的那个词」翻成「记忆里的那一件事」。
 *
 * 秘书九成的工作量不在表达，在「知道你说的是哪个」。
 * 没有这一层，她每次都要反问「您说的『那个项目』是指哪个」——问一次是谨慎，问三次是把记忆的活推回给用户。
 *
 * 存在 memories 表里，kind='alias'，内容是「说法 → 指向」。
 * 检索前置：先查别名，再查事实。
 */

export interface Alias {
  id: number;
  /** 他说的那个词 */
  alias: string;
  /** 指的是什么 */
  target: string;
}

const SPLIT = /\s*(?:→|->|=>|＝|=|：)\s*/;

/** 把一条 alias 记忆拆成「说法 → 指向」。格式不对返回 null，别瞎猜 */
export function parseAliasContent(content: string): { alias: string; target: string } | null {
  const s = String(content ?? "").trim();
  if (!s) return null;
  const m = s.split(SPLIT);
  if (m.length < 2) return null;
  const alias = m[0].trim().replace(/^[「『"']|[」』"']$/g, "");
  const target = m.slice(1).join(" ").trim();
  if (!alias || !target) return null;
  return { alias, target };
}

/**
 * 在这段话里找命中的别名。
 *
 * 长别名优先并吃掉它覆盖的位置：「电商 AI Agent」和「那个项目」都命中时，
 * 如果一句里同时出现，按出现位置各算一次，但被更长别名整段覆盖的短别名不再单独报。
 */
export function findAliases(text: string, aliases: Alias[]): Alias[] {
  const t = String(text ?? "");
  if (!t) return [];
  const sorted = [...aliases].sort((a, b) => b.alias.length - a.alias.length);
  const taken: [number, number][] = [];
  const hits: Alias[] = [];
  for (const a of sorted) {
    if (!a.alias) continue;
    let from = 0;
    for (;;) {
      const at = t.indexOf(a.alias, from);
      if (at < 0) break;
      const span: [number, number] = [at, at + a.alias.length];
      const covered = taken.some(([s, e]) => span[0] >= s && span[1] <= e);
      if (!covered) {
        taken.push(span);
        if (!hits.some((h) => h.id === a.id)) hits.push(a);
      }
      from = at + a.alias.length;
    }
  }
  // 按在原文里第一次出现的位置排序，读起来跟话的顺序一致
  return hits.sort((a, b) => t.indexOf(a.alias) - t.indexOf(b.alias));
}

/** 给提示词用的一行：他这么说的时候指的就是这个 */
export function formatAliases(hits: Alias[]): string {
  return hits.map((h) => `「${h.alias}」= ${h.target}`).join("；");
}
