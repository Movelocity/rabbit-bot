#!/usr/bin/env node
/** 记一条长期记忆。只记对方明说过的具体事实，不记推断。
 *  npx tsx scripts/mem-add.ts --user u1 --content "他对花生过敏" --pool p1 [--kind fact|topic] [--scope ...] */
import { run, openStore, describe, str } from "./lib/kit.ts";
import { addMemory } from "../src/ops/memories.ts";

describe('npx tsx scripts/mem-add.ts --user U --content C --pool P [--kind fact|topic] [--scope pool|private|group|all]');

await run(({ flags }) => {
  const store = openStore(flags);
  try {
    return addMemory(store, {
      user: str(flags, "user"),
      content: str(flags, "content"),
      pool: str(flags, "pool"),
      kind: str(flags, "kind"),
      scope: str(flags, "scope") as any,
    });
  } finally { store.close(); }
});
