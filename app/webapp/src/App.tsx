import { useCallback, useEffect, useState } from "react";
import { ApiProvider } from "./lib/api-context.tsx";
import {
  ApiError,
  checkHealth,
  clearStoredToken,
  readStoredToken,
  storeToken,
  verifyToken,
} from "./lib/api.ts";
import { friendlyError } from "./lib/format.ts";
import { useUrlState, type Tab } from "./lib/use-url-state.ts";
import { cx } from "./lib/cx.ts";
import { Button } from "./components/ui.tsx";
import { LoginPage } from "./pages/LoginPage.tsx";
import { ChatPage } from "./pages/ChatPage.tsx";
import { TasksPage } from "./pages/TasksPage.tsx";
import { ApprovalsPage } from "./pages/ApprovalsPage.tsx";
import { PlansPage } from "./pages/PlansPage.tsx";
import { MemoriesPage } from "./pages/MemoriesPage.tsx";
import { BusinessPage } from "./pages/BusinessPage.tsx";
import { ManagePage } from "./pages/ManagePage.tsx";

type AuthState = "checking" | "authed" | "login";
type Health = "checking" | "ok" | "bad";

const ICON_URL = `${import.meta.env.BASE_URL}logo.png`;

const TAB_ITEMS: { tab: Tab; label: string }[] = [
  { tab: "chat", label: "会话" },
  { tab: "tasks", label: "任务" },
  { tab: "approvals", label: "权限" },
  { tab: "plans", label: "计划" },
  { tab: "memories", label: "记忆" },
  { tab: "business", label: "知识" },
  { tab: "manage", label: "管理" },
];

const TAB_HINTS: Record<string, string> = {
  tasks: "飞书审批为主 · Web 备用",
  approvals: "只读 · 审批请在飞书里完成",
  plans: "md 看板 · 目标可在 Web 或 IM 勾选",
  memories: "可直接改正文或删除 · 新增/过期走 IM",
  business: "只读 · 对象 / 关系 / 动作",
};

const MANAGE_HINTS: Record<string, string> = {
  usage: "",
  "task-stats": "已完成任务 · 耗时 / token / 费用",
  users: "别名优先于通讯录名字",
  persona: "保存到运行时 · 下一轮换新会话生效",
  settings: "单位：秒 · 保存后立即生效",
  skills: "只读 · 技能只做发现",
};

