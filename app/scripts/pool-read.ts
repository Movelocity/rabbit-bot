#!/usr/bin/env node
/** 读某个池的历史消息（不动未读游标）。
 *  npx tsx scripts/pool-read.ts p1 [--limit 20] [--before-seq 300] */
import { run, openStore, describe, str, num } from "./lib/kit.ts";
import { readPool } from "../src/ops/pools.ts";

describe("npx tsx scripts/pool-read.ts <池别名> [--limit 20] [--before-seq N] [--db 路径]");

await run(({ pos, flags }) => {
  const store = openStore(flags);
  try {
    return readPool(store, pos[0] ?? str(flags, "pool"), {
      limit: num(flags, "limit"),
      beforeSeq: num(flags, "before-seq"),
    });
  } finally { store.close(); }
});
