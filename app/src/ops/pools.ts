/** 池与消息的只读查询：宿主 API 和沙盒 rb 客户端共用。 */
import type { Store } from "../core/db.ts";
import { fmtLocal } from "../core/time.ts";
import { clampInt, resolvePool } from "./common.ts";

export function listPools(
  store: Store,
  opts: { includeArchived?: boolean; mainPoolId?: string | null } = {},
) {
  return store.listPools({ includeArchived: opts.includeArchived }).map((p) => ({
    alias: store.poolAlias(p.pool_id),
    pool_id: p.pool_id,
    kind: p.kind,
    title: store.poolDisplayTitle(p),
    archived: p.archived,
    is_main: !!opts.mainPoolId && p.pool_id === opts.mainPoolId,
    last_msg_at: p.last_msg_at || null,
    last_msg_local: p.last_msg_at ? fmtLocal(p.last_msg_at) : null,
    total: store.poolSpan(p.pool_id).total,
  }));
}

/** 归档/解档；池不存在抛错（API 和工具都用它，省得各自判空）。 */
export function archivePool(store: Store, ref: string, archived = true) {
  const pool = resolvePool(store, ref);
  store.archivePool(pool.pool_id, archived);
  return { pool: store.poolAlias(pool.pool_id), pool_id: pool.pool_id, archived };
}

/** 池消息对外展示的发送者：优先身份映射里的名字，映射不到才用入池时的原名。 */
function senderOf(store: Store, m: { platform: string; sender_id: string; sender_name: string }): string {
  return store.userDisplayName(m.platform, m.sender_id) || m.sender_name;
}

export interface ReadPoolOptions {
  limit?: number;
  /** 从这个 seq 之前开始读（不含），用于翻页 */
  beforeSeq?: number;
}

export function readPool(store: Store, ref: string | undefined, opts: ReadPoolOptions = {}) {
  const pool = resolvePool(store, ref);
  const limit = clampInt(opts.limit, 1, 50, 15);
  const before = Number.isFinite(opts.beforeSeq as number) ? (opts.beforeSeq as number) : undefined;
  const msgs = store.recentMessages(pool.pool_id, limit, before ? before - 1 : undefined);
  const span = store.poolSpan(pool.pool_id);
  return {
    pool: store.poolAlias(pool.pool_id),
    total: span.total,
    oldest_seq: span.first?.seq ?? null,
    messages: msgs.map((m) => ({
      seq: m.seq,
      ts: m.ts,
      local: fmtLocal(m.ts),
      from_self: !!m.from_self,
      sender: senderOf(store, m),
      sender_name: m.sender_name,
      sender_id: m.sender_id,
      user_id: m.user_id,
      text: m.text,
    })),
  };
}

export function searchPool(
  store: Store, keyword: string, ref: string | undefined, limit?: number, only?: "self" | "other",
) {
  const kw = String(keyword ?? "").trim().slice(0, 30);
  if (kw.length < 2) throw new Error("关键词至少两个字，太短会把整个池捞出来");
  const pool = resolvePool(store, ref);
  const n = clampInt(limit, 1, 50, 20);
  const who = only === "self" || only === "other" ? only : undefined;
  const hits = store.searchMessages(pool.pool_id, kw, n, who);
  return {
    pool: store.poolAlias(pool.pool_id),
    keyword: kw,
    hits: hits.length,
    only: who ?? "both",
    // 只给了最近 n 条：关键词说得多的时候，最早那条真相往往被挤掉。
    // 明说「被截断了」而不是让她以为「就这些」，否则她会拿「没有」当结论。
    truncated: hits.length >= n,
    hint: hits.length >= n
      ? `结果按最新 ${n} 条截断，更早的可能没给。查「他说没说」加 --only-other 只看他发的。`
      : undefined,
    total: store.poolSpan(pool.pool_id).total,
    messages: hits.map((m) => ({
      seq: m.seq,
      local: fmtLocal(m.ts),
      from_self: !!m.from_self,
      sender: senderOf(store, m),
      sender_name: m.sender_name,
      text: m.text,
    })),
  };
}
