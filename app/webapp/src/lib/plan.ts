/** 项目 plan.md 的「下一步」提取：优先读结构化待办，读不到再退回旧规则。 */

const HEADING = /^#{1,6}\s/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+\.\s+(.*)$/;
const CHECKBOX = /^\[([ xX])\]\s*(.*)$/;
const NEXT_RE = /下一步|待办|todo|next\s*step/i;

export function cleanPlanLine(line: string): string {
  return String(line ?? "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+\.\s+/, "")
    .replace(/^\[[ xX]\]\s*/, "")
    .replace(/`/g, "")
    .replace(/\*\*/g, "")
    .trim();
}

/** 去掉「下一步 / 待办 / TODO」这类标签本身，只留后面的内容。 */
function stripLabel(line: string): string {
  return line
    .replace(HEADING, "")
    .replace(/下一步|待办|todo|next\s*step/gi, "")
    .replace(/^[\s:：\-—]+/, "")
    .trim();
}

export interface PlanItem {
  text: string;
  checked: boolean;
}

/** 收集一段里的列表项，含跨行的续写；`- [x]` 记为已完成。 */
export function collectPlanItems(lines: string[]): PlanItem[] {
  const items: PlanItem[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    let body: string | null = null;
    const bullet = BULLET.exec(raw);
    if (bullet) body = bullet[1];
    else {
      const numbered = NUMBERED.exec(raw);
      if (numbered) body = numbered[1];
    }
    if (body === null) continue;

    let checked = false;
    const box = CHECKBOX.exec(body.trim());
    if (box) {
      checked = box[1].toLowerCase() === "x";
      body = box[2];
    }

    let text = body.trim();
    let j = i + 1;
    for (; j < lines.length; j++) {
      const l = lines[j];
      if (!l.trim()) break;
      if (BULLET.test(l) || NUMBERED.test(l) || HEADING.test(l.trim())) break;
      text += ` ${l.trim()}`;
    }
    items.push({ text: cleanPlanLine(text), checked });
    i = j - 1;
  }
  return items.filter((it) => it.text);
}

/**
 * 卡片「下一步」：
 * 1) 有「下一步/待办」段落 → 取第一条未完成的列表项（跨行拼完整）；全勾完则没有下一步。
 * 2) 没有结构 → 退回「第一个非标题行」，与旧行为一致。
 */
export function nextStepOf(plan: string): string {
  const lines = String(plan ?? "").split("\n");
  const index = lines.findIndex((line) => NEXT_RE.test(line));
  if (index >= 0) {
    const inline = stripLabel(lines[index]);
    if (inline) return cleanPlanLine(inline);

    const section: string[] = [];
    for (let i = index + 1; i < lines.length; i++) {
      if (HEADING.test(lines[i])) break;
      section.push(lines[i]);
    }
    const items = collectPlanItems(section);
    if (items.length) {
      const next = items.find((it) => !it.checked);
      return next ? next.text : "";
    }
    const first = section.map((l) => l.trim()).find((l) => l && !HEADING.test(l));
    return first ? cleanPlanLine(first) : "";
  }

  const first = lines.map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
  return first ? cleanPlanLine(first) : "";
}
