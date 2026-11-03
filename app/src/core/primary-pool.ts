/**
 * 「这一轮到底在跟谁说话」——记忆、计划、搜索不带池时的默认落点。
 *
 * 消息唤醒有 pools；计划唤醒的 pools 是空的（它是按时间触发的，不是按消息来的），
 * 所以必须顺着 planFires 回查那条计划当初排给哪个池。漏了这一步，她在提醒到点的时候
 * 给自己排下一次会报「这一轮没有对应的池」——而这是她最需要写记忆的时刻之一。
 */
import type { Store } from "./db.ts";
import type { Wake } from "../types.ts";

export function resolvePrimaryPool(store: Store, w: Wake | null | undefined): string | null {
  const pools = [...(w?.pools ?? [])];
  if (pools.length) {
    // 多个池同时触发时，优先有未读的那个（真正在说话的人）
    return pools.find((pid) => store.unread(pid, 1).length) ?? pools[0];
  }
  for (const f of w?.planFires ?? []) {
    const plan = store.getPlan(f.planId);
    if (plan?.pool_id) return plan.pool_id;
  }
  const proactive = w?.proactive?.find((x) => x.pool)?.pool;
  if (proactive) return proactive;
  // 纯 tick：取最近有消息的池
  const recent = store.listPools()
    .filter((p) => p.last_msg_at)
    .sort((a, b) => (b.last_msg_at ?? 0) - (a.last_msg_at ?? 0))[0];
  return recent?.pool_id ?? null;
}
