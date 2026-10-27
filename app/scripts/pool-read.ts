#!/usr/bin/env node
/** 读某个池的历史消息（不动未读游标）。
 *  npx tsx scripts/pool-read.ts p1 [--limit 20] [--before-seq 300] */
import { run, openStore, mustPool, describe, str, num } from "./lib/kit.ts";
import { fmtLocal } from "../src/core/time.ts";

describe("npx tsx scripts/pool-read.ts <池别名> [--limit 20] [--before-seq N] [--db 路径]");

await run(({ pos, flags }) => {
  const store = openStore(flags);
  try {
    const pool = mustPool(store, pos[0] ?? str(flags, "pool"));
    const limit = Math.min(50, Math.max(1, num(flags, "limit") ?? 15));
    const before = num(flags, "before-seq");
    const msgs = store.recentMessages(pool.pool_id, limit, before ? before - 1 : undefined);
    const span = store.poolSpan(pool.pool_id);
    return {
      pool: store.poolAlias(pool.pool_id), total: span.total,
      oldest_seq: span.first?.seq ?? null,
      messages: msgs.map((m) => ({
        seq: m.seq, ts: m.ts, local: fmtLocal(m.ts),
        from_self: !!m.from_self, sender: m.sender_name, text: m.text,
      })),
    };
  } finally { store.close(); }
});
