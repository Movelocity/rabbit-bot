import { useCallback, useEffect, useRef, useState } from "react";

export const TABS = [
  "chat",
  "tasks",
  "approvals",
  "plans",
  "memories",
  "business",
  "manage",
] as const;
export type Tab = (typeof TABS)[number];

export const MANAGE_VIEWS = [
  "users",
  "persona",
  "settings",
  "usage",
  "skills",
] as const;
export type ManageView = (typeof MANAGE_VIEWS)[number];

const LEGACY_TAB_VIEW: Record<string, ManageView> = {
  users: "users",
  persona: "persona",
  settings: "settings",
  usage: "usage",
  skills: "skills",
};

interface ParsedUrl {
  tab: Tab;
  manageView: ManageView | null;
}

function isTab(value: string | null): value is Tab {
  return value !== null && (TABS as readonly string[]).includes(value);
}

function isManageView(value: string | null): value is ManageView {
  return value !== null && (MANAGE_VIEWS as readonly string[]).includes(value);
}

function parseUrl(search: string): ParsedUrl {
  const params = new URLSearchParams(search);
  let tab: string | null = params.get("tab");
  let view: string | null = params.get("view");

  if (tab && LEGACY_TAB_VIEW[tab]) {
    view = LEGACY_TAB_VIEW[tab];
    tab = "manage";
  }
  if (tab === "manage" && view === "business") {
    tab = "business";
    view = null;
  }

  const safeTab: Tab = isTab(tab) ? tab : "chat";
  const safeView: ManageView | null =
    safeTab === "manage" ? (isManageView(view) ? view : "users") : null;
  return { tab: safeTab, manageView: safeView };
}

interface UrlState {
  tab: Tab;
  manageView: ManageView;
}

export function useUrlState() {
  const [state, setState] = useState<UrlState>(() => {
    const parsed = parseUrl(window.location.search);
    return { tab: parsed.tab, manageView: parsed.manageView ?? "users" };
  });

  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const onPop = () => {
      const parsed = parseUrl(window.location.search);
      setState((prev) => ({
        tab: parsed.tab,
        manageView: parsed.manageView ?? prev.manageView,
      }));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = useCallback(
    (tab: Tab, view?: ManageView, opts: { replace?: boolean } = {}) => {
      const manageView = view ?? stateRef.current.manageView;
      const params = new URLSearchParams(window.location.search);
      params.set("tab", tab);
      if (tab === "manage") params.set("view", manageView);
      else params.delete("view");
      const search = params.toString();
      const url = `${window.location.pathname}${search ? `?${search}` : ""}${window.location.hash}`;
      const now = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      if (url !== now) {
        if (opts.replace) window.history.replaceState({ tab }, "", url);
        else window.history.pushState({ tab }, "", url);
      }
      setState({ tab, manageView });
    },
    [],
  );

  const setTab = useCallback((tab: Tab) => navigate(tab), [navigate]);
  const setManageView = useCallback(
    (view: ManageView) => navigate("manage", view),
    [navigate],
  );

  return { tab: state.tab, manageView: state.manageView, setTab, setManageView };
}
