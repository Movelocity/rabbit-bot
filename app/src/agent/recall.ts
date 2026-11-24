/**
 * 按提及注入（需求 R3 / R4）：对话里提到什么，就把相关的已有知识/地图对象
 * 简短端到模型面前；没提到就一条都不注入。
 *
 * 只做本地关键词命中，零模型调用。注入有硬上限（知识 3 条、对象 2 个），
 * 不随知识/对象总量增长；歧义（一个词指向多个对象）不猜，只提示先 resolve。
 */
import type { Store } from "../core/db.ts";
import type { StoredMessage } from "../types.ts";

export interface RecallKnowledge {
  id: number;
  title: string;
  tags: string[];
  summary?: string;
  updatedAt?: number;
}

export interface RecallObject {
  id: string;
  type: string;
  name: string;
  aliases?: string[];
  description?: string;
  relations?: number;
}

function lower(s: unknown): string {
  return String(s ?? "").toLowerCase();
}

function isAsciiTerm(t: string): boolean {
  return /^[\x00-\x7f]+$/.test(t);
}

/** 词是否出现在文本里；纯 ASCII 词按字母数字边界判，避免 erp-gva 命中 erp-gvax。 */
export function containsTerm(hayLower: string, term: unknown): boolean {
  const t = lower(term).trim();
  if (!t) return false;
  if (isAsciiTerm(t)) {
    let i = hayLower.indexOf(t);
    while (i >= 0) {
      const before = hayLower[i - 1];
      const after = hayLower[i + t.length];
      const beforeOk = !before || !/[a-z0-9]/.test(before);
      const afterOk = !after || !/[a-z0-9]/.test(after);
      if (beforeOk && afterOk) return true;
      i = hayLower.indexOf(t, i + 1);
    }
    return false;
  }
  return hayLower.includes(t);
}

function titleTokens(title: unknown): string[] {
  return String(title ?? "")
    .split(/[\s,，、;；:：/|()（）[\]【】「」]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 知识命中：标签命中权重高（+3），标题里的长词次之（+1）；
 * 至少命中一个才算相关。按分数、更新时间排序，最多 limit 条。
 */
export function matchKnowledge(text: string, items: RecallKnowledge[], limit = 3): RecallKnowledge[] {
  const hay = lower(text);
  if (!hay.trim()) return [];
  const scored = items
    .map((it) => {
      let score = 0;
      for (const tag of it.tags) {
        if (String(tag).trim().length >= 2 && containsTerm(hay, tag)) score += 3;
      }
      for (const tok of titleTokens(it.title)) {
        if (tok.length >= 4 && containsTerm(hay, tok)) score += 1;
      }
      return { it, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || (b.it.updatedAt ?? 0) - (a.it.updatedAt ?? 0) || a.it.id - b.it.id)
    .slice(0, Math.max(0, limit));
  return scored.map((x) => x.it);
}

export interface ObjectMatch {
  hits: RecallObject[];
  /** 在文本里出现、但一个词指向多个对象的 id（不猜，交给 resolve） */
  ambiguous: string[];
}

/**
 * 对象命中：按名称/别名匹配。一个词指向多个对象时视为歧义，整组跳过；
 * 同一对象因多个词命中只算一次，长词优先。
 */
export function matchObjects(text: string, items: RecallObject[], limit = 2): ObjectMatch {
  const hay = lower(text);
  if (!hay.trim()) return { hits: [], ambiguous: [] };
  const byId = new Map(items.map((o) => [o.id, o]));
  const owners = new Map<string, Set<string>>();
  for (const o of items) {
    for (const term of [o.name, ...(o.aliases ?? [])]) {
      const t = lower(term).trim();
      if (t.length < 2) continue;
      if (!owners.has(t)) owners.set(t, new Set());
      owners.get(t)!.add(o.id);
    }
  }
  const best = new Map<string, { obj: RecallObject; len: number }>();
  const ambiguous = new Set<string>();
  for (const [term, ids] of owners) {
    if (!containsTerm(hay, term)) continue;
    if (ids.size > 1) {
      for (const id of ids) ambiguous.add(id);
      continue;
    }
    const id = [...ids][0];
    const obj = byId.get(id);
    if (!obj) continue;
    const cur = best.get(id);
    if (!cur || term.length > cur.len) best.set(id, { obj, len: term.length });
  }
  const hits = [...best.values()]
    .sort((a, b) => b.len - a.len || a.obj.id.localeCompare(b.obj.id))
    .slice(0, Math.max(0, limit))
    .map((x) => x.obj);
  return { hits, ambiguous: [...ambiguous].filter((id) => !best.has(id)) };
}

function parseTags(raw: unknown): string[] {
  try {
    const v = JSON.parse(String(raw ?? "[]"));
    return Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function clip(s: unknown, n: number): string {
  const t = String(s ?? "").trim().replace(/\s+/g, " ");
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** 本轮未读里提到的知识/对象，拼成一小段注入块；没有命中返回空串（零增长）。 */
export function recallBlock(store: Store, unread: StoredMessage[]): string {
  const text = unread
    .filter((m) => !m.from_self && String(m.text ?? "").trim())
    .map((m) => m.text)
    .join("\n");
  if (!text.trim()) return "";

  const knowledge = store.searchKnowledge({ limit: 300 }).map((r) => ({
    id: Number(r.id),
    title: String(r.title ?? ""),
    tags: parseTags(r.tags),
    summary: clip(r.body, 32),
    updatedAt: Number(r.updated_at ?? 0),
  }));
  const kHits = matchKnowledge(text, knowledge, 3);

  let objectHits: RecallObject[] = [];
  let ambiguous: string[] = [];
  const rows = store.listBusinessObjects();
  if (rows.length) {
    const items: RecallObject[] = rows.map((o) => ({
      id: String(o.id),
      type: String(o.type),
      name: String(o.name ?? ""),
      aliases: parseTags(o.aliases),
      description: o.description ? String(o.description) : undefined,
    }));
    const r = matchObjects(text, items, 2);
    // 只对命中的对象查度数，避免为一句无关的话把整张地图算一遍。
    const degree = store.db.prepare(
      "SELECT count(*) AS c FROM business_edges WHERE from_id=? OR to_id=?",
    );
    objectHits = r.hits.map((o) => ({
      ...o,
      relations: Number((degree.get(o.id, o.id) as { c?: number } | undefined)?.c ?? 0),
    }));
    ambiguous = r.ambiguous;
  }

  if (!kHits.length && !objectHits.length && !ambiguous.length) return "";

  const lines = ["## 可能与当前对话相关（按提及命中，不是全量；要细节就用对应工具查）"];
  if (kHits.length) {
    lines.push("知识（全文用 knowledge action=search）：");
    for (const k of kHits) {
      const tags = k.tags.length ? `（标签: ${k.tags.slice(0, 4).join(", ")}）` : "";
      lines.push(`- #${k.id} ${k.title}${tags}${k.summary ? ` — ${k.summary}` : ""}`);
    }
  }
  if (objectHits.length) {
    lines.push("地图对象（关系/影响面用 map show / map impact）：");
    for (const o of objectHits) {
      const desc = o.description ? ` — ${clip(o.description, 40)}` : "";
      lines.push(`- ${o.id}（${o.type}）${o.name}${desc}；关系 ${o.relations ?? 0} 条`);
    }
  }
  if (ambiguous.length) {
    lines.push(`（另有 ${ambiguous.length} 个词指向多个对象，先别猜；要查用 map resolve。）`);
  }
  return lines.join("\n");
}
