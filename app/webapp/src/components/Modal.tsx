import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "./ui.tsx";

export function Modal({
  title,
  onClose,
  children,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    document.body.classList.add("overflow-hidden");
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.classList.remove("overflow-hidden");
    };
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center p-6 max-sm:p-2.5"
      role="dialog"
      aria-modal="true"
    >
      <div
        className="absolute inset-0 bg-slate-900/55 backdrop-blur-[2px]"
        onClick={onClose}
      />
      <div className="relative max-h-[90vh] w-full max-w-[940px] overflow-auto rounded-2xl border border-border bg-surface p-5 shadow-[var(--rb-shadow)] max-sm:max-h-[94vh] max-sm:rounded-xl max-sm:p-3.5">
        <div className="mb-3.5 flex items-center justify-between gap-3">
          <h2 className="m-0 text-lg font-semibold">{title}</h2>
          <Button variant="ghost" size="sm" onClick={onClose}>
            关闭
          </Button>
        </div>
        <div className="min-w-0">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
