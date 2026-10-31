/** 业务操作的公共小件：脚本和 HTTP API 共用，避免两份校验逻辑漂移。 */
import type { Store } from "../core/db.ts";
import type { Pool } from "../types.ts";

export function resolvePool(store: Store, ref: string | undefined | null): Pool {
  if (!ref) throw new Error("缺少池参数（先跑 pool-list 看有哪些）");
  const pool = store.resolvePool(ref);
  if (!pool) throw new Error(`未知的池 ${ref}`);
  return pool;
}

export function clampInt(v: number | undefined, min: number, max: number, fallback: number): number {
  const n = Number.isFinite(v as number) ? Math.floor(v as number) : fallback;
  return Math.min(max, Math.max(min, n));
}
