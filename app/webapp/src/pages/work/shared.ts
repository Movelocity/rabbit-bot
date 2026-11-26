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


