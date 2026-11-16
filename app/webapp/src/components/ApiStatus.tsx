import { cx } from "../lib/cx.ts";

export type ApiHealth = "checking" | "ok" | "bad";

/** 页眉里的 API 状态：地址不再直接铺在 banner 上，悬浮才显示。 */
export function ApiStatus({ health }: { health: ApiHealth }) {
  const text = health === "ok" ? "API 正常" : health === "bad" ? "API 异常" : "连接中…";
  const origin = window.location.origin;

  return (
    <div className="group relative flex min-w-0 flex-none items-center gap-1.5 text-[12.5px] text-muted">
      <span
        className={cx(
          "size-[8px] flex-none rounded-full",
          health === "ok" && "bg-ok shadow-[0_0_0_3px_color-mix(in_srgb,var(--rb-ok)_18%,transparent)]",
          health === "bad" && "bg-bad shadow-[0_0_0_3px_color-mix(in_srgb,var(--rb-bad)_18%,transparent)]",
          health === "checking" && "bg-muted",
        )}
      />
      <span className="whitespace-nowrap">{text}</span>

      <div
        role="tooltip"
        className={cx(
          "pointer-events-none absolute right-0 top-full z-30 mt-2 w-[280px] rounded-[10px] border border-border bg-surface p-3",
          "text-[11.5px] leading-relaxed text-muted opacity-0 shadow-[0_10px_30px_rgba(0,0,0,0.18)] transition-opacity duration-150",
          "group-hover:opacity-100 group-focus-within:opacity-100",
        )}
      >
        <div className="mb-1.5 font-semibold text-text">API 状态</div>
        <p>每 10 秒探一次 /health；异常通常说明后端进程没起来或本机网络断了。</p>
        <dl className="mt-2 space-y-0.5 border-t border-border pt-2">
          <div className="flex justify-between gap-3">
            <dt className="shrink-0 text-faint">服务地址</dt>
            <dd className="min-w-0 break-all text-right font-mono text-[11px] text-muted">{origin}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-faint">当前</dt>
            <dd className="tabular-nums">{text}</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}
