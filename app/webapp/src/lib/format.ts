import type { BusinessData, BusinessRelation } from "./types.ts";

export function kindLabel(kind: string): string {
  if (kind === "private") return "私聊";
  if (kind === "group") return "群聊";
  if (kind === "task") return "任务";
  return kind || "";
}

export function formatTs(ms: number | null | undefined): string {
  if (!ms) return "";
  try {
    return new Date(Number(ms)).toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return String(ms);
  }
}

export function noteSummary(note: string | null | undefined): string {
  const first = String(note ?? "")
    .split("\n")
    .find((line) => line.trim()) ?? "";
  return first.length > 80 ? `${first.slice(0, 80)}…` : first;
}

export function friendlyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg === "未登录" ? "" : msg;
}

export type BadgeVariant = "default" | "done" | "closed" | "info" | "warn";

export function badgeVariant(status: string | null | undefined): BadgeVariant {
  const s = String(status || "");
  if (["done", "approved", "online"].includes(s)) return "done";
  if (["failed", "rejected", "timeout", "offline", "blocked"].includes(s)) return "closed";
  if (s === "pending_approval") return "warn";
  if (["running", "pending"].includes(s)) return "info";
  return "default";
}

export function businessTypeName(data: BusinessData, id: string): string {
  return data.types.find((t) => t.id === id)?.name || id;
}

export function businessObjectName(data: BusinessData, id: string): string {
  const o = data.objects.find((x) => x.id === id);
  return o ? o.name || o.id : id;
}

export function businessRelationName(data: BusinessData, id: string): string {
  const r = data.relations.find((x) => x.id === id);
  return r ? r.name || r.id : id;
}

export function relationRiskVariant(risk: BusinessRelation["risk"]): BadgeVariant {
  if (risk === "high") return "warn";
  if (risk === "medium") return "info";
  return "default";
}

export function money(value: number): string {
  return `$${Number(value || 0).toFixed(4)}`;
}

export function num(value: number): string {
  return Number(value || 0).toLocaleString("zh-CN");
}
