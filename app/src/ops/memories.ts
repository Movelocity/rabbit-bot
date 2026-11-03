/** 长期记忆：写入与检索。宿主 API 和沙盒 rb 客户端共用。 */
import type { Store } from "../core/db.ts";
import type { MemoryScope } from "../types.ts";
import { clampInt, resolvePool } from "./common.ts";

const SCOPES: MemoryScope[] = ["pool", "private", "group", "all"];
const KINDS = ["fact", "plan", "alias"] as const;

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
