#!/usr/bin/env node
/** 按关键词翻旧账。比一页页 read 快得多；命中的 seq 再拿去 pool-read --before-seq 看上下文。
 *  npx tsx scripts/pool-search.ts "火锅" --pool p1 [--limit 15] */
import { run, openStore, mustPool, describe, str, num } from "./lib/kit.ts";
import { fmtLocal } from "../src/core/time.ts";

describe("npx tsx scripts/pool-search.ts <关键词> --pool p1 [--limit 15]");

await run(({ pos, flags }) => {
  const kw = String(pos[0] ?? str(flags, "keyword") ?? "").trim().slice(0, 30);
  if (kw.length < 2) throw new Error("关键词至少两个字，太短会把整个池捞出来");
  const store = openStore(flags);
  try {
    const pool = mustPool(store, str(flags, "pool") ?? pos[1]);
    const limit = Math.min(30, Math.max(1, num(flags, "limit") ?? 15));
    const hits = store.searchMessages(pool.pool_id, kw, limit);
    return {
      pool: store.poolAlias(pool.pool_id), keyword: kw, hits: hits.length,
      total: store.poolSpan(pool.pool_id).total,
      messages: hits.map((m) => ({
        seq: m.seq, local: fmtLocal(m.ts), from_self: !!m.from_self, sender: m.sender_name, text: m.text,
      })),
    };
  } finally { store.close(); }
});
