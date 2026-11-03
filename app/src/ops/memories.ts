/** 长期记忆：写入与检索。宿主 API 和沙盒 rb 客户端共用。 */
import type { Store } from "../core/db.ts";
import type { MemoryScope } from "../types.ts";
import { clampInt, resolvePool } from "./common.ts";
import { findAliases, parseAliasContent } from "../core/alias.ts";

const SCOPES: MemoryScope[] = ["pool", "private", "group", "all"];
const KINDS = ["fact", "plan", "alias", "topic"] as const;

export interface AddMemoryInput {
  user?: string;
  content?: string;
  pool?: string;
  kind?: string;
  scope?: MemoryScope;
  /** 这条记忆说的是「从什么时候开始」的事。ISO 字符串或毫秒时间戳 */
  from?: string | number;
  /** 到期时间。给了就是「只在那之前成立」 */
  until?: string | number;
  /** 顶掉哪条旧记忆：新条目写好之后，旧的那条立刻失效 */
  supersede?: string | number;
}

/** ISO / 毫秒时间戳 → 毫秒。只认这两种，别猜格式 */
export function parseTs(v: string | number | undefined | null): number | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (/^\d{10,}$/.test(s)) return Number(s);
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error(`看不懂的时间：${v}（用 ISO，如 2026-11-03 或 2026-11-03T19:00:00+08:00）`);
  return t;
}

export function addMemory(store: Store, input: AddMemoryInput) {
  const user = input.user;
  const content = input.content;
  if (!user || !content) throw new Error("缺少 user 或 content");
  if (input.scope && !SCOPES.includes(input.scope)) throw new Error(`scope 只能是 ${SCOPES.join(" / ")}`);
  if (input.kind && !(KINDS as readonly string[]).includes(input.kind)) {
    throw new Error(`kind 只能是 ${KINDS.join(" / ")}（alias = 说法到指向的映射，比如「那个项目」→ 电商 Agent）`);
  }
  const pool = resolvePool(store, input.pool);
  const scope: MemoryScope = input.scope ?? (pool.kind === "private" ? "private" : "group");

  const validFrom = parseTs(input.from);
  const validTo = parseTs(input.until);
  if (validFrom !== null && validTo !== null && validTo <= validFrom) {
    throw new Error("until 必须晚于 from，否则这条一写出来就已经失效了");
  }

  // 顶旧的要核对：只能顶同一个人的，别人那条不许动
  let supersede: number | null = null;
  const supRaw = input.supersede;
  if (supRaw !== undefined && supRaw !== null && String(supRaw).trim() !== "") {
    const id = Number(supRaw);
    if (!Number.isInteger(id) || id <= 0) throw new Error(`supersede 要的是记忆 id（整数），收到 ${supRaw}`);
    const old = store.getMemory(id);
    if (!old) throw new Error(`没有 id=${id} 这条记忆`);
    if (old.user_id !== user) throw new Error(`id=${id} 不是 ${user} 的记忆，不能替他顶掉`);
    supersede = id;
  }

  const id = store.addMemory({
    user_id: user,
    kind: input.kind as any,
    content,
    source_pool_id: pool.pool_id,
    source_kind: pool.kind,
    scope,
    valid_from: validFrom,
    valid_to: validTo,
    supersede,
  });
  return { id, scope, superseded: supersede };
}

export interface SearchMemoryInput {
  user?: string;
  pool?: string;
  limit?: number;
  /** 正文关键词（LIKE） */
  q?: string;
  /** 查「那一刻」有效的记忆（不传 = 此刻） */
  at?: string | number;
  /** 连失效的一起给 */
  all?: boolean;
}

