#!/usr/bin/env node
/** 列出所有聊天池：别名、类型、最后一条消息、总条数。 */
import { run, openStore, describe } from "./lib/kit.ts";
import { listPools } from "../src/ops/pools.ts";

describe("npx tsx scripts/pool-list.ts [--db 路径]");

await run(({ flags }) => {
  const store = openStore(flags);
  try {
    return listPools(store);
  } finally { store.close(); }
});
