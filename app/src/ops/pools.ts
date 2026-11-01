/** 池与消息的只读查询：宿主 API 和沙盒 rb 客户端共用。 */
import type { Store } from "../core/db.ts";
import { fmtLocal } from "../core/time.ts";
import { clampInt, resolvePool } from "./common.ts";

export function listPools(store: Store) {
  return store.listPools().map((p) => ({
    alias: store.poolAlias(p.pool_id),
    pool_id: p.pool_id,
    kind: p.kind,
    title: p.title ?? "",
    last_msg_at: p.last_msg_at || null,
    last_msg_local: p.last_msg_at ? fmtLocal(p.last_msg_at) : null,
    total: store.poolSpan(p.pool_id).total,
  }));
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
      sender: m.sender_name,
      text: m.text,
    })),
  };
}

export function searchPool(store: Store, keyword: string, ref: string | undefined, limit?: number) {
  const kw = String(keyword ?? "").trim().slice(0, 30);
  if (kw.length < 2) throw new Error("关键词至少两个字，太短会把整个池捞出来");
  const pool = resolvePool(store, ref);
  const hits = store.searchMessages(pool.pool_id, kw, clampInt(limit, 1, 30, 15));
  return {
    pool: store.poolAlias(pool.pool_id),
    keyword: kw,
    hits: hits.length,
    total: store.poolSpan(pool.pool_id).total,
    messages: hits.map((m) => ({
      seq: m.seq,
      local: fmtLocal(m.ts),
      from_self: !!m.from_self,
      sender: m.sender_name,
      text: m.text,
    })),
  };
}