export function searchMemories(store: Store, input: SearchMemoryInput) {
  if (!input.user) throw new Error("缺少 user");
  const pool = resolvePool(store, input.pool);
  const at = parseTs(input.at);
  const ms = store.visibleMemories(input.user, pool, clampInt(input.limit, 1, 200, 20), {
    at: at ?? undefined,
    includeExpired: !!input.all,
    q: input.q?.trim() || undefined,
  }) as any[];
  return ms.map((m) => ({
    id: m.id,
    kind: m.kind,
    scope: m.scope,
    content: m.content,
    // 有效期的三种状态，让她自己看得出「这条是过去的」
    from: m.valid_from ?? m.created_at,
    to: m.valid_to ?? null,
    replaced_by: m.superseded_by ?? null,
  }));
}

/**
 * 检索前置：先把他这次说的话里出现的别名翻出来。
 * 每轮唤醒都跑一次（纯本地字符串匹配，不调模型、不花钱）。
 */
export function resolveAliases(store: Store, input: { user?: string; pool?: string; text?: string }) {
  if (!input.user) return [];
  const pool = resolvePool(store, input.pool);
  const rows = store.visibleMemories(input.user, pool, 200, { kinds: ["alias"] }) as any[];
  const aliases = rows
    .map((r) => {
      const p = parseAliasContent(r.content);
      return p ? { id: Number(r.id), alias: p.alias, target: p.target } : null;
    })
    .filter((x): x is { id: number; alias: string; target: string } => !!x);
  return findAliases(input.text ?? "", aliases);
}

/**
 * 只关掉一条记忆，不写新的。
 *
 * 有些事不是被新事实顶掉，而是本来就不再成立（「他这周在出差」回来了、「我在减肥」没减了）。
 * 逼着人写一条新事实来顶，等于让她自己编一句废话——编出来的那句下次又变成事实。
 */
export function closeMemory(store: Store, input: { user?: string; id?: string | number; at?: string | number }) {
  if (!input.user) throw new Error("缺少 user");
  const id = Number(input.id);
  if (!Number.isInteger(id) || id <= 0) throw new Error(`要的是记忆 id（整数），收到 ${input.id}`);
  const m = store.getMemory(id);
  if (!m) throw new Error(`没有 id=${id} 这条记忆`);
  if (m.user_id !== input.user) throw new Error(`id=${id} 不是 ${input.user} 的记忆，不能替他关`);
  const at = parseTs(input.at) ?? Date.now();
  const already = m.valid_to ? Number(m.valid_to) : null;
  if (already && already <= at) return { id, closed_at: already, already: true };
  store.closeMemoryRow(id, at);
  return { id, closed_at: at, already: false };
}

/**
 * 就地改一条记忆的正文：订正错字、补上细节。
 *
 * 和「写新的顶掉旧的」不同——这个不动时间线，是「还是同一件事，之前记岔了」。
 * 事实真的变了（想辞职 → 想升职）就别用这个，那是有先后顺序的两件事。
 */
export function updateMemory(store: Store, input: { user?: string; id?: string | number; content?: string; from?: string | number }) {
  if (!input.user) throw new Error("缺少 user");
  const id = Number(input.id);
  if (!Number.isInteger(id) || id <= 0) throw new Error(`要的是记忆 id（整数），收到 ${input.id}`);
  if (input.content === undefined && input.from === undefined) throw new Error("要改什么？给 content（正文）或 from（从什么时候起）");
  const m = store.getMemory(id);
  if (!m) throw new Error(`没有 id=${id} 这条记忆`);
  if (m.user_id !== input.user) throw new Error(`id=${id} 不是 ${input.user} 的记忆，不能替他改`);
  const patch: { content?: string; valid_from?: number | null } = {};
  if (input.content !== undefined) {
    if (!String(input.content).trim()) throw new Error("正文不能改成空的——不想留了就用 expire 关掉");
    patch.content = String(input.content);
  }
  if (input.from !== undefined) patch.valid_from = parseTs(input.from);
  store.updateMemoryRow(id, patch);
  return { id, content: patch.content ?? m.content, from: patch.valid_from ?? m.valid_from ?? m.created_at };
}
