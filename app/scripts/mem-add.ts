#!/usr/bin/env node
/** 记一条长期记忆。只记对方明说过的具体事实，不记推断。
 *  npx tsx scripts/mem-add.ts --user u1 --content "他对花生过敏" --pool p1 [--kind fact|topic] [--scope ...] */
import { run, openStore, mustPool, describe, str } from "./lib/kit.ts";
import type { MemoryScope } from "../src/types.ts";

describe('npx tsx scripts/mem-add.ts --user U --content C --pool P [--kind fact|topic] [--scope pool|private|group|all]');

await run(({ flags }) => {
  const user = str(flags, "user");
  const content = str(flags, "content");
  if (!user || !content) throw new Error("缺少 --user 或 --content");
  const store = openStore(flags);
  try {
    const pool = mustPool(store, str(flags, "pool"));
    const scope: MemoryScope = (str(flags, "scope") as MemoryScope) ?? (pool.kind === "private" ? "private" : "group");
    const id = store.addMemory({
      user_id: user, kind: (str(flags, "kind") as any) ?? undefined, content,
      source_pool_id: pool.pool_id, source_kind: pool.kind, scope,
    });
    return { id, scope };
  } finally { store.close(); }
});