export default function App() {
  const [storedToken] = useState(() => readStoredToken());
  const [token, setToken] = useState(storedToken);
  const [auth, setAuth] = useState<AuthState>(storedToken ? "checking" : "login");
  const [loginError, setLoginError] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [health, setHealth] = useState<Health>("checking");
  const [currentPool, setCurrentPool] = useState<string | null>(null);
  const [reloadSignal, setReloadSignal] = useState(0);
  const { tab, manageView, setTab, setManageView } = useUrlState();

  useEffect(() => {
    if (!storedToken) return;
    let cancelled = false;
    verifyToken(storedToken)
      .then(() => {
        if (!cancelled) setAuth("authed");
      })
      .catch((e) => {
        if (cancelled) return;
        setToken("");
        setLoginError(
          e instanceof ApiError && e.status === 401
            ? "token 已失效，请重新输入"
            : `连接失败：${friendlyError(e)}`,
        );
        setAuth("login");
      });
    return () => {
      cancelled = true;
    };
  }, [storedToken]);

  useEffect(() => {
    let alive = true;
    const run = async () => {
      const ok = await checkHealth();
      if (alive) setHealth(ok ? "ok" : "bad");
    };
    void run();
    const id = window.setInterval(run, 10000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  const handleUnauthorized = useCallback(() => {
    clearStoredToken();
    setToken("");
    setAuth("login");
    setLoginError("token 不对或已失效，请重新输入");
    setCurrentPool(null);
  }, []);

  const handleLogin = useCallback(async (raw: string) => {
    if (!raw) {
      setLoginError("请先填入 token");
      return;
    }
    setLoginBusy(true);
    setLoginError("");
    try {
      await verifyToken(raw);
      setToken(raw);
      storeToken(raw);
      setAuth("authed");
    } catch (e) {
      setLoginError(
        e instanceof ApiError && e.status === 401
          ? "token 不对。默认在 app/data/run/api.token，或由 RABBIT_BOT_API_TOKEN 提供。"
          : `连接失败：${friendlyError(e)}`,
      );
    } finally {
      setLoginBusy(false);
    }
  }, []);

  const handleLogout = useCallback(() => {
    clearStoredToken();
    setToken("");
    setAuth("login");
    setLoginError("");
    setCurrentPool(null);
  }, []);

  if (auth === "checking") {
    return (
      <div className="grid min-h-full place-items-center p-6 text-sm text-muted">连接中…</div>
    );
  }

  if (auth === "login") {
    return (
      <LoginPage
        initialToken={token}
        error={loginError}
        busy={loginBusy}
        onLogin={handleLogin}
      />
    );
  }

  const healthText =
    health === "ok" ? "API 正常" : health === "bad" ? "API 异常" : "连接中…";
  const hint =
    tab === "manage" ? MANAGE_HINTS[manageView] : TAB_HINTS[tab] ?? "";

  return (
    <ApiProvider token={token} onUnauthorized={handleUnauthorized}>
      <div className="flex h-dvh flex-col">
        <header className="flex flex-wrap items-center gap-3 border-b border-border bg-surface px-4 py-2.5 max-sm:gap-2">
          <div className="flex items-center gap-2.5 font-semibold">
            <img
              src={ICON_URL}
              alt=""
              className="size-[30px] rounded-[9px]"
            />
            <span className="max-[480px]:hidden">Rabbit Bot 管理台</span>
            <span className="rounded-full bg-accent-soft px-2 py-px text-[11px] font-semibold text-accent">
              本地管理
            </span>
          </div>
          <div className="ml-auto flex min-w-0 items-center gap-1.5 text-[13px] max-sm:order-3 max-sm:ml-0 max-sm:w-full">
            <span
              className={cx(
                "size-[9px] flex-none rounded-full",
                health === "ok" && "bg-ok shadow-[0_0_0_3px_color-mix(in_srgb,var(--rb-ok)_20%,transparent)]",
                health === "bad" && "bg-bad shadow-[0_0_0_3px_color-mix(in_srgb,var(--rb-bad)_20%,transparent)]",
                health === "checking" && "bg-muted",
              )}
            />
            <span>{healthText}</span>
            <span className="text-border">·</span>
            <span className="truncate text-muted">{window.location.origin}</span>
          </div>
          <Button variant="ghost" size="sm" onClick={handleLogout}>
            退出
          </Button>
        </header>

        <nav
          className="flex gap-1 overflow-x-auto border-b border-border bg-surface px-4 pt-2 max-sm:px-3"
          aria-label="功能页签"
        >
          {TAB_ITEMS.map(({ tab: item, label }) => (
            <button
              key={item}
              type="button"
              className={cx(
                "whitespace-nowrap rounded-t-[9px] border-b-2 px-4 py-2.5 text-muted transition",
                tab === item
                  ? "border-accent font-semibold text-text"
                  : "border-transparent hover:text-text",
              )}
              aria-current={tab === item ? "page" : undefined}
              onClick={() => setTab(item)}
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            className="sticky right-0 z-[1] my-auto ml-auto mr-0 rounded-full border border-border bg-surface2 px-3 py-1 text-xs text-muted hover:text-text"
            onClick={() => setReloadSignal((n) => n + 1)}
          >
            刷新
          </button>
        </nav>

        <main className="min-h-0 flex-1">
          {tab === "chat" && (
            <ChatPage
              currentPool={currentPool}
              onCurrentPoolChange={setCurrentPool}
              reloadSignal={reloadSignal}
            />
          )}
          {tab === "tasks" && <TasksPage reloadSignal={reloadSignal} />}
          {tab === "approvals" && <ApprovalsPage reloadSignal={reloadSignal} />}
          {tab === "plans" && <PlansPage reloadSignal={reloadSignal} />}
          {tab === "memories" && <MemoriesPage reloadSignal={reloadSignal} />}
          {tab === "business" && <BusinessPage reloadSignal={reloadSignal} />}
          {tab === "manage" && (
            <ManagePage
              view={manageView}
              onViewChange={setManageView}
              reloadSignal={reloadSignal}
            />
          )}
        </main>

        <footer
          className="flex-none border-t border-border bg-surface px-4 py-1.5 text-right text-xs text-muted"
          hidden={!hint}
        >
          {hint}
        </footer>
      </div>
    </ApiProvider>
  );
}
