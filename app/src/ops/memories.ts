/** 长期记忆：写入与检索。宿主 API 和沙盒 rb 客户端共用。 */
import type { Store } from "../core/db.ts";
import type { MemoryScope } from "../types.ts";
import { clampInt, resolvePool } from "./common.ts";

const SCOPES: MemoryScope[] = ["pool", "private", "group", "all"];

export interface AddMemoryInput {
  user?: string;
  content?: string;
  pool?: string;
  kind?: string;
  scope?: MemoryScope;
}

export function addMemory(store: Store, input: AddMemoryInput) {
  const user = input.user;
  const content = input.content;
  if (!user || !content) throw new Error("缺少 user 或 content");
  if (input.scope && !SCOPES.includes(input.scope)) throw new Error(`scope 只能是 ${SCOPES.join(" / ")}`);
  const pool = resolvePool(store, input.pool);
  const scope: MemoryScope = input.scope ?? (pool.kind === "private" ? "private" : "group");
  const id = store.addMemory({
    user_id: user,
    kind: input.kind as any,
    content,
    source_pool_id: pool.pool_id,
    source_kind: pool.kind,
    scope,
  });
  return { id, scope };
}

export function searchMemories(store: Store, user: string | undefined, poolRef: string | undefined, limit?: number) {
  if (!user) throw new Error("缺少 user");
  const pool = resolvePool(store, poolRef);
  const ms = store.visibleMemories(user, pool, clampInt(limit, 1, 200, 20)) as any[];
  return ms.map((m) => ({ id: m.id, kind: m.kind, scope: m.scope, content: m.content }));
}
