import { useCallback, useEffect, useState } from "react";
import { useApi } from "../lib/api-context.tsx";
import { usePolling } from "../lib/use-polling.ts";
import { cx } from "../lib/cx.ts";
import { countdown, formatTs } from "../lib/format.ts";
import type { SchedulerStatus } from "../lib/types.ts";

/** 页眉里的自然 tick 倒计时：自己按秒走，避免整页每秒重渲染；悬浮展示调度说明。 */
export function SchedulerTickStatus() {
  const request = useApi();
  const [status, setStatus] = useState<SchedulerStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [offset, setOffset] = useState(0);

  const load = useCallback(async () => {
    try {
      setStatus(await request<SchedulerStatus>("/v1/scheduler/status"));
      setFailed(false);
    } catch {
      setStatus(null);
      setFailed(true);
    }
  }, [request]);

  useEffect(() => {
    void load();
  }, [load]);

  usePolling(load, 3000);

  useEffect(() => {
    if (!status) return;
    // 用服务端时间校准浏览器时钟，避免本机时间偏了把倒计时算错
    setOffset(Number(status.now) - Date.now());
  }, [status]);

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const remain = status?.next_tick_at ? status.next_tick_at - (nowMs + offset) : null;
  const ok = !!status?.available && !status.paused && remain !== null;
  const text = failed
    ? "不可用"
    : !status
      ? "读取中…"
      : !status.available
        ? "不可用"
        : status.paused
          ? "已暂停"
          : countdown(remain);

  return (
    <div className="group relative flex flex-none items-center gap-1.5 text-[12.5px] text-muted">
      <span
        className={cx(
          "size-[8px] flex-none rounded-full",
          !ok ? "bg-muted" : remain !== null && remain <= 0 ? "bg-accent" : "bg-ok",
        )}
      />
      <span className="whitespace-nowrap font-semibold text-text">自然 tick</span>
      <span className="whitespace-nowrap font-mono text-[12px] font-semibold tabular-nums text-accent-ink">
        {text}
      </span>
      {status?.paused && (
        <span className="whitespace-nowrap rounded-full border border-amber/40 bg-amber-soft px-1.5 py-px text-[10px] font-semibold text-amber max-[900px]:hidden">
          已暂停
        </span>
      )}

      <div
        role="tooltip"
        className={cx(
          "pointer-events-none absolute right-0 top-full z-30 mt-2 w-[280px] rounded-[10px] border border-border bg-surface p-3",
          "text-[11.5px] leading-relaxed text-muted opacity-0 shadow-[0_10px_30px_rgba(0,0,0,0.18)] transition-opacity duration-150",
          "group-hover:opacity-100 group-focus-within:opacity-100",
        )}
      >
        <div className="mb-1.5 font-semibold text-text">自然 tick</div>
        <p>
          调度器按固定周期检查各池未读：群聊攒到 tick 一起读，私聊 / @ 会更快唤醒，活跃对话期间会自动缩短间隔。
        </p>
        {status?.available && (
          <dl className="mt-2 space-y-0.5 border-t border-border pt-2">
            <div className="flex justify-between gap-3">
              <dt className="text-faint">周期</dt>
              <dd className="tabular-nums">
                每 {Math.round(status.tick_ms / 1000)}s
                {status.active_tick_ms !== status.tick_ms &&
                  `（活跃时 ${Math.round(status.active_tick_ms / 1000)}s）`}
              </dd>
            </div>
            {status.last_tick_at ? (
              <div className="flex justify-between gap-3">
                <dt className="text-faint">上次 tick</dt>
                <dd className="tabular-nums">{formatTs(status.last_tick_at)}</dd>
              </div>
            ) : null}
            <div className="flex justify-between gap-3">
              <dt className="text-faint">去抖中</dt>
              <dd className="tabular-nums">{status.debouncing.length} 个会话</dd>
            </div>
          </dl>
        )}
      </div>
    </div>
  );
}
