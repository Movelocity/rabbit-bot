#!/usr/bin/env node
/** 用过一条谈资：记账 + 进冷却（默认 7 天），免得同一句话反复说。
 *  npx tsx scripts/topic-used.ts 12 [--days 7] */
import { run, openStore, describe, num } from "./lib/kit.ts";

describe('npx tsx scripts/topic-used.ts <id> [--days 7]');

await run(({ pos, flags }) => {
  const id = Number(pos[0]);
  if (!Number.isInteger(id)) throw new Error("用法：topic-used <id>");
  const store = openStore(flags);
  try {
    const ok = store.markTopicUsed(id, Date.now(), num(flags, "days") ?? 7);
    if (!ok) throw new Error(`没有这条谈资：#${id}`);
    return { id, coolingDays: num(flags, "days") ?? 7 };
  } finally { store.close(); }
});
