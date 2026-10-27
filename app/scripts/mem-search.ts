#!/usr/bin/env node
/** 查某个 user 在某个池里能看到的记忆。npx tsx scripts/mem-search.ts --user u1 --pool p1 [--limit 20] */
import { run, openStore, mustPool, describe, str, num } from "./lib/kit.ts";

describe("npx tsx scripts/mem-search.ts --user U --pool P [--limit 20]");

await run(({ flags }) => {
  const user = str(flags, "user");
  if (!user) throw new Error("缺少 --user");
  const store = openStore(flags);
  try {
    const pool = mustPool(store, str(flags, "pool"));
    const ms = store.visibleMemories(user, pool, num(flags, "limit") ?? 20) as any[];
    return ms.map((m) => ({ id: m.id, kind: m.kind, scope: m.scope, content: m.content }));
  } finally { store.close(); }
});
