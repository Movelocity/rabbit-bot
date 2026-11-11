/** 计划看板的 API / Web 视图：把 md 解析结果补上本地时间，不写文件。 */
import { fmtLocal } from "../core/time.ts";
import type { Board } from "../core/board.ts";

export function formatBoard(b: Board) {
  return {
    slug: b.slug,
    title: b.title,
    status: b.status,
    pool: b.pool,
    tags: b.tags,
    background: b.background,
    goals: b.goals,
    goals_total: b.goals.length,
    goals_done: b.goals.filter((g) => g.done).length,
    progress: b.progress.map((p) => ({
      at: p.at,
      at_local: p.at === null ? null : fmtLocal(p.at),
      text: p.text,
    })),
    created_at: b.createdAt,
    created_at_local: b.createdAt === null ? null : fmtLocal(b.createdAt),
    updated_at: b.updatedAt,
    updated_at_local: b.updatedAt === null ? null : fmtLocal(b.updatedAt),
    path: b.path,
  };
}
