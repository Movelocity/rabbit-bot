import { useState, type FormEvent } from "react";
import { Button, Input } from "../components/ui.tsx";
import { cx } from "../lib/cx.ts";

export function LoginPage({
  initialToken,
  error,
  busy,
  onLogin,
}: {
  initialToken: string;
  error: string;
  busy: boolean;
  onLogin: (token: string) => Promise<void>;
}) {
  const [value, setValue] = useState(initialToken);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    await onLogin(value.trim());
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
        <p className="m-0 text-sm text-muted">
          输入 10 位登录密钥（本地 REST API token）。默认从{" "}
          <code className="rounded bg-surface2 px-1.5 py-px font-mono text-[0.9em]">
            app/data/run/api.token
          </code>{" "}
          读取，也可以用环境变量{" "}
          <code className="rounded bg-surface2 px-1.5 py-px font-mono text-[0.9em]">
            RABBIT_BOT_API_TOKEN
          </code>
          。
        </p>
        <label className="mt-5 block">
          <span className="mb-1.5 block text-xs text-muted">API token</span>
          <Input
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="粘贴 10 位密钥"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </label>
        <p className={cx("mt-2.5 min-h-5 text-[13px] text-bad", !error && "invisible")}>
          {error}
        </p>
        <Button variant="primary" type="submit" className="mt-1 w-full py-2.5" disabled={busy}>
          {busy ? "连接中…" : "连接"}
        </Button>
        <p className="mt-4 text-xs text-muted">
          会话收发走已启用的 IM；这里管理人格、提示词、记忆、调度和只读面板。页面可以匿名打开，但所有数据接口都要
          token。
        </p>
      </form>
    </div>
  );
}
