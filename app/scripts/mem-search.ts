#!/usr/bin/env node
/** 查某个 user 在某个池里能看到的记忆。npx tsx scripts/mem-search.ts --user u1 --pool p1 [--limit 20] */
import { run, openStore, describe, str, num } from "./lib/kit.ts";
import { searchMemories } from "../src/ops/memories.ts";

describe("npx tsx scripts/mem-search.ts --user U --pool P [--limit 20]");

await run(({ flags }) => {
  const store = openStore(flags);
  try {
    return searchMemories(store, str(flags, "user"), str(flags, "pool"), num(flags, "limit"));
  } finally { store.close(); }
});
