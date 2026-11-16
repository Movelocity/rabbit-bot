import { useCallback, useEffect, useState } from "react";
import { ApiProvider } from "./lib/api-context.tsx";
import {
  ApiError,
  checkHealth,
  clearStoredToken,
  logoutWeb,
  readStoredToken,
  storeToken,
  verifyToken,
} from "./lib/api.ts";
import { friendlyError } from "./lib/format.ts";
import { useUrlState, type Tab } from "./lib/use-url-state.ts";
import { cx } from "./lib/cx.ts";
import { Button } from "./components/ui.tsx";
import { SchedulerTickStatus } from "./components/SchedulerTickStatus.tsx";
import { FeishuStatus } from "./components/FeishuStatus.tsx";
import { ApiStatus } from "./components/ApiStatus.tsx";
import { LoginPage } from "./pages/LoginPage.tsx";
import { ChatPage } from "./pages/ChatPage.tsx";
import { TasksPage } from "./pages/TasksPage.tsx";
import { OutputsPage } from "./pages/OutputsPage.tsx";
import { ApprovalsPage } from "./pages/ApprovalsPage.tsx";
import { ProjectsPage } from "./pages/ProjectsPage.tsx";
import { MemoriesPage } from "./pages/MemoriesPage.tsx";
import { BusinessPage } from "./pages/BusinessPage.tsx";
import { ManagePage } from "./pages/ManagePage.tsx";

type AuthState = "checking" | "authed" | "login";
type Health = "checking" | "ok" | "bad";

const ICON_URL = `${import.meta.env.BASE_URL}logo.png`;

const TAB_ITEMS: { tab: Tab; label: string }[] = [
  { tab: "chat", label: "会话" },
  { tab: "tasks", label: "任务" },
  { tab: "outputs", label: "产出" },
  { tab: "approvals", label: "权限" },
  { tab: "projects", label: "项目" },
  { tab: "memories", label: "记忆" },
  { tab: "business", label: "知识" },
  { tab: "manage", label: "管理" },
];

const TAB_HINTS: Record<string, string> = {
  tasks: "飞书审批为主 · Web 备用",
  outputs: "任务最终交付物 · Markdown / CSV / HTML 预览",
  approvals: "只读 · 审批请在飞书里完成",
  projects: "shared/projects · context.md / plan.md · 可编辑",
  memories: "可直接改正文或删除 · 新增/过期走 IM",
  business: "只读 · 对象 / 关系 / 动作",
};

const MANAGE_HINTS: Record<string, string> = {
  usage: "",
  "task-stats": "已完成任务 · 耗时 / token / 费用",
  "llm-logs": "按会话查看实际请求 / 响应 · 默认只加载最近一段",
  models: "多模型备用 · 手动切换 · 下一轮生效",
  users: "别名优先于通讯录名字 · 任务 CLI 用户已隐藏",
  persona: "人设与提示词 · 保存后下一轮生效",
  schedules: "cron 重复 / N 分钟后一次 · 到点写入日程池",
  settings: "唤醒间隔 · 日额度 · 保存后下一轮生效",
  skills: "只读 · 技能只做发现",
  "work-memory": "只读 · 跨会话共享的 memory.md",
};

