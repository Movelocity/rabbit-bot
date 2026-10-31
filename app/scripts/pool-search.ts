#!/usr/bin/env node
/** 按关键词翻旧账。比一页页 read 快得多；命中的 seq 再拿去 pool-read --before-seq 看上下文。
 *  npx tsx scripts/pool-search.ts "火锅" --pool p1 [--limit 15] */
import { run, openStore, describe, str, num } from "./lib/kit.ts";
import { searchPool } from "../src/ops/pools.ts";

describe("npx tsx scripts/pool-search.ts <关键词> --pool p1 [--limit 15]");

await run(({ pos, flags }) => {
  const store = openStore(flags);
  try {
    return searchPool(store, String(pos[0] ?? str(flags, "keyword") ?? ""), str(flags, "pool") ?? pos[1], num(flags, "limit"));
  } finally { store.close(); }
});
