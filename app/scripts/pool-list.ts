#!/usr/bin/env node
/** 列出所有聊天池：别名、类型、最后一条消息、总条数。 */
import { run, openStore, describe } from "./lib/kit.ts";
import { fmtLocal } from "../src/core/time.ts";

describe("npx tsx scripts/pool-list.ts [--db 路径]");

await run(({ flags }) => {
  const store = openStore(flags);
  try {
    return store.listPools().map((p) => ({
      alias: store.poolAlias(p.pool_id),
      pool_id: p.pool_id,
      kind: p.kind,
      title: p.title ?? "",
      last_msg_at: p.last_msg_at || null,
      last_msg_local: p.last_msg_at ? fmtLocal(p.last_msg_at) : null,
      total: store.poolSpan(p.pool_id).total,
    }));
  } finally { store.close(); }
});
