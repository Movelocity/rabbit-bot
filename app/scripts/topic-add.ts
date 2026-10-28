#!/usr/bin/env node
/** 记一条谈资：梗、冷笑话、聊过还想再提的话题。
 *  npx tsx scripts/topic-add.ts --content "冰箱里的钱拿去充原神" --kind meme [--pool p1] [--source "他说的"] */
import { run, openStore, describe, str, now } from "./lib/kit.ts";

describe('npx tsx scripts/topic-add.ts --content C [--kind joke|meme|topic] [--pool P] [--source S]');

/** 每天最多记几条：不封顶的话一天能塞 50 条没人看的「梗」，挑的时候全是噪声 */
const MAX_PER_DAY = 3;

await run(({ flags }) => {
  const content = str(flags, "content");
  if (!content) throw new Error("缺少 --content");
  if (content.length > 200) throw new Error("太长：谈资要一句能复述的话，超过 200 字就记不住也说不出口");
  const store = openStore(flags);
  try {
    const t = now(flags);
    const dayStart = t - ((t + 8 * 3600e3) % 86400e3);
    const used = store.countTopicsAddedSince(dayStart);
    if (used >= MAX_PER_DAY) throw new Error(`今天已经记了 ${used} 条（上限 ${MAX_PER_DAY}）——明天再说，别一次塞一堆`);
    const poolRef = str(flags, "pool");
    const poolId = poolRef ? store.resolvePool(poolRef)?.pool_id ?? null : null;
    const id = store.addTopic({
      content, kind: str(flags, "kind") ?? "topic",
      pool_id: poolId, source: str(flags, "source") ?? "", now: t,
    });
    return { id, todayAdded: used + 1, limit: MAX_PER_DAY };
  } finally { store.close(); }
});
