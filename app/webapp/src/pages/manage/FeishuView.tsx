import { useCallback, useEffect, useRef, useState } from "react";
import { useApi } from "../../lib/api-context.tsx";
import { usePolling } from "../../lib/use-polling.ts";
import { cx } from "../../lib/cx.ts";
import { duration, formatTs, friendlyError, num } from "../../lib/format.ts";
import type { FeishuConnectionInfo, FeishuGapCheckResponse } from "../../lib/types.ts";
import { Badge, Button, Card, CardHead, CardTitle, Input, Select, StatusText } from "../../components/ui.tsx";

type Busy = "" | "connect" | "disconnect" | "gap" | "save" | "clear";
type Note = { text: string; error?: boolean };

const STATE_LABEL: Record<string, string> = {
  connected: "已连接",
  reconnecting: "重连中",
  connecting: "连接中",
  stopped: "未连接",
};

const EVENT_LABEL: Record<string, string> = {
  connected: "已连接",
  disconnected: "已断开",
  reconnected: "已恢复",
  error: "错误",
  gap: "漏收核对",
};

function stateDot(state: string | undefined, gapMissed: number): string {
  if (gapMissed > 0) return "bg-bad";
  if (state === "connected") return "bg-ok";
  if (state === "reconnecting") return "bg-amber";
  return "bg-muted";
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "bad" | "warn" | "ok" }) {
  return (
    <div className="min-w-0 rounded-[10px] border border-border bg-surface2/60 px-3 py-2">
      <dt className="text-[11px] text-faint">{label}</dt>
      <dd
        className={cx(
          "mt-0.5 truncate text-[15px] font-semibold tabular-nums",
          tone === "bad" && "text-bad",
          tone === "warn" && "text-amber",
          tone === "ok" && "text-ok",
        )}
        title={value}
      >
        {value}
      </dd>
    </div>
  );
}

