/** 知识库：可复用的业务知识，一篇一条；和记忆、业务地图分开。 */
import type { Store } from "../core/db.ts";
import { clampInt, resolvePool } from "./common.ts";

export interface KnowledgeInput {
  title?: string;
  body?: string;
  tags?: string | string[];
  object_id?: string;
  pool?: string;
  source_seq?: string | number;
  source_seq_end?: string | number;
}

/** 标签统一成数组：数组、逗号/顿号/分号/空格分隔都能收。 */
export function normalizeTags(v: string | string[] | undefined): string[] {
  const raw = Array.isArray(v) ? v : String(v ?? "").split(/[,，、;；\s]+/);
  return [...new Set(raw.map((x) => String(x).trim()).filter(Boolean))];
}

function seq(v: string | number | undefined): number | null {
  if (v === undefined || v === null || String(v).trim() === "") return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function view(row: any) {
  let tags: string[] = [];
  try { tags = JSON.parse(row.tags || "[]"); } catch { tags = []; }
  return {
    id: row.id as number,
    title: row.title as string,
    body: row.body as string,
    tags,
    object_id: row.object_id || "",
    source: row.source_pool_id
      ? { pool: row.source_pool_id, from: row.source_seq_start ?? null, to: row.source_seq_end ?? row.source_seq_start ?? null }
      : null,
    created_at: row.created_at as number,
    updated_at: row.updated_at as number,
    retired: !!row.retired,
  };
}

export function addKnowledge(store: Store, input: KnowledgeInput, now = Date.now()) {
  const title = String(input.title ?? "").trim();
  const body = String(input.body ?? "").trim();
  if (!title) throw new Error("add 要 title（这篇知识叫什么）");
  if (!body) throw new Error("add 要 body（正文）");
  const pool = input.pool ? resolvePool(store, input.pool) : null;
  const start = seq(input.source_seq);
  const end = seq(input.source_seq_end) ?? start;
  const id = store.addKnowledge({
    title,
    body,
    tags: JSON.stringify(normalizeTags(input.tags)),
    object_id: String(input.object_id ?? "").trim(),
    source_pool_id: pool?.pool_id ?? "",
    source_seq_start: start,
    source_seq_end: start === null ? null : end,
    now,
  });
  return view(store.getKnowledge(id)!);
}

export function getKnowledge(store: Store, id: number) {
  const row = store.getKnowledge(id);
  if (!row) throw new Error(`没有知识 #${id}`);
  return view(row);
}

export function searchKnowledge(store: Store, input: { q?: string; tag?: string; limit?: string | number; all?: boolean } = {}) {
  const limit = input.limit === undefined ? undefined : Number(input.limit);
  return store.searchKnowledge({
    q: input.q?.trim() || undefined,
    tag: input.tag?.trim() || undefined,
    limit: clampInt(limit, 1, 100, 20),
    includeRetired: !!input.all,
  }).map(view);
}

export function updateKnowledge(store: Store, input: KnowledgeInput & { id?: string | number }, now = Date.now()) {
  const id = Number(input.id);
  if (!Number.isInteger(id) || id <= 0) throw new Error("update 要 id（知识编号）");
  const patch: { title?: string; body?: string; tags?: string; object_id?: string; now: number } = { now };
  if (input.title !== undefined) {
    const title = String(input.title).trim();
    if (!title) throw new Error("title 不能为空");
    patch.title = title;
  }
  if (input.body !== undefined) {
    const body = String(input.body).trim();
    if (!body) throw new Error("body 不能为空");
    patch.body = body;
  }
  if (input.tags !== undefined) patch.tags = JSON.stringify(normalizeTags(input.tags));
  if (input.object_id !== undefined) patch.object_id = String(input.object_id).trim();
  if (Object.keys(patch).length === 1) throw new Error("update 至少要改一项：title / body / tags / object_id");
  const row = store.updateKnowledge(id, patch);
  if (!row) throw new Error(`没有知识 #${id}`);
  return view(row);
}

export function archiveKnowledge(store: Store, input: { id?: string | number }, now = Date.now()) {
  const id = Number(input.id);
  if (!Number.isInteger(id) || id <= 0) throw new Error("archive 要 id（知识编号）");
  if (!store.retireKnowledge(id, now)) throw new Error(`没有知识 #${id}`);
  return view(store.getKnowledge(id)!);
}

/**
 * 常驻提示用的知识索引：只列标题和标签，不拉正文。
 * 目的不是替代 search，是让模型知道「有这些知识、该去查」，避免只写不读。
 */
export function knowledgeIndexLine(store: Store, limit = 12): string {
  const rows = store.searchKnowledge({ limit });
  if (!rows.length) return "";
  const items = rows.map((row) => {
    const title = String(row.title ?? "").trim();
    let tags: string[] = [];
    try { tags = JSON.parse(row.tags || "[]"); } catch { tags = []; }
    const head = tags.length ? `${title} [${tags.slice(0, 3).join(",")}]` : title;
    return head;
  });
  return `- 已有业务知识（用 \`knowledge\` action=search 查全文）：${items.join("；")}`;
}
