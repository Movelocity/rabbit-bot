#!/usr/bin/env node
/** 改计划状态。npx tsx scripts/plan-update.ts 12 --status done */
import { run, openStore, describe, str } from "./lib/kit.ts";
import { updatePlan } from "../src/ops/plans.ts";

describe("npx tsx scripts/plan-update.ts <id> --status pending|done|cancelled");

await run(({ pos, flags }) => {
  const store = openStore(flags);
  try {
    return updatePlan(store, Number(pos[0] ?? str(flags, "id")), str(flags, "status") ?? "");
  } finally { store.close(); }
});
