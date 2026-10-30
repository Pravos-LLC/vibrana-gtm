"use client";

import { createContext, useContext, useEffect, useId, useRef, type ReactNode } from "react";

const TitleId = createContext<string | undefined>(undefined);
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Right-hand shadcn-style sheet. Named by its SheetTitle (aria-labelledby); on open, focus moves to the first
 * field (or control) inside it and Tab stays inside; Escape or the backdrop closes it, and focus goes back to
 * whatever opened it.
 */
export function Sheet({ open, onOpenChange, children, placement = "right" }: { open: boolean; onOpenChange: (open: boolean) => void; children: ReactNode; /** "center": a modal dialog instead of a side panel. */ placement?: "right" | "center" }) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  // Latest close handler, so a parent passing an inline function does not re-run the focus effect on every render.
  const close = useRef(onOpenChange);
  close.current = onOpenChange;
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const items = () => [...(panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    const first = panel.current?.querySelector<HTMLElement>("input:not([disabled]), select:not([disabled]), textarea:not([disabled])") ?? items()[0];
    (first ?? panel.current)?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") return close.current(false);
      if (event.key !== "Tab") return;
      const list = items();
      if (!list.length) return;
      const [head, tail] = [list[0], list[list.length - 1]];
      if (event.shiftKey && document.activeElement === head) { event.preventDefault(); tail.focus(); }
      else if (!event.shiftKey && document.activeElement === tail) { event.preventDefault(); head.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      opener?.focus?.();
    };
  }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40">
      <button type="button" tabIndex={-1} className="absolute inset-0 bg-black/40" aria-label="Close" onClick={() => onOpenChange(false)} />
      <div ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId} className={placement === "center" ? "absolute left-1/2 top-1/2 flex max-h-[90vh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col overflow-y-auto rounded-xl border border-line bg-[color:var(--surface-base)] p-6 shadow-xl" : "absolute inset-y-0 right-0 flex w-full max-w-md flex-col border-l border-line bg-[color:var(--surface-base)] p-6 shadow-xl"}>
        <TitleId.Provider value={titleId}>{children}</TitleId.Provider>
      </div>
    </div>
  );
}

export function SheetHeader({ children }: { children: ReactNode }) {
  return <div className="mb-4 space-y-1">{children}</div>;
}

export function SheetTitle({ children }: { children: ReactNode }) {
  return <h2 id={useContext(TitleId)} className="font-display text-pl-lg font-semibold text-ink">{children}</h2>;
}
