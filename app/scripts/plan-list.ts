#!/usr/bin/env node
/** 列计划。npx tsx scripts/plan-list.ts [--status pending|done|cancelled] */
import { run, openStore, describe, str } from "./lib/kit.ts";
import { listPlans } from "../src/ops/plans.ts";

describe("npx tsx scripts/plan-list.ts [--status pending|done|cancelled]");

await run(({ flags }) => {
  const store = openStore(flags);
  try {
    return listPlans(store, str(flags, "status") ?? "pending");
  } finally { store.close(); }
});
