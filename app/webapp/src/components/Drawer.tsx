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
      <aside className="absolute inset-y-0 right-0 flex w-full max-w-[520px] flex-col border-l border-border bg-surface shadow-[-18px_0_50px_-30px_rgba(0,0,0,0.45)] animate-[rb-drawer-in_200ms_ease-out] max-sm:max-w-none">
        <header className="flex flex-none items-start justify-between gap-2.5 border-b border-border px-4 py-3.5">
          <h2 className="rb-display m-0 text-[18px] leading-tight wrap-anywhere">{title}</h2>
          <Button variant="ghost" size="sm" onClick={onClose}>
            关闭
          </Button>
        </header>
        <div className="rb-thin-scroll min-h-0 flex-1 overflow-y-auto px-4 pb-10 pt-4">
          {children}
        </div>
      </aside>
    </div>,
    document.body,
  );
}
