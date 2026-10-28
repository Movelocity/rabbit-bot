#!/usr/bin/env node
/** 列谈资（默认不含退役的）。
 *  npx tsx scripts/topic-list.ts [--kind joke] [--all] [--limit 20] */
import { run, openStore, describe, str, num, bool } from "./lib/kit.ts";

describe('npx tsx scripts/topic-list.ts [--kind joke|meme|topic] [--all] [--limit N]');

await run(({ flags }) => {
  const store = openStore(flags);
  try {
    const rows = store.listTopics({
      kind: str(flags, "kind"), includeRetired: bool(flags, "all"), limit: num(flags, "limit") ?? 20,
    });
    return rows.map((r: any) => ({
      id: r.id, kind: r.kind, content: r.content, source: r.source,
      used: r.used_count, pool: r.pool_id ? store.poolAlias(r.pool_id) : null,
      cooling: r.cooldown_until > Date.now(), retired: !!r.retired,
    }));
  } finally { store.close(); }
});
