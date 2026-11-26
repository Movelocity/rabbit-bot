import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { formatRoute, parseRoute, sameRoute, type Route } from "./router.ts";

interface RouteContextValue {
  route: Route;
  navigate: (next: Route, opts?: { replace?: boolean }) => void;
  back: (fallback: Route) => void;
}

const RouteContext = createContext<RouteContextValue | null>(null);

export function RouteProvider({ children }: { children: ReactNode }) {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.search));
  const routeRef = useRef(route);
  routeRef.current = route;

  useEffect(() => {
    const normalized = parseRoute(window.location.search);
    const search = formatRoute(normalized);
    const url = `${window.location.pathname}${search}${window.location.hash}`;
    const now = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (url !== now) window.history.replaceState(null, "", url);

    const onPop = () => setRoute(parseRoute(window.location.search));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = useCallback((next: Route, opts: { replace?: boolean } = {}) => {
    if (sameRoute(routeRef.current, next)) return;
    const search = formatRoute(next);
    const url = `${window.location.pathname}${search}${window.location.hash}`;
    if (opts.replace) {
      // replace 保留原条目的 prev，返回链不断
      window.history.replaceState(window.history.state, "", url);
    } else {
      // 记下上一条的 search，back() 据此判断浏览器后退能否回到预期位置
      window.history.pushState({ prev: formatRoute(routeRef.current) }, "", url);
    }
    setRoute(next);
  }, []);

  const back = useCallback(
    (fallback: Route) => {
      // 上一条正好是 fallback 才走浏览器后退；否则直接去 fallback，避免「返回」跳到别处
      const prev = (window.history.state as { prev?: string } | null)?.prev;
      if (prev === formatRoute(fallback)) window.history.back();
      else navigate(fallback);
    },
    [navigate],
  );

  return (
    <RouteContext.Provider value={{ route, navigate, back }}>
      {children}
    </RouteContext.Provider>
  );
}

export function useRoute(): RouteContextValue {
  const ctx = useContext(RouteContext);
  if (!ctx) throw new Error("useRoute 必须在 RouteProvider 内使用");
  return ctx;
}