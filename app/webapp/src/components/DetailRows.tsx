import type { ReactNode } from "react";
import { cx } from "../lib/cx.ts";

export interface DetailRow {
  label: ReactNode;
  value: ReactNode;
  mono?: boolean;
}

export function DetailRows({ rows, className }: { rows: DetailRow[]; className?: string }) {
  return (
    <div
      className={cx(
        "mt-3 grid grid-cols-[120px_minmax(0,1fr)] gap-x-3.5 gap-y-2 border-t border-dashed border-border pt-3 max-sm:grid-cols-1 max-sm:gap-y-0.5",
        className,
      )}
    >
      {rows.map((row, index) => (
        <div key={index} className="contents">
          <span className="text-xs text-muted max-sm:mt-1.5">{row.label}</span>
          <div
            className={cx(
              "whitespace-pre-wrap wrap-anywhere text-[13px]",
              row.mono && "font-mono",
            )}
          >
            {row.value}
          </div>
        </div>
      ))}
    </div>
  );
}
