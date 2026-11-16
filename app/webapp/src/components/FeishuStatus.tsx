import { useCallback, useEffect, useState } from "react";
import { useApi } from "../lib/api-context.tsx";
import { usePolling } from "../lib/use-polling.ts";
import { cx } from "../lib/cx.ts";
import { duration, formatTs } from "../lib/format.ts";
import type { AdapterStatus, AdapterStatusResponse } from "../lib/types.ts";

/** 事件平台只重投最近几分钟：断得比这久，早先的消息就不会再推，恢复后靠后端按会话核对才知道漏了多少。 */
const REPLAY_WINDOW_MS = 5 * 60_000;
/** 核对出的漏收在顶栏挂多久；之后仍然能在悬浮详情里看到 */
const GAP_SHOW_MS = 30 * 60_000;

/** 页眉里的飞书连接状态：自己按秒走显示断开时长，悬浮看断开 / 核对详情。 */
export function FeishuStatus() {
  const request = useApi();
  const [status, setStatus] = useState<AdapterStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [offset, setOffset] = useState(0);

  const load = useCallback(async () => {
    try {
      const r = await request<AdapterStatusResponse>("/v1/adapters/status");
      setStatus(r.adapters.find((a) => a.platform === "feishu") ?? null);
      setOffset(Number(r.now) - Date.now());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [request]);

  useEffect(() => {
    void load();
  }, [load]);

  usePolling(load, 5000);

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  if (failed || !status) return null;

  const now = nowMs + offset;
  const disconnectedMs = status.disconnected_at ? now - status.disconnected_at : 0;
  const gap = status.last_gap;
  const missedRecently = !!gap && gap.missed > 0 && now - gap.checked_at < GAP_SHOW_MS;
  const risking = status.state === "reconnecting" && disconnectedMs > REPLAY_WINDOW_MS;

  const text =
    status.state === "connected"
      ? "已连接"
      : status.state === "reconnecting"
        ? `断开 ${duration(disconnectedMs)}`
        : status.state === "connecting"
          ? "连接中…"
          : "未连接";
  const dot = missedRecently
    ? "bg-bad"
    : risking
      ? "bg-amber"
      : status.state === "connected"
        ? "bg-ok"
        : "bg-muted";

  return (
    <div className="group relative flex flex-none items-center gap-1.5 text-[12.5px] text-muted">
      <span className={cx("size-[8px] flex-none rounded-full", dot)} />
      <span className="whitespace-nowrap font-semibold text-text">飞书</span>
      <span className="whitespace-nowrap font-mono text-[12px] font-semibold tabular-nums text-accent-ink">
        {text}
      </span>
      {missedRecently ? (
        <span className="whitespace-nowrap rounded-full border border-bad/35 bg-rose-soft px-1.5 py-px text-[10px] font-semibold text-bad max-[900px]:hidden">
          漏收 {gap!.missed} 条
        </span>
      ) : risking ? (
        <span className="whitespace-nowrap rounded-full border border-amber/40 bg-amber-soft px-1.5 py-px text-[10px] font-semibold text-amber">
          可能丢消息
        </span>
      ) : null}

      <div
        role="tooltip"
        className={cx(
          "pointer-events-none absolute right-0 top-full z-30 mt-2 w-[300px] rounded-[10px] border border-border bg-surface p-3",
          "text-[11.5px] leading-relaxed text-muted opacity-0 shadow-[0_10px_30px_rgba(0,0,0,0.18)] transition-opacity duration-150",
          "group-hover:opacity-100 group-focus-within:opacity-100",
        )}
      >
        <div className="mb-1.5 font-semibold text-text">飞书连接</div>
        <p>
          长连接断开时收不到平台推送。飞书只重投断开前约 5 分钟的事件，更早的消息恢复后也补不回来，后端会在恢复时按会话核对漏了多少。
        </p>
        <dl className="mt-2 space-y-0.5 border-t border-border pt-2">
          <div className="flex justify-between gap-3">
            <dt className="text-faint">状态</dt>
            <dd className="tabular-nums">
              {status.state === "connected"
                ? "已连接"
                : status.state === "reconnecting"
                  ? `重连中 · 已断开 ${duration(disconnectedMs)}`
                  : status.state === "connecting"
                    ? "首次连接中"
                    : "未连接"}
            </dd>
          </div>
          {status.connected_at ? (
            <div className="flex justify-between gap-3">
              <dt className="text-faint">最近连上</dt>
              <dd className="tabular-nums">{formatTs(status.connected_at)}</dd>
            </div>
          ) : null}
          {gap ? (
            <>
              <div className="flex justify-between gap-3">
                <dt className="text-faint">上次断开核对</dt>
                <dd className="tabular-nums">{formatTs(gap.checked_at)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-faint">漏收</dt>
                <dd className={cx("tabular-nums", gap.missed > 0 && "font-semibold text-bad")}>
                  {gap.error ? `未核对完（${gap.error}）` : `${gap.missed} 条`}
                </dd>
              </div>
            </>
          ) : null}
          {status.last_error ? (
            <div className="flex justify-between gap-3">
              <dt className="text-faint">最近错误</dt>
              <dd className="max-w-[180px] break-words text-right text-bad">{status.last_error}</dd>
            </div>
          ) : null}
        </dl>
      </div>
    </div>
  );
}
