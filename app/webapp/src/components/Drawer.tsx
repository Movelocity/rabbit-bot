import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "./ui.tsx";

export function Drawer({
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
    <div className="fixed inset-0 z-[80]" role="dialog" aria-modal="true">
      <div
        className="absolute inset-0 bg-slate-900/40 animate-[rb-fade-in_160ms_ease-out]"
        onClick={onClose}
      />
      <aside className="absolute inset-y-0 left-0 flex w-full max-w-[460px] flex-col border-r border-border bg-surface shadow-[var(--rb-shadow)] animate-[rb-drawer-in_200ms_ease-out] max-sm:max-w-none">
        <header className="flex flex-none items-center justify-between gap-3 border-b border-border px-4 py-3">
          <h2 className="m-0 text-base font-semibold">{title}</h2>
          <Button variant="ghost" size="sm" onClick={onClose}>
            关闭
          </Button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
      </aside>
    </div>,
    document.body,
  );
}
