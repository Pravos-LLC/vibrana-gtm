"use client";

import { createContext, useContext, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { PanelLeft } from "lucide-react";
import { cn } from "@/lib/ui/cn";
import { Button } from "@/components/ui/button";
import Link, { useLinkStatus } from "next/link";

const COOKIE = "sidebar_state";
const SidebarContext = createContext<{ open: boolean; mobileOpen: boolean; toggle: () => void; closeMobile: () => void } | null>(null);
// Below md the sidebar is a drawer over the page; the remembered desktop state doesn't apply there.
const isPhone = () => typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches;

export function useSidebar() {
  const value = useContext(SidebarContext);
  if (!value) throw new Error("useSidebar must be used inside SidebarProvider");
  return value;
}

export function useSidebarOptional() {
  return useContext(SidebarContext);
}

/** shadcn sidebar: expanded or icon rail on desktop (remembered in a cookie), a closed-by-default drawer on phones. */
export function SidebarProvider({ defaultOpen = true, children }: { defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  const [mobileOpen, setMobileOpen] = useState(false);
  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMobileOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobileOpen]);
  const toggle = () => {
    if (isPhone()) return setMobileOpen((v) => !v);
    setOpen((current) => {
      const next = !current;
      document.cookie = `${COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
      return next;
    });
  };
  return (
    <SidebarContext.Provider value={{ open, mobileOpen, toggle, closeMobile: () => setMobileOpen(false) }}>
      <div className="flex min-h-screen w-full" style={{ "--sidebar-w": open ? "16rem" : "3.5rem" } as CSSProperties}>
        {children}
      </div>
    </SidebarContext.Provider>
  );
}

export function Sidebar({ children }: { children: ReactNode }) {
  const { mobileOpen, closeMobile } = useSidebar();
  return (
    <>
      {mobileOpen && <div className="fixed inset-0 z-40 bg-black/30 md:hidden" onClick={closeMobile} aria-hidden />}
      <aside className={cn(
        "sticky top-0 h-screen w-[var(--sidebar-w)] shrink-0 flex-col overflow-hidden border-r border-line bg-[color:var(--surface-nav)] transition-[width] duration-200 md:flex",
        mobileOpen ? "max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-50 max-md:flex max-md:w-64 max-md:bg-[color:var(--surface-base)]" : "hidden",
      )}>
        {children}
      </aside>
    </>
  );
}

export function SidebarHeader({ children }: { children: ReactNode }) {
  return <div className="flex h-16 items-center gap-2 px-3">{children}</div>;
}

export function SidebarLabel({ children }: { children: ReactNode }) {
  const { open, mobileOpen } = useSidebar();
  if (!open && !mobileOpen) return null;
  return <span className="truncate">{children}</span>;
}

export function SidebarContent({ children }: { children: ReactNode }) {
  return <div className="flex-1 overflow-y-auto px-2 py-2">{children}</div>;
}

export function SidebarFooter({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-2 border-t border-line p-2">{children}</div>;
}

export function SidebarMenu({ children }: { children: ReactNode }) {
  return <ul className="space-y-1">{children}</ul>;
}

export type NavBadge = { text: string; tone: "default" | "warning" };

export function SidebarMenuButton({ href, active, label, children, badges = [] }: { href: string; active: boolean; label: string; children: ReactNode; badges?: NavBadge[] }) {
  const { open: desktopOpen, mobileOpen, closeMobile } = useSidebar();
  const open = desktopOpen || mobileOpen;
  return (
    <li>
      <Link
        href={href}
        prefetch={false}
        onNavigate={closeMobile}
        title={open ? undefined : [label, ...badges.map((b) => b.text)].join(": ")}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex h-9 items-center gap-3 rounded-md px-2 text-sm text-ink-2 hover:bg-[color:var(--surface-card-hover)] hover:text-ink",
          active && "bg-[color:var(--surface-frost)] font-medium text-ink",
        )}
      >
        <span className="relative flex">
          {children}
          {!open && badges.length > 0 && <span aria-hidden className={cn("absolute -right-1 -top-1 size-2 rounded-full", badges.some((b) => b.tone === "warning") ? "bg-amber-strong" : "bg-violet")} />}
        </span>
        {open && <span className="truncate">{label}</span>}
        <NavigationPending />
        {open && badges.length > 0 && (
          <span className="ml-auto flex shrink-0 gap-1" data-testid="nav-badge">
            {badges.map((b) => (
              <span key={b.text} className={cn("rounded-full px-1.5 py-0.5 text-[0.65rem] font-medium leading-none", b.tone === "warning" ? "bg-[color:var(--amber)]/15 text-amber-strong" : "bg-violet/10 text-violet-strong")}>{b.text}</span>
            ))}
          </span>
        )}
      </Link>
    </li>
  );
}

function NavigationPending() {
  const { pending } = useLinkStatus();
  return pending ? <span role="status" aria-label="Loading page" className="ml-auto size-3 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent" /> : null;
}

export function SidebarInset({ children }: { children: ReactNode }) {
  return <div className="flex min-w-0 flex-1 flex-col">{children}</div>;
}

export function SidebarTrigger() {
  const { toggle, open, mobileOpen } = useSidebar();
  // Phones get their own label: the desktop rail state says nothing about the closed drawer.
  return (
    <>
      <Button variant="outline" size="icon" onClick={toggle} aria-label={open ? "Collapse sidebar" : "Expand sidebar"} className="max-md:hidden">
        <PanelLeft />
      </Button>
      <Button variant="outline" size="icon" onClick={toggle} aria-label={mobileOpen ? "Close navigation" : "Open navigation"} aria-expanded={mobileOpen} className="md:hidden">
        <PanelLeft />
      </Button>
    </>
  );
}
