#!/usr/bin/env node
/** 挑几条现在能聊的（只读：不记账，真用了要 topic-used）。
 *  npx tsx scripts/topic-pick.ts [--pool p1] [--n 3] */
import { run, openStore, describe, num, str } from "./lib/kit.ts";

describe('npx tsx scripts/topic-pick.ts [--pool P] [--n 3]');

await run(({ flags }) => {
  const store = openStore(flags);
  try {
    const poolRef = str(flags, "pool");
    const poolId = poolRef ? store.resolvePool(poolRef)?.pool_id ?? null : null;
    const rows = store.pickTopics(poolId, num(flags, "n") ?? 3, Date.now());
    return rows.map((r: any) => ({ id: r.id, kind: r.kind, content: r.content, used: r.used_count }));
  } finally { store.close(); }
});
