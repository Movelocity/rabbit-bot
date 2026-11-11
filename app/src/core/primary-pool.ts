/**
 * 「这一轮到底在跟谁说话」——记忆、搜索、看板不带池时的默认落点。
 */
import type { Store } from "./db.ts";
import type { Wake } from "../types.ts";

export function resolvePrimaryPool(store: Store, w: Wake | null | undefined): string | null {
  const pools = [...(w?.pools ?? [])];
  if (pools.length) {
    // 多个池同时触发时，优先有未读的那个（真正在说话的人）
    return pools.find((pid) => store.unread(pid, 1).length) ?? pools[0];
  }
  const proactive = w?.proactive?.find((x) => x.pool)?.pool;
  if (proactive) return proactive;
  // 纯 tick：取最近有消息的池
  const recent = store.listPools()
    .filter((p) => p.last_msg_at)
    .sort((a, b) => (b.last_msg_at ?? 0) - (a.last_msg_at ?? 0))[0];
  return recent?.pool_id ?? null;
}