export function FeishuView({ reloadSignal, onBack }: { reloadSignal: number; onBack?: () => void }) {
  const request = useApi();
  const [info, setInfo] = useState<FeishuConnectionInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<Busy>("");
  const [note, setNote] = useState<Note>({ text: "" });
  const [nowMs, setNowMs] = useState(() => Date.now());

  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [domain, setDomain] = useState<"feishu" | "lark">("feishu");
  const [verify, setVerify] = useState(true);
  const domainInit = useRef(false);

  const load = useCallback(async () => {
    try {
      const r = await request<FeishuConnectionInfo>("/v1/adapters/feishu");
      setInfo(r);
      if (!domainInit.current) {
        setDomain(r.domain);
        domainInit.current = true;
      }
      setLoading(false);
    } catch (e) {
      setLoading(false);
      setNote({ text: `读取失败：${friendlyError(e)}`, error: true });
    }
  }, [request]);

  useEffect(() => { void load(); }, [load, reloadSignal]);
  usePolling(load, 5000);

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const run = async (kind: Exclude<Busy, "">, text: string, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(kind);
    setNote({ text });
    try {
      await fn();
    } catch (e) {
      setNote({ text: friendlyError(e), error: true });
    } finally {
      setBusy("");
    }
  };

  const connect = () => run("connect", "正在建立长连接…", async () => {
    const r = await request<FeishuConnectionInfo>("/v1/adapters/feishu/connect", { method: "POST" });
    setInfo(r);
    setNote({ text: "长连接已发起，状态会自动刷新。" });
  });

  const disconnect = () => run("disconnect", "正在断开…", async () => {
    const r = await request<FeishuConnectionInfo>("/v1/adapters/feishu/disconnect", { method: "POST" });
    setInfo(r);
    setNote({ text: "已断开长连接。" });
  });

  const checkGap = () => run("gap", "正在按会话核对最近 30 分钟…", async () => {
    const r = await request<FeishuGapCheckResponse>("/v1/adapters/feishu/check-gap", {
      method: "POST",
      body: { minutes: 30 },
    });
    setInfo(r.view);
    setNote({
      text: r.gap.error
        ? `核对未完成：${r.gap.error}`
        : r.gap.missed > 0
          ? `核对到 ${r.gap.missed} 条平台有、本地没有的消息。`
          : "核对完成：这个窗口没有漏收。",
      error: !!r.gap.error || r.gap.missed > 0,
    });
  });

  const save = () => run("save", verify ? "正在验证凭据并保存…" : "正在保存…", async () => {
    const r = await request<FeishuConnectionInfo>("/v1/adapters/feishu/credentials", {
      method: "PUT",
      body: { app_id: appId || undefined, app_secret: appSecret || undefined, domain, verify },
    });
    setInfo(r);
    setAppSecret("");
    setAppId("");
    setNote({ text: "已保存。凭据只写本机，接口不会回显 Secret。" });
  });

  const clear = () => {
    if (!window.confirm("删除本机保存的飞书凭据？如果环境变量里还有凭据，会回退到环境变量。")) return;
    void run("clear", "正在删除运行时凭据…", async () => {
      const r = await request<FeishuConnectionInfo>("/v1/adapters/feishu", { method: "DELETE" });
      setInfo(r);
      setNote({ text: "已删除运行时凭据，当前连接已断开。" });
    });
  };

  const conn = info?.connection ?? null;
  const counters = conn?.counters;
  const inbound = info?.inbound;
  const state = conn?.state ?? "stopped";
  const gap = conn?.last_gap ?? null;
  const gapHistory = [...(conn?.gap_history ?? [])].reverse();
  const events = [...(conn?.events ?? [])].reverse();
  const disconnectedMs = conn?.disconnected_at ? nowMs - conn.disconnected_at : 0;
  const connectedMs = state === "connected" && conn?.connected_at ? nowMs - conn.connected_at : 0;
  const runtimeCreds = info?.credential_source === "runtime";
  const needsExplicitCreds = info?.credential_source !== "runtime";

  return (
    <div className="max-w-5xl space-y-4">
      {onBack ? (
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 rounded-[7px] px-1 py-0.5 text-[12px] text-muted outline-none transition hover:bg-surface2 hover:text-text focus-visible:ring-2 focus-visible:ring-accent/35"
        >
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="size-3.5">
            <path d="M10 4 6 8l4 4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          机器人列表
        </button>
      ) : null}
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className={cx("size-[9px] flex-none rounded-full", stateDot(state, gap?.missed ?? 0))} />
              <h2 className="m-0 text-[18px] font-semibold">飞书机器人连接</h2>
              <Badge variant={state === "connected" ? "done" : state === "reconnecting" ? "warn" : "default"}>
                {STATE_LABEL[state] ?? state}
              </Badge>
              {info?.enabled ? <Badge variant="info">启动时自动连接</Badge> : <Badge>启动时不自动连接</Badge>}
              {gap && gap.missed > 0 ? <Badge variant="closed">最近核对漏收 {gap.missed} 条</Badge> : null}
            </div>
            <p className="mt-2 text-[12.5px] leading-relaxed text-muted">
              应用 {info?.app_id_masked ?? "未配置"} · 域名 {info?.domain === "lark" ? "Lark" : "飞书"} · 凭据来源{" "}
              {info?.credential_source === "runtime"
                ? "管理台保存"
                : info?.credential_source === "env"
                  ? "环境变量"
                  : "未配置"}
            </p>
            <p className="mt-1 text-[11.5px] leading-relaxed text-faint">
              {state === "connected"
                ? `本次已连接 ${duration(connectedMs)}；最近连上 ${formatTs(conn?.connected_at)}`
                : state === "reconnecting"
                  ? `已断开 ${duration(disconnectedMs)}；超过 5 分钟平台不再重投，恢复后请核对漏收`
                  : "长连接断开时收不到平台推送；发送走 HTTP，不受影响。"}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" size="sm" disabled={!!busy || loading} onClick={() => void load()}>
              刷新
            </Button>
            {state === "connected" || state === "reconnecting" || state === "connecting" ? (
              <Button variant="danger" size="sm" disabled={!!busy || !conn} onClick={disconnect}>
                {busy === "disconnect" ? "断开中…" : "断开连接"}
              </Button>
            ) : (
              <Button variant="primary" size="sm" disabled={!!busy || !info?.configured} onClick={connect}>
                {busy === "connect" ? "连接中…" : "建立连接"}
              </Button>
            )}
          </div>
        </div>
      </Card>

      <div className="grid gap-3 md:grid-cols-2">
        <Card>
          <CardHead>
            <CardTitle>连接健康</CardTitle>
            <span className="text-[11px] text-faint">本次进程</span>
          </CardHead>
          <dl className="mt-3 grid grid-cols-2 gap-2">
            <Metric label="状态" value={STATE_LABEL[state] ?? state} tone={state === "connected" ? "ok" : state === "reconnecting" ? "warn" : undefined} />
            <Metric label="重连成功" value={`${num(conn?.reconnects ?? 0)} 次`} />
            <Metric label="已连接时长" value={state === "connected" ? duration(connectedMs) : "—"} />
            <Metric label="断开时长" value={state === "reconnecting" ? duration(disconnectedMs) : "—"} tone={state === "reconnecting" ? "warn" : undefined} />
            <Metric label="最近收到事件" value={formatTs(conn?.last_event_at) || "—"} />
            <Metric label="最近入池" value={formatTs(conn?.last_inbound_at) || "—"} />
          </dl>
          {conn?.last_error ? (
            <p className="mt-3 break-words rounded-[9px] border border-bad/30 bg-rose-soft px-2.5 py-2 text-[11.5px] leading-relaxed text-bad">
              最近错误{conn.last_error_at ? `（${formatTs(conn.last_error_at)}）` : ""}：{conn.last_error}
            </p>
          ) : null}
        </Card>

        <Card>
          <CardHead>
            <CardTitle>入站全链路</CardTitle>
            <span className="text-[11px] text-faint">事件 → 去重 → 转换 → 入池</span>
          </CardHead>
          <dl className="mt-3 grid grid-cols-2 gap-2">
            <Metric label="平台事件" value={num(counters?.received ?? 0)} />
            <Metric label="重复已忽略" value={num(counters?.duplicates ?? 0)} />
            <Metric label="已交入池" value={num(counters?.processed ?? 0)} />
            <Metric label="实际入库" value={num(inbound?.stored ?? 0)} tone="ok" />
            <Metric label="hub 判重" value={num(inbound?.duplicates ?? 0)} />
            <Metric label="自己发送" value={num(inbound?.self ?? 0)} />
            <Metric label="转换失败" value={num(counters?.conversion_errors ?? 0)} tone={(counters?.conversion_errors ?? 0) > 0 ? "bad" : undefined} />
            <Metric label="处理失败" value={num(counters?.enqueue_errors ?? 0)} tone={(counters?.enqueue_errors ?? 0) > 0 ? "bad" : undefined} />
          </dl>
          <p className="mt-3 text-[11px] leading-relaxed text-faint">
            审批拦截 {num(inbound?.approval_handled ?? 0)} 条；最近入库 {formatTs(inbound?.last_stored_at) || "—"}。
            平台事件明显多于已交入池时，说明事件在转换或交给 hub 前失败。
          </p>
        </Card>
      </div>

      <Card>
        <CardHead>
          <div>
            <CardTitle>漏收核对</CardTitle>
            <p className="mt-1 text-[11.5px] leading-relaxed text-muted">
              按已知会话逐页拉平台消息，只统计、不回填；回填会打乱本地 seq 顺序。
            </p>
          </div>
          <Button variant="ghost" size="sm" disabled={!!busy} onClick={checkGap}>
            {busy === "gap" ? "核对中…" : "核对最近 30 分钟"}
          </Button>
        </CardHead>
        {gap ? (
          <dl className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
            <Metric label="核对窗口" value={`${formatTs(gap.from)} → ${formatTs(gap.to)}`} />
            <Metric label="核对会话" value={`${num(gap.chats ?? 0)} 个`} tone={(gap.chats ?? 0) === 0 ? "warn" : undefined} />
            <Metric label="核对时间" value={formatTs(gap.checked_at)} />
            <Metric label="漏收" value={gap.error ? "未完成" : `${num(gap.missed)} 条`} tone={gap.missed > 0 ? "bad" : gap.error ? "warn" : "ok"} />
          </dl>
        ) : (
          <p className="mt-3 text-[12px] text-muted">还没有核对记录。断线恢复后会自动核对；也可以现在手动跑一次。</p>
        )}
        {gap?.error ? <p className="mt-2 break-words text-[11.5px] text-amber">上次核对未完成：{gap.error}</p> : null}
        {gap && (gap.chats ?? 0) === 0 ? <p className="mt-2 text-[11.5px] text-amber">这次没有已知会话可核对；先让机器人在飞书私聊或群里收到一条消息，再来核对。</p> : null}
        {gapHistory.length ? (
          <ul className="mt-3 divide-y divide-border rounded-[10px] border border-border">
            {gapHistory.slice(0, 8).map((g) => (
              <li key={`${g.checked_at}-${g.from}`} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-[11.5px]">
                <span className="text-muted">{formatTs(g.checked_at)}</span>
                <span className="text-faint">{formatTs(g.from)} → {formatTs(g.to)}</span>
                <span className={cx("font-semibold tabular-nums", g.missed > 0 ? "text-bad" : g.error ? "text-amber" : "text-ok")}>
                  {g.error ? "未完成" : g.missed > 0 ? `漏收 ${g.missed} 条` : "无漏收"}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHead>
            <CardTitle>最近事件</CardTitle>
            <span className="text-[11px] text-faint">本次进程，最多 40 条</span>
          </CardHead>
          {events.length ? (
            <ul className="mt-3 space-y-2">
              {events.slice(0, 12).map((ev, i) => (
                <li key={`${ev.at}-${i}`} className="flex gap-2 text-[11.5px] leading-relaxed">
                  <span className={cx(
                    "mt-[5px] size-[6px] flex-none rounded-full",
                    ev.kind === "error" ? "bg-bad" : ev.kind === "gap" ? "bg-amber" : ev.kind === "connected" || ev.kind === "reconnected" ? "bg-ok" : "bg-muted",
                  )} />
                  <div className="min-w-0">
                    <span className="mr-1.5 text-faint">{formatTs(ev.at)}</span>
                    <span className="font-semibold text-text">{EVENT_LABEL[ev.kind] ?? ev.kind}</span>
                    <span className="ml-1.5 break-words text-muted">{ev.message}</span>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-[12px] text-muted">还没有事件。连接后这里会出现状态变化、错误和漏收核对记录。</p>
          )}
        </Card>

        <Card>
          <CardHead>
            <CardTitle>凭据</CardTitle>
            <Badge variant={runtimeCreds ? "info" : info?.credential_source === "env" ? "default" : "closed"}>
              {runtimeCreds ? "管理台保存" : info?.credential_source === "env" ? "环境变量" : "未配置"}
            </Badge>
          </CardHead>
          <p className="mt-2 text-[11.5px] leading-relaxed text-muted">
            保存后写入本机 <code className="rounded bg-surface2 px-1 py-px text-[11px]">data/secrets/feishu.json</code>（0600）；
            接口只回掩码。{needsExplicitCreds ? "当前凭据来自环境变量或未配置，改到本机需要同时填写 App ID 和 Secret。" : "留空表示沿用已保存值。"}
          </p>
          <div className="mt-3 space-y-2.5">
            <label className="block">
              <span className="mb-1 block text-[11.5px] font-semibold text-muted">App ID</span>
              <Input
                value={appId}
                autoComplete="off"
                placeholder={info?.app_id_masked ? `当前 ${info.app_id_masked}（留空不修改）` : "cli_xxxxxxxxxxxxxxxx"}
                onChange={(e) => setAppId(e.target.value)}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11.5px] font-semibold text-muted">App Secret</span>
              <Input
                type="password"
                value={appSecret}
                autoComplete="new-password"
                placeholder={runtimeCreds ? "已保存；留空不修改" : info?.credential_source === "env" ? "环境变量已配置；改到本机需重新输入" : "App Secret"}
                onChange={(e) => setAppSecret(e.target.value)}
              />
            </label>
            <div className="grid gap-2.5 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-[11.5px] font-semibold text-muted">域名</span>
                <Select
                  value={domain}
                  onValueChange={(v) => setDomain(v === "lark" ? "lark" : "feishu")}
                  options={[{ value: "feishu", label: "飞书（feishu.cn）" }, { value: "lark", label: "Lark（larksuite.com）" }]}
                  ariaLabel="飞书域名"
                />
              </label>
              <label className="flex items-end gap-2 pb-2.5 text-[12px] text-muted">
                <input type="checkbox" className="accent-[var(--rb-accent)]" checked={verify} onChange={(e) => setVerify(e.target.checked)} />
                保存前调用机器人接口验证
              </label>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" size="sm" disabled={!!busy} onClick={save}>
                  {busy === "save" ? "保存中…" : "保存凭据"}
                </Button>
                {runtimeCreds ? (
                  <Button variant="danger" size="sm" disabled={!!busy} onClick={clear}>
                    {busy === "clear" ? "删除中…" : "删除本机凭据"}
                  </Button>
                ) : null}
              </div>
              <span className="text-[11px] text-faint">{info?.updated_at ? `更新于 ${formatTs(Date.parse(info.updated_at))}` : ""}</span>
            </div>
          </div>
        </Card>
      </div>

      <Card>
        <CardTitle>对接清单</CardTitle>
        <ul className="mt-2 space-y-1.5 text-[12px] leading-relaxed text-muted">
          <li>应用类型选企业自建应用，并开启「机器人」能力。</li>
          <li>事件订阅添加 <code className="rounded bg-surface2 px-1 py-px text-[11px]">im.message.receive_v1</code>，订阅方式选「长连接」。</li>
          <li>权限至少包含 <code className="rounded bg-surface2 px-1 py-px text-[11px]">im:message</code>、<code className="rounded bg-surface2 px-1 py-px text-[11px]">im:message.p2p_msg</code>、<code className="rounded bg-surface2 px-1 py-px text-[11px]">im:message.group_at_msg</code>；要读群里所有消息再加 <code className="rounded bg-surface2 px-1 py-px text-[11px]">im:message.group_msg</code>。</li>
          <li>可选：<code className="rounded bg-surface2 px-1 py-px text-[11px]">contact:user.base:readonly</code> 取用户名，<code className="rounded bg-surface2 px-1 py-px text-[11px]">im:chat:readonly</code> 取群名，<code className="rounded bg-surface2 px-1 py-px text-[11px]">im:message.reactions:read</code> 收表情回复。</li>
          <li>版本发布并通过管理员审核后长连接才可用；改完权限需要重新发布。</li>
        </ul>
      </Card>

      <div role="status" aria-live="polite">
        <StatusText text={note.text} error={note.error} />
      </div>
    </div>
  );
}