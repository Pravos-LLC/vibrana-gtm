"use client";

// One small toast for the cockpit. The store lives at module level, not in React state, so a toast survives the
// client navigation that often follows the action that raised it (approve, then on to the next storyboard): every
// page's Shell mounts a <Toaster />, and the new one shows what the old one was showing.
import Link from "next/link";
import { useEffect, useSyncExternalStore } from "react";
import { X } from "lucide-react";

type Toast = { id: number; text: string; link?: { href: string; label: string }; until: number };
let current: Toast | null = null;
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function toast(text: string, link?: Toast["link"], ms = 7000) {
  current = { id: ++seq, text, link, until: Date.now() + ms };
  emit();
}
export function dismissToast() {
  current = null;
  emit();
}

/** After John sends a note in /content or /studio: nothing in the web app runs an agent, so say what happens next. */
export const NOTE_SENT = "Sent. An agent will pick this up; track it in";
export function noteSent() {
  toast(NOTE_SENT, { href: "/work", label: "/work" });
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export function Toaster() {
  const t = useSyncExternalStore(subscribe, () => current, () => null);
  useEffect(() => {
    if (!t) return;
    const timer = setTimeout(() => { if (current?.id === t.id) dismissToast(); }, Math.max(0, t.until - Date.now()));
    return () => clearTimeout(timer);
  }, [t]);
  return (
    <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4">
      {t && (
        <div role="status" data-testid="toast" className="pointer-events-auto flex max-w-md items-center gap-3 rounded-lg border border-line bg-[color:var(--surface-card)] px-4 py-2.5 text-sm text-ink shadow-lg">
          <span>
            {t.text}
            {t.link && <> <Link href={t.link.href} prefetch={false} onClick={dismissToast} className="font-medium underline underline-offset-4">{t.link.label}</Link>.</>}
          </span>
          <button type="button" onClick={dismissToast} aria-label="Dismiss" className="text-ink-3 hover:text-ink"><X className="size-4" /></button>
        </div>
      )}
    </div>
  );
}
