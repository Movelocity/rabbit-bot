import { useCallback, useEffect, useState } from "react";
import { useApi } from "../../lib/api-context.tsx";
import { usePolling } from "../../lib/use-polling.ts";
import { cx } from "../../lib/cx.ts";
import { formatTs, friendlyError } from "../../lib/format.ts";
import type { BotsResponse, FeishuConnectionInfo } from "../../lib/types.ts";
import { Badge, Button, Card, CardHead, CardTitle, StatusText } from "../../components/ui.tsx";
import { FeishuView } from "./FeishuView.tsx";

const STATE_LABEL: Record<string, string> = {
  connected: "已连接",
  reconnecting: "重连中",
  connecting: "连接中",
  stopped: "未连接",
};

const SOURCE_LABEL: Record<string, string> = {
  runtime: "管理台保存",
  env: "环境变量",
  none: "未配置凭据",
};

function platformName(platform: string): string {
  if (platform === "feishu") return "飞书";
  if (platform === "matrix") return "Matrix";
  return platform;
}

function dotClass(state: string | undefined, missed: number): string {
  if (missed > 0) return "bg-bad";
  if (state === "connected") return "bg-ok";
  if (state === "reconnecting") return "bg-amber";
  return "bg-muted";
}

function Summary({ bot }: { bot: FeishuConnectionInfo }) {
  const state = bot.connection?.state ?? "stopped";
  const gap = bot.connection?.last_gap;
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cx("size-[9px] flex-none rounded-full", dotClass(state, gap?.missed ?? 0))} />
        <span className="font-semibold">{platformName(bot.platform)}</span>
        <Badge variant={state === "connected" ? "done" : state === "reconnecting" ? "warn" : "default"}>
          {STATE_LABEL[state] ?? state}
        </Badge>
        {gap && gap.missed > 0 ? <Badge variant="closed">漏收 {gap.missed} 条</Badge> : null}
        {!bot.configured ? <Badge variant="warn">缺少凭据</Badge> : null}
      </div>
      <p className="mt-1.5 truncate text-[11.5px] text-muted">
        {bot.app_id_masked ?? "未配置 App ID"} · {SOURCE_LABEL[bot.credential_source] ?? bot.credential_source} · 最近入库{" "}
        {formatTs(bot.inbound.last_stored_at) || "—"}
      </p>
    </div>
  );
}

export function BotsView({
  bot,
  onOpen,
  reloadSignal,
}: {
  bot?: string;
  onOpen: (bot?: string) => void;
  reloadSignal: number;
}) {
  const request = useApi();
  const [bots, setBots] = useState<FeishuConnectionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await request<BotsResponse>("/v1/adapters");
      setBots(r.bots);
      setError("");
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setLoading(false);
    }
  }, [request]);

  useEffect(() => { void load(); }, [load, reloadSignal]);
  usePolling(load, 5000, !bot);

  if (bot === "feishu") {
    return <FeishuView reloadSignal={reloadSignal} onBack={() => onOpen(undefined)} />;
  }

  if (bot) {
    return (
      <Card>
        <CardTitle>没有这个机器人</CardTitle>
        <p className="mt-2 text-[12px] text-muted">当前没有接入 {bot}。返回列表查看已接入的机器人。</p>
        <Button variant="ghost" size="sm" className="mt-3" onClick={() => onOpen(undefined)}>
          返回机器人列表
        </Button>
      </Card>
    );
  }

  return (
    <div className="max-w-5xl space-y-4">
      <Card>
        <CardHead>
          <CardTitle>已接入的机器人</CardTitle>
          <span className="text-[11px] text-faint">{loading ? "读取中…" : `${bots.length} 个`}</span>
        </CardHead>
        {bots.length ? (
          <ul className="mt-3 divide-y divide-border overflow-hidden rounded-[10px] border border-border">
            {bots.map((item) => (
              <li key={item.platform}>
                <button
                  type="button"
                  onClick={() => onOpen(item.platform)}
                  className="flex w-full items-center gap-3 px-3 py-3 text-left outline-none transition hover:bg-surface2 focus-visible:bg-surface2"
                >
                  <Summary bot={item} />
                  <span className="ml-auto flex flex-none items-center gap-1 text-[11.5px] text-muted">
                    查看详情
                    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="size-3.5">
                      <path d="m6 4 4 4-4 4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : loading ? null : (
          <p className="mt-3 text-[12px] text-muted">还没有可展示的机器人。</p>
        )}
        <p className="mt-3 text-[11px] leading-relaxed text-faint">
          点进详情可以看连接健康、入站全链路计数、漏收核对和凭据管理。
        </p>
      </Card>
      {error ? <StatusText text={error} error /> : null}
    </div>
  );
}