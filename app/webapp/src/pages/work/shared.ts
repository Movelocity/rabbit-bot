import type { Project, TaskStatus, TaskView } from "../../lib/types.ts";
import type { BadgeVariant } from "../../lib/format.ts";

export type StatusGroupKey = "pending" | "running" | "blocked" | "done";

export const STATUS_GROUPS: {
  key: StatusGroupKey;
  title: string;
  statuses: TaskStatus[];
  variant: BadgeVariant;
  dot: string;
}[] = [
  { key: "pending", title: "待审批", statuses: ["pending_approval", "pending"], variant: "warn", dot: "bg-amber" },
  { key: "running", title: "进行中", statuses: ["running"], variant: "info", dot: "bg-accent" },
  { key: "blocked", title: "阻塞", statuses: ["blocked", "failed"], variant: "closed", dot: "bg-rose" },
  { key: "done", title: "已结束", statuses: ["done", "cancelled"], variant: "default", dot: "bg-line-strong" },
];

export const STATUS_LABEL: Record<string, string> = {
  pending_approval: "待审批",
  pending: "排队中",
  running: "执行中",
  blocked: "已阻塞",
  done: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

export function statusGroupOf(status: string): StatusGroupKey {
  for (const g of STATUS_GROUPS) if ((g.statuses as string[]).includes(status)) return g.key;
  return "done";
}

export interface TaskSummary {
  total: number;
  running: number;
  pending: number;
  blocked: number;
  done: number;
}

export function summarizeTasks(tasks: TaskView[]): TaskSummary {
  const s: TaskSummary = { total: tasks.length, running: 0, pending: 0, blocked: 0, done: 0 };
  for (const t of tasks) s[statusGroupOf(t.status)]++;
  return s;
}

export function isMissingDoc(project: Project): boolean {
  return !project.plan.trim() || !project.context.trim();
}

export type ProjectGroupKey = "active" | "planned" | "done";

export const PROJECT_GROUPS: { key: ProjectGroupKey; label: string; tone: "accent" | "default" | "ok" }[] = [
  { key: "active", label: "推进中", tone: "accent" },
  { key: "planned", label: "计划中", tone: "default" },
  { key: "done", label: "已完成", tone: "ok" },
];

export function projectGroup(project: Project, summary: TaskSummary): ProjectGroupKey {
  const status = project.status.trim();
  if (/完成|已上线|已结项|\bdone\b|\bclosed\b/i.test(status)) return "done";
  if (summary.running + summary.pending + summary.blocked > 0) return "active";
  if (/推进|进行中|执行中|卡住|阻塞|等审批|待审|\bactive\b|\brunning\b/i.test(status)) return "active";
  if (summary.total > 0 && summary.done === summary.total) return "done";
  return "planned";
}

export function progressPct(summary: TaskSummary): number {
  return summary.total ? Math.round((summary.done / summary.total) * 100) : 0;
}


