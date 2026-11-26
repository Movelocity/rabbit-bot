import type { ReactNode } from "react";
import { cx } from "../lib/cx.ts";

export function SideNav({
  children,
  ariaLabel,
  className,
}: {
  children: ReactNode;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <nav
      aria-label={ariaLabel}
      className={cx(
        "rb-thin-scroll flex w-[228px] flex-none flex-col gap-0.5 overflow-y-auto border-r border-border bg-surface px-2 py-3",
        "max-[820px]:w-full max-[820px]:flex-row max-[820px]:overflow-x-auto max-[820px]:border-b max-[820px]:border-r-0 max-[820px]:py-2",
        className,
      )}
    >
      {children}
    </nav>
  );
}

export function SideNavItem({
  active,
  onClick,
  icon,
  label,
  count,
  alert,
  title,
}: {
  active: boolean;
  onClick: () => void;
  icon?: ReactNode;
  label: ReactNode;
  count?: ReactNode;
  alert?: number;
  title?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      className={cx(
        "flex w-full min-w-0 items-center gap-2 rounded-[8px] px-2.5 py-1.5 text-left text-[12.5px] outline-none transition",
        "focus-visible:ring-2 focus-visible:ring-accent/35 max-[820px]:w-auto max-[820px]:flex-none",
        active
          ? "bg-accent-soft font-semibold text-accent-ink"
          : "text-muted hover:bg-surface2 hover:text-text",
      )}
    >
      {icon !== undefined ? (
        <span className="flex size-4 flex-none items-center justify-center">{icon}</span>
      ) : null}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {alert ? (
        <span
          className="flex-none rounded-full bg-amber px-1.5 text-[10px] font-bold leading-[16px] text-white"
          title="待审批"
        >
          {alert}
        </span>
      ) : null}
      {count !== undefined ? (
        <span className="flex-none text-[10.5px] tabular-nums text-faint">{count}</span>
      ) : null}
    </button>
  );
}

export function SideNavGroup({
  label,
  count,
  collapsible,
  collapsed,
  onToggle,
  children,
}: {
  label: ReactNode;
  count?: ReactNode;
  collapsible?: boolean;
  collapsed?: boolean;
  onToggle?: () => void;
  children: ReactNode;
}) {
  const headingClass =
    "mb-1 mt-3 flex w-full items-center gap-1.5 rounded-[6px] px-2.5 text-left text-[10px] font-bold uppercase tracking-[0.1em] text-faint max-[820px]:hidden";

  return (
    <div className="flex flex-col gap-0.5 max-[820px]:contents">
      {collapsible ? (
        <button
          type="button"
          className={cx(headingClass, "outline-none transition hover:text-text")}
          aria-expanded={!collapsed}
          onClick={onToggle}
        >
          <span>{label}</span>
          {count !== undefined ? (
            <span className="font-normal tabular-nums">{count}</span>
          ) : null}
          <svg
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
            className={cx("ml-auto size-3 transition-transform", !collapsed && "rotate-90")}
          >
            <path
              d="m6 4 4 4-4 4"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      ) : (
        <div className={headingClass}>
          <span>{label}</span>
          {count !== undefined ? (
            <span className="font-normal tabular-nums">{count}</span>
          ) : null}
        </div>
      )}
      <span
        className="mx-1 hidden w-px flex-none self-stretch bg-border max-[820px]:block"
        aria-hidden="true"
      />
      <div className={cx("flex flex-col gap-0.5 max-[820px]:contents", collapsed && "hidden max-[820px]:contents")}>
        {children}
      </div>
    </div>
  );
}