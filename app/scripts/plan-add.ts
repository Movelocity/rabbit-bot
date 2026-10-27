#!/usr/bin/env node
/** 写一条计划。
 *  npx tsx scripts/plan-add.ts --title "问他面试结果" --kind once --when 2026-10-27T22:00 --pool p1 --why "他说今天出结果" */
import { run, openStore, mustPool, describe, str, now } from "./lib/kit.ts";
import { loadConfig } from "../src/config.ts";
import { validateSchedule } from "../src/core/plans.ts";
import { parseIsoInTz, fmtLocal } from "../src/core/time.ts";

describe('npx tsx scripts/plan-add.ts --title T --kind once|cron|none [--when V] [--pool P] [--anchor L0|L1|L2] [--why W] [--expires ISO]');

await run(({ flags }) => {
  const cfg = loadConfig({});
  const title = str(flags, "title");
  if (!title) throw new Error("缺少 --title");
  const kind = (str(flags, "kind") ?? "none") as "once" | "cron" | "none";
  const v = validateSchedule({ kind, value: str(flags, "when") }, now(flags), cfg.timezone);
  if (!v.ok) throw new Error(`计划格式错误：${v.error}`);
  let expires: number | null = null;
  if (str(flags, "expires")) {
    expires = parseIsoInTz(String(str(flags, "expires")), cfg.timezone);
    if (expires === null) throw new Error("--expires 不是合法 ISO 时间");
  }
  const store = openStore(flags);
  try {
    const pool = str(flags, "pool") ? mustPool(store, str(flags, "pool")) : undefined;
    const plan = store.insertPlan({
      title, content: str(flags, "content") ?? "", pool_id: pool?.pool_id ?? null,
      schedule_kind: v.kind, schedule: v.schedule, expires_at: expires,
      anchor_kind: (str(flags, "anchor") as any) ?? null, why: str(flags, "why") ?? null,
    });
    return { id: plan.id, first_fire_local: v.firstFire ? fmtLocal(v.firstFire) : null, anchor: str(flags, "anchor") ?? "L2" };
  } finally { store.close(); }
});
