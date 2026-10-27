#!/usr/bin/env node
/** 改计划状态。npx tsx scripts/plan-update.ts 12 --status done */
import { run, openStore, describe, str } from "./lib/kit.ts";

describe("npx tsx scripts/plan-update.ts <id> --status pending|done|cancelled");

await run(({ pos, flags }) => {
  const id = Number(pos[0] ?? str(flags, "id"));
  const status = str(flags, "status") as "pending" | "done" | "cancelled" | undefined;
  if (!id || !status) throw new Error("用法：plan-update.ts <id> --status done");
  const store = openStore(flags);
  try {
    if (!store.setPlanStatus(id, status)) throw new Error(`没有计划 #${id}`);
    return { id, status };
  } finally { store.close(); }
});