export default function App() {
  const [storedToken] = useState(() => readStoredToken());
  const [token, setToken] = useState(storedToken);
  const [auth, setAuth] = useState<AuthState>(storedToken ? "checking" : "login");
  const [loginError, setLoginError] = useState("");
  const [health, setHealth] = useState<Health>("checking");
  const [currentPool, setCurrentPool] = useState<string | null>(null);
  const [reloadSignal, setReloadSignal] = useState(0);
  const [taskFocus, setTaskFocus] = useState<number | null>(null);
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
            ? "登录已失效，请重新登录"
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
    setLoginError("登录已失效，请重新登录");
    setCurrentPool(null);
  }, []);

  const handleAuthed = useCallback((raw: string) => {
    setToken(raw);
    storeToken(raw);
    setLoginError("");
    setAuth("authed");
  }, []);

  const handleLogout = useCallback(() => {
    void logoutWeb(token);
    clearStoredToken();
    setToken("");
    setAuth("login");
    setLoginError("");
    setCurrentPool(null);
  }, [token]);

  if (auth === "checking") {
    return (
      <div className="grid min-h-full place-items-center p-6 text-sm text-muted">连接中…</div>
    );
  }

  if (auth === "login") {
    return <LoginPage key={loginError} initialError={loginError} onAuthed={handleAuthed} />;
  }

  const hint =
    tab === "manage" ? MANAGE_HINTS[manageView] : TAB_HINTS[tab] ?? "";

  return (
    <ApiProvider token={token} onUnauthorized={handleUnauthorized}>
      <div className="flex h-dvh flex-col">
        <header className="flex h-14 flex-none flex-wrap items-center gap-3.5 border-b border-border bg-surface px-4.5 max-sm:h-auto max-sm:gap-2 max-sm:py-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <img src={ICON_URL} alt="" className="size-8 flex-none rounded-[10px]" />
            <span className="rb-display whitespace-nowrap text-[17px] font-bold max-[480px]:hidden">
              Rabbit Bot 管理台
            </span>
            <span className="whitespace-nowrap rounded-full border border-accent/30 bg-accent-soft px-2 py-px text-[11px] font-semibold text-accent-ink">
              本地管理
            </span>
          </div>
          <div className="ml-auto flex min-w-0 items-center gap-2.5 max-sm:order-3 max-sm:ml-0 max-sm:w-full">
            <div className="max-sm:hidden">
              <SchedulerTickStatus />
            </div>
            <FeishuStatus />
            <ApiStatus health={health} />
          </div>
          <Button variant="ghost" size="sm" onClick={handleLogout}>
            退出
          </Button>
        </header>

        <nav
          className="rb-thin-scroll flex flex-none items-center gap-0.5 overflow-x-auto border-b border-border bg-surface px-3.5 max-sm:px-3"
          aria-label="功能页签"
        >
          {TAB_ITEMS.map(({ tab: item, label }) => (
            <button
              key={item}
              type="button"
              className={cx(
                "relative whitespace-nowrap border-b-2 px-3.5 pb-2.5 pt-[11px] text-muted transition-colors",
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
            title="重新加载当前页数据"
            className={cx(
              "sticky right-0 z-[1] my-auto ml-auto mr-0 inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-surface px-2.5 py-1 text-[11.5px] text-muted transition",
              "hover:border-accent/45 hover:bg-accent-soft hover:text-accent",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/35",
            )}
            onClick={() => setReloadSignal((n) => n + 1)}
          >
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="size-3.5">
              <path
                d="M20.5 7.5V12h-4.5M3.5 16.5V12H8"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M5.6 9.5A7.2 7.2 0 0 1 18.2 7M18.4 14.5A7.2 7.2 0 0 1 5.8 17"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
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
          {tab === "tasks" && (
            <TasksPage
              reloadSignal={reloadSignal}
              focusTaskId={taskFocus}
              onFocusHandled={() => setTaskFocus(null)}
            />
          )}
          {tab === "outputs" && <OutputsPage reloadSignal={reloadSignal} />}
          {tab === "approvals" && (
            <ApprovalsPage
              reloadSignal={reloadSignal}
              onOpenTask={(id) => {
                setTaskFocus(id);
                setTab("tasks");
              }}
            />
          )}
          {tab === "projects" && <ProjectsPage reloadSignal={reloadSignal} />}
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
          className="flex-none border-t border-border bg-surface px-4 py-1.5 text-right text-[11.5px] text-muted"
          hidden={!hint}
        >
          {hint}
        </footer>
      </div>
    </ApiProvider>
  );
}
