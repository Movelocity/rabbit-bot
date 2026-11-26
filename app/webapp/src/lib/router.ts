export const TABS = [
  "overview",
  "chat",
  "work",
  "approvals",
  "memories",
  "manage",
] as const;
export type Tab = (typeof TABS)[number];

export const MANAGE_VIEWS = [
  "usage",
  "task-stats",
  "llm-logs",
  "models",
  "persona",
  "settings",
  "schedules",
  "executors",
  "users",
  "skills",
  "work-memory",
] as const;
export type ManageView = (typeof MANAGE_VIEWS)[number];

export type WorkView = "tasks" | "outputs" | "project";
export type ApprovalView = "pending" | "reads";
export type MemoryView = "entries" | "graph";

export type Route =
  | { tab: "overview" }
  | { tab: "chat" }
  | { tab: "work"; view: WorkView; slug?: string; path?: string; task?: number }
  | { tab: "approvals"; view: ApprovalView; id?: number }
  | { tab: "memories"; view: MemoryView }
  | { tab: "manage"; view: ManageView };

const LEGACY_MANAGE_TABS = new Set<string>([
  "users",
  "persona",
  "schedules",
  "settings",
  "usage",
  "task-stats",
  "skills",
]);

const MANAGE_VIEW_SET = new Set<string>(MANAGE_VIEWS);

function positiveInt(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const text = raw.trim();
  if (!text) return undefined;
  const n = Number(text);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function isManageView(value: string | null): value is ManageView {
  return value !== null && MANAGE_VIEW_SET.has(value);
}

function projectSlugFromScope(scope: string | null): string | undefined {
  if (scope && scope.startsWith("project:")) {
    const slug = scope.slice("project:".length);
    return slug.trim() || undefined;
  }
  return undefined;
}

function parseWork(
  params: URLSearchParams,
  view: string | null,
  scope: string | null,
  path: string | null,
): Route {
  let workView: WorkView = "tasks";
  let slug: string | undefined;
  let outputPath: string | undefined;
  let task: number | undefined;

  if (scope !== null) {
    if (scope === "outputs") {
      workView = "outputs";
      outputPath = path ?? undefined;
    } else if (scope.startsWith("project:")) {
      const scopedSlug = projectSlugFromScope(scope);
      if (scopedSlug) {
        workView = "project";
        slug = scopedSlug;
      }
    } else if (scope.startsWith("task:")) {
      const scopedTask = positiveInt(scope.slice("task:".length));
      if (scopedTask !== undefined) {
        task = scopedTask;
        const fromSlug = projectSlugFromScope(params.get("from"));
        if (fromSlug) {
          workView = "project";
          slug = fromSlug;
        }
      }
    }
  } else if (view === "outputs") {
    workView = "outputs";
    outputPath = path ?? undefined;
  } else if (view === "project") {
    const scopedSlug = params.get("slug");
    if (scopedSlug && scopedSlug.trim()) {
      workView = "project";
      slug = scopedSlug;
    }
  }

  if (workView !== "outputs") {
    task = task ?? positiveInt(params.get("task"));
  }

  if (workView === "outputs") {
    return outputPath
      ? { tab: "work", view: workView, path: outputPath }
      : { tab: "work", view: workView };
  }
  if (workView === "project" && slug) {
    return task !== undefined
      ? { tab: "work", view: workView, slug, task }
      : { tab: "work", view: workView, slug };
  }
  if (workView === "project") {
    // 缺 slug 降级为 tasks
    return task !== undefined
      ? { tab: "work", view: "tasks", task }
      : { tab: "work", view: "tasks" };
  }
  return task !== undefined
    ? { tab: "work", view: "tasks", task }
    : { tab: "work", view: "tasks" };
}

export function parseRoute(search: string): Route {
  const params = new URLSearchParams(search);
  const tab = params.get("tab");
  const view = params.get("view");
  const scope = params.get("scope");
  const path = params.get("path");

  if (tab !== null && LEGACY_MANAGE_TABS.has(tab)) {
    return { tab: "manage", view: tab as ManageView };
  }

  if (tab === "business" || (tab === "manage" && view === "business")) {
    return { tab: "memories", view: "graph" };
  }

  if (tab === "tasks" || tab === "plans" || tab === "projects") {
    return { tab: "work", view: "tasks" };
  }

  if (tab === "outputs") {
    return path
      ? { tab: "work", view: "outputs", path }
      : { tab: "work", view: "outputs" };
  }

  if (tab === "work") {
    return parseWork(params, view, scope, path);
  }

  if (tab === "approvals") {
    let approvalView: ApprovalView = "pending";
    if (scope === "log" || scope === "rules") approvalView = "reads";
    else if (scope === null) {
      if (view === "reads") approvalView = "reads";
    }
    if (approvalView === "reads") return { tab: "approvals", view: "reads" };
    const id = positiveInt(params.get("id"));
    return id !== undefined
      ? { tab: "approvals", view: "pending", id }
      : { tab: "approvals", view: "pending" };
  }

  if (tab === "memories") {
    return { tab: "memories", view: view === "graph" ? "graph" : "entries" };
  }

  if (tab === "manage") {
    return { tab: "manage", view: isManageView(view) ? view : "usage" };
  }

  if (tab === "chat") return { tab: "chat" };
  return { tab: "overview" };
}

export function formatRoute(route: Route): string {
  const params = new URLSearchParams();
  params.set("tab", route.tab);

  switch (route.tab) {
    case "work": {
      params.set("view", route.view);
      if (route.view === "project" && route.slug) params.set("slug", route.slug);
      if (route.view === "outputs" && route.path) params.set("path", route.path);
      if (
        route.view !== "outputs" &&
        route.task !== undefined &&
        Number.isInteger(route.task) &&
        route.task > 0
      ) {
        params.set("task", String(route.task));
      }
      break;
    }
    case "approvals": {
      params.set("view", route.view);
      if (
        route.view === "pending" &&
        route.id !== undefined &&
        Number.isInteger(route.id) &&
        route.id > 0
      ) {
        params.set("id", String(route.id));
      }
      break;
    }
    case "memories":
      params.set("view", route.view);
      break;
    case "manage":
      params.set("view", route.view);
      break;
    default:
      break;
  }

  return `?${params.toString()}`;
}

export function sameRoute(a: Route, b: Route): boolean {
  if (a.tab !== b.tab) return false;
  switch (a.tab) {
    case "work": {
      const other = b as Extract<Route, { tab: "work" }>;
      return (
        a.view === other.view &&
        a.slug === other.slug &&
        a.path === other.path &&
        a.task === other.task
      );
    }
    case "approvals": {
      const other = b as Extract<Route, { tab: "approvals" }>;
      return a.view === other.view && a.id === other.id;
    }
    case "memories": {
      const other = b as Extract<Route, { tab: "memories" }>;
      return a.view === other.view;
    }
    case "manage": {
      const other = b as Extract<Route, { tab: "manage" }>;
      return a.view === other.view;
    }
    default:
      return true;
  }
}