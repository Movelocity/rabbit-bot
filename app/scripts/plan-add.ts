#!/usr/bin/env node
/** 写一条计划。
 *  npx tsx scripts/plan-add.ts --title "问他面试结果" --kind once --when 2026-10-27T22:00 --pool p1 --why "他说今天出结果" */
import { run, openStore, describe, str, now } from "./lib/kit.ts";
import { loadConfig } from "../src/config.ts";
import { addPlan } from "../src/ops/plans.ts";

describe('npx tsx scripts/plan-add.ts --title T --kind once|cron|none [--when V] [--pool P] [--anchor L0|L1|L2] [--why W] [--expires ISO]');

await run(({ flags }) => {
  const cfg = loadConfig({});
  const store = openStore(flags);
  try {
    return addPlan(store, cfg.timezone, {
      title: str(flags, "title"),
      content: str(flags, "content"),
      kind: (str(flags, "kind") ?? "none") as "once" | "cron" | "none",
      when: str(flags, "when"),
      pool: str(flags, "pool"),
      anchor: (str(flags, "anchor") as any) ?? null,
      why: str(flags, "why") ?? null,
      expires: str(flags, "expires"),
    }, now(flags));
  } finally { store.close(); }
});
