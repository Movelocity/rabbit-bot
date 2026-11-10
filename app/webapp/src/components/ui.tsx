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
        "inline-flex items-center justify-center gap-1.5 rounded-[9px] border border-transparent transition disabled:opacity-55",
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
  done: "text-ok border-ok/40",
  closed: "text-bad border-bad/35",
  info: "text-accent border-accent/40",
  warn: "text-amber-700 border-amber-500 bg-amber-500/10 dark:text-amber-300 dark:border-amber-700",
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
        "inline-block rounded-full border px-1.5 py-0.5 text-[11px] leading-normal",
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
      className="inline-flex rounded-full border border-border bg-surface2 p-0.5"
      role="group"
      aria-label={label}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={cx(
            "rounded-full px-3 py-1 text-xs transition",
            value === option.value
              ? "bg-accent-soft font-semibold text-accent"
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
