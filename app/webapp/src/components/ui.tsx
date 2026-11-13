import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  TextareaHTMLAttributes,
} from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { cx } from "../lib/cx.ts";
import type { BadgeVariant } from "../lib/format.ts";

type ButtonVariant = "default" | "primary" | "ghost" | "danger";
type ButtonSize = "md" | "sm";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  default: "bg-surface2 text-text hover:brightness-95",
  primary: "bg-accent text-white hover:brightness-105",
  ghost: "bg-transparent border-border hover:bg-surface2",
  danger: "bg-transparent border-bad/40 text-bad hover:bg-bad/10",
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  md: "px-3.5 py-2",
  sm: "px-2.5 py-1.5 text-[13px]",
};

export function Button({
  variant = "default",
  size = "md",
  className,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  return (
    <button
      type={type}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[9px] border border-transparent transition disabled:opacity-55",
        BUTTON_SIZES[size],
        BUTTON_VARIANTS[variant],
        className,
      )}
      {...props}
    />
  );
}

const BADGE_VARIANTS: Record<BadgeVariant, string> = {
  default: "text-muted border-border",
  done: "text-ok border-ok/40 bg-ok-soft",
  closed: "text-bad border-bad/35 bg-rose-soft",
  info: "text-accent-ink border-accent/40 bg-accent-soft",
  warn: "text-amber border-amber/40 bg-amber-soft",
};

export function Badge({
  variant = "default",
  className,
  children,
}: {
  variant?: BadgeVariant;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cx(
        "inline-block whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[11px] leading-normal",
        BADGE_VARIANTS[variant],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Card({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <article
      className={cx(
        "rounded-[14px] border border-border bg-surface p-4 shadow-[var(--rb-shadow)]",
        className,
      )}
      {...props}
    />
  );
}

export function CardHead({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cx("flex items-start justify-between gap-2.5", className)} {...props} />
  );
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("font-semibold wrap-anywhere", className)} {...props} />;
}

export function CardMeta({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cx("mt-1.5 flex flex-wrap gap-x-3 gap-y-1.5 text-xs text-muted", className)}
      {...props}
    />
  );
}

export function CardBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cx("mt-2 whitespace-pre-wrap wrap-anywhere text-sm", className)}
      {...props}
    />
  );
}

export const inputClass =
  "w-full rounded-[9px] border border-border bg-surface px-3 py-2.5 outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/25";

export const textareaClass = cx(inputClass, "min-h-[44px] resize-y");

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx(inputClass, className)} {...props} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cx(textareaClass, className)} {...props} />;
}

export interface SelectOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
}

const SELECT_EMPTY_VALUE = "__rb_select_empty__";

function ChevronDownIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <path
        d="m4 6 4 4 4-4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <path
        d="m3.5 8.5 3 3 6-7"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Select({
  value,
  onValueChange,
  options,
  placeholder = "请选择",
  className,
  ariaLabel,
  disabled,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  className?: string;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  const radixValue = value === "" ? SELECT_EMPTY_VALUE : value;
  return (
    <SelectPrimitive.Root
      value={radixValue}
      onValueChange={(next) => onValueChange(next === SELECT_EMPTY_VALUE ? "" : next)}
      disabled={disabled}
    >
      <SelectPrimitive.Trigger
        aria-label={ariaLabel}
        className={cx(
          "group flex w-full min-w-0 items-center justify-between gap-2 rounded-[9px] border border-border bg-surface px-3 py-2.5 text-left outline-none transition",
          "focus:border-accent focus:ring-2 focus:ring-accent/25 disabled:opacity-55",
          className,
        )}
      >
        <SelectPrimitive.Value placeholder={placeholder} className="truncate" />
        <SelectPrimitive.Icon asChild>
          <ChevronDownIcon className="h-4 w-4 shrink-0 text-muted transition-transform group-data-[state=open]:rotate-180" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={4}
          collisionPadding={8}
          className={cx(
            "z-50 overflow-hidden rounded-[10px] border border-border bg-surface p-1 text-text shadow-[var(--rb-shadow)]",
            "data-[state=open]:animate-[rb-select-in_120ms_ease-out] data-[state=closed]:animate-[rb-select-out_90ms_ease-in]",
          )}
        >
          <SelectPrimitive.Viewport className="max-h-[min(320px,var(--radix-select-content-available-height))] min-w-[var(--radix-select-trigger-width)] overflow-y-auto p-0.5">
            {options.map((option) => {
              const itemValue =
                option.value === "" ? SELECT_EMPTY_VALUE : option.value;
              return (
                <SelectPrimitive.Item
                  key={itemValue}
                  value={itemValue}
                  disabled={option.disabled}
                  className={cx(
                    "relative flex cursor-pointer select-none items-center rounded-[7px] py-1.5 pl-2.5 pr-8 text-[13px] outline-none transition",
                    "data-[highlighted]:bg-accent-soft data-[highlighted]:text-accent",
                    "data-[disabled]:pointer-events-none data-[disabled]:opacity-45",
                  )}
                >
                  <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                  <SelectPrimitive.ItemIndicator className="absolute right-2 inline-flex items-center text-accent">
                    <CheckIcon className="h-3.5 w-3.5" />
                  </SelectPrimitive.ItemIndicator>
                </SelectPrimitive.Item>
              );
            })}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

export function Field({
  label,
  compact,
  grow,
  children,
  className,
}: {
  label: ReactNode;
  compact?: boolean;
  grow?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label
      className={cx(
        "block min-w-0",
        compact && "w-full max-w-[220px]",
        grow && "min-w-[220px] flex-1 basis-[260px]",
        className,
      )}
    >
      <span className="mb-1 block text-xs text-muted">{label}</span>
      {children}
    </label>
  );
}

export function StatusText({ text, error }: { text?: string; error?: boolean }) {
  return (
    <p
      className={cx("my-2 min-h-5 text-[13px]", error ? "text-bad" : "text-muted")}
      role={error ? "alert" : "status"}
    >
      {text || ""}
    </p>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="mx-auto my-10 max-w-[360px] text-center text-sm text-muted">{children}</p>
  );
}

export function Page({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cx(
        "rb-thin-scroll h-full overflow-y-auto px-[clamp(16px,3.4vw,40px)] pb-16 pt-[22px] max-[820px]:px-3.5 max-[820px]:pb-12 max-[820px]:pt-4",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function PageHead({
  eyebrow,
  title,
  sub,
  actions,
}: {
  eyebrow: ReactNode;
  title: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-end gap-4">
      <div className="min-w-0">
        <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-faint">
          {eyebrow}
        </div>
        <h1 className="rb-display m-0 mt-1 text-[25px] leading-[1.15]">{title}</h1>
        {sub ? (
          <p className="mt-1 max-w-[62ch] text-[12.5px] leading-relaxed text-muted">{sub}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </div>
  );
}

type KpiTone = "accent" | "amber" | "rose" | "default";

const KPI_BAR: Record<KpiTone, string> = {
  accent: "bg-accent",
  amber: "bg-amber",
  rose: "bg-rose",
  default: "bg-line-strong",
};

export function KpiGrid({ children }: { children: ReactNode }) {
  return (
    <div className="mb-3.5 grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2.5">
      {children}
    </div>
  );
}

export function Kpi({
  label,
  value,
  note,
  tone = "default",
}: {
  label: ReactNode;
  value: ReactNode;
  note?: ReactNode;
  tone?: KpiTone;
}) {
  return (
    <div className="relative overflow-hidden rounded-[13px] border border-border bg-surface px-3.5 py-3">
      <span className={cx("absolute inset-y-0 left-0 w-[3px]", KPI_BAR[tone])} />
      <div className="text-[11px] tracking-[0.04em] text-muted">{label}</div>
      <div className="rb-display mt-0.5 text-[25px] font-bold leading-tight tabular-nums">
        {value}
      </div>
      {note ? <div className="mt-0.5 text-[11px] text-faint">{note}</div> : null}
    </div>
  );
}

type ChipTone = "default" | "accent" | "clay" | "amber" | "rose" | "ok";

const CHIP_TONES: Record<ChipTone, string> = {
  default: "border-border bg-surface text-muted",
  accent: "border-accent/40 bg-accent-soft text-accent-ink font-semibold",
  clay: "border-clay/40 bg-clay-soft text-clay",
  amber: "border-amber/40 bg-amber-soft text-amber",
  rose: "border-rose/40 bg-rose-soft text-rose",
  ok: "border-ok/40 bg-ok-soft text-ok",
};

export function Chip({
  tone = "default",
  className,
  children,
}: {
  tone?: ChipTone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px]",
        CHIP_TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Notice({
  tone = "default",
  className,
  children,
}: {
  tone?: "default" | "accent";
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cx(
        "flex items-start gap-2.5 rounded-[10px] border px-3 py-2.5 text-[12px] leading-[1.6]",
        tone === "accent"
          ? "border-accent/30 bg-accent-soft text-accent-ink"
          : "border-border bg-surface2 text-muted",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function SectionTitle({
  children,
  count,
}: {
  children: ReactNode;
  count?: ReactNode;
}) {
  return (
    <h2 className="rb-display mb-2.5 mt-5 flex items-baseline gap-2 text-[17px]">
      {children}
      {count !== undefined ? (
        <span className="text-[12px] font-normal text-muted">{count}</span>
      ) : null}
    </h2>
  );
}

export function FilterBar({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cx("mb-3 flex flex-wrap items-end gap-2.5", className)}>{children}</div>
  );
}

export function TableWrap({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cx(
        "rb-thin-scroll overflow-auto rounded-[12px] border border-border bg-surface",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  label?: string;
}) {
  return (
    <div
      className="inline-flex rounded-full border border-border bg-surface p-0.5"
      role="group"
      aria-label={label}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={cx(
            "rounded-full px-3 py-1 text-xs outline-none transition",
            "focus-visible:ring-2 focus-visible:ring-accent/35",
            value === option.value
              ? "bg-accent font-semibold text-[color:var(--rb-surface)] shadow-sm"
              : "text-muted hover:text-text",
          )}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
