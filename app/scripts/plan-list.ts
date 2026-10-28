#!/usr/bin/env node
/** 列计划。npx tsx scripts/plan-list.ts [--status pending|done|cancelled] */
import { run, openStore, describe, str } from "./lib/kit.ts";
import { fmtLocal } from "../src/core/time.ts";

describe("npx tsx scripts/plan-list.ts [--status pending|done|cancelled]");

await run(({ flags }) => {
  const status = (str(flags, "status") ?? "pending") as "pending" | "done" | "cancelled";
  const store = openStore(flags);
  try {
    return store.listPlans(status).map((p: any) => ({
      id: p.id, title: p.title, status: p.status, kind: p.schedule_kind,
      schedule: p.schedule ?? null, anchor: p.anchor_kind ?? null,
      pool: p.pool_id ? store.poolAlias(p.pool_id) : null,
      // once 的直接算出本地时间；cron 的就给表达式（下一次要跑 plans.ts 里的调度器才算得准）
      next_fire_local: p.schedule_kind === "once" && p.schedule ? fmtLocal(Date.parse(p.schedule)) : null,
      why: p.why ?? null,
    }));
  } finally { store.close(); }
});
