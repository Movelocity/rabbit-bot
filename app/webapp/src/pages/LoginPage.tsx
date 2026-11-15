import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  ApiError,
  fetchWebAuthStatus,
  loginWeb,
  setupWebPassword,
  type WebAuthStatus,
} from "../lib/api.ts";
import { friendlyError } from "../lib/format.ts";
import { Button, Input, Notice } from "../components/ui.tsx";
import { cx } from "../lib/cx.ts";

type Phase = "loading" | "setup" | "login" | "disabled" | "error";

const DEFAULT_USERNAME = "rabbit-bot";

function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 401) return "用户名或密码不对";
    if (e.status === 0) return `连接失败：${friendlyError(e)}`;
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

export function LoginPage({
  initialError,
  onAuthed,
}: {
  /** 失效原因（比如 token 过期）；会显示在表单上方 */
  initialError: string;
  onAuthed: (token: string) => void;
}) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [info, setInfo] = useState<WebAuthStatus | null>(null);
  const [username, setUsername] = useState(DEFAULT_USERNAME);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setPhase("loading");
    try {
      const s = await fetchWebAuthStatus();
      setInfo(s);
      setUsername(s.username || DEFAULT_USERNAME);
      if (!s.enabled) {
        setPhase("disabled");
        return;
      }
      setPhase(s.setup_required ? "setup" : "login");
    } catch (e) {
      setError(errorText(e));
      setPhase("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError("");
    if (phase === "setup") {
      if (password.length < 6) {
        setError("密码至少 6 位");
        return;
      }
      if (password !== confirm) {
        setError("两次输入的密码不一样");
        return;
      }
    }
    setBusy(true);
    try {
      const result = phase === "setup"
        ? await setupWebPassword(password)
        : await loginWeb(username.trim(), password);
      onAuthed(result.token);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-full place-items-center p-6">
      <form
        className="w-full max-w-[440px] rounded-[20px] border border-border bg-surface p-8 shadow-[var(--rb-shadow)]"
        onSubmit={submit}
      >
        <img
          src={`${import.meta.env.BASE_URL}logo.png`}
          alt="Rabbit Bot"
          className="mb-3.5 size-[44px] rounded-xl"
        />
        <h1 className="m-0 mb-2 text-2xl font-semibold">Rabbit Bot 管理台</h1>

        {phase === "loading" && <p className="m-0 text-sm text-muted">连接中…</p>}

        {phase === "disabled" && (
          <Notice>
            Web 登录没有开启。可以在配置里打开 <code className="font-mono">webChat.enabled</code>。
          </Notice>
        )}

        {phase === "error" && (
          <Notice className="text-bad">{error || "连不上服务，请检查后端是否在运行。"}</Notice>
        )}

        {(phase === "setup" || phase === "login") && (
          <>
            <p className="m-0 text-sm text-muted">
              {phase === "setup"
                ? "首次使用，先设置一次登录密码。之后用账号密码进入管理台和网页直聊。"
                : "账号密码登录。登录后可管理全部会话、任务和设置，网页直聊也在同一个入口里。"}
            </p>

            <label className="mt-5 block">
              <span className="mb-1.5 block text-xs text-muted">账号</span>
              {phase === "setup" ? (
                <Input value={username} readOnly aria-readonly="true" />
              ) : (
                <Input
                  autoComplete="username"
                  spellCheck={false}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                />
              )}
            </label>
            <label className="mt-3.5 block">
              <span className="mb-1.5 block text-xs text-muted">
                {phase === "setup" ? "设置密码（至少 6 位）" : "密码"}
              </span>
              <Input
                type="password"
                autoComplete={phase === "setup" ? "new-password" : "current-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            {phase === "setup" && (
              <label className="mt-3.5 block">
                <span className="mb-1.5 block text-xs text-muted">再输一次密码</span>
                <Input
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                />
              </label>
            )}

            <p className={cx("mt-2.5 min-h-5 text-[13px] text-bad", !error && "invisible")}>
              {error}
            </p>
            <Button variant="primary" type="submit" className="mt-1 w-full py-2.5" disabled={busy}>
              {busy ? "连接中…" : phase === "setup" ? "设置密码并登录" : "登录"}
            </Button>
            <p className="mt-4 text-xs text-muted">
              默认账号 <code className="font-mono">rabbit-bot</code>。密码也可以用{" "}
              <code className="font-mono">RABBIT_BOT_WEB_PASSWORD</code> 预置；忘了可改配置后重启。
            </p>
          </>
        )}

        {phase === "disabled" && (
          <Button variant="ghost" type="button" className="mt-4 w-full" onClick={() => void load()}>
            重新连接
          </Button>
        )}
        {phase === "error" && (
          <Button variant="primary" type="button" className="mt-4 w-full py-2.5" onClick={() => void load()}>
            重试
          </Button>
        )}
      </form>
    </div>
  );
}
