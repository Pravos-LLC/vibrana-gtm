import { Suspense, cache } from "react";
import Link from "next/link";
import { cookies } from "next/headers";
import { BookOpen, CalendarDays, DoorOpen, Film, Home, Lightbulb, ListChecks, LogOut, Mail, MessagesSquare, PenLine, PieChart, Radar, Receipt, Sparkles, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader, SidebarInset, SidebarLabel, SidebarMenu, SidebarMenuButton, SidebarProvider, SidebarTrigger, type NavBadge } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/toaster";
import { sessionDb } from "@/lib/supabase/server";
import { workCounts } from "@/lib/work/store";
import { Table as UiTable, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Eyebrow, VibranaLogo } from "@/components/brand";
import { ThemeToggle } from "@/components/theme-toggle";

// Grouped by job: what needs John today, the content workflow, the people side, then reference and admin.
// Retired screens redirect (next.config.ts): /review and /stories to /content, /season to /content.
const NAV = [
  { group: null, items: [{ href: "/", label: "Today", icon: Home }] },
  { group: "Content", items: [
    { href: "/ideas", label: "Ideas", icon: Lightbulb },
    { href: "/signals", label: "Signals", icon: Radar },
    { href: "/content", label: "Review", icon: Film },
    { href: "/work", label: "Work", icon: ListChecks },
    { href: "/engage", label: "Engage", icon: MessagesSquare },
    { href: "/calendar", label: "Calendar", icon: CalendarDays },
    { href: "/performance", label: "Performance", icon: PieChart },
  ] },
  { group: "Outreach", items: [
    { href: "/outreach/write", label: "Writing desk", icon: PenLine },
    { href: "/outreach/inbox", label: "Inbox", icon: Mail },
    { href: "/outreach", label: "Outreach", icon: Mail },
    { href: "/funnel", label: "CRM", icon: Users },
    { href: "/front-doors", label: "Front doors", icon: DoorOpen },
  ] },
  { group: "Reference", items: [
    { href: "/guide", label: "Content Guide", icon: BookOpen },
    { href: "/inspiration", label: "Inspiration", icon: Sparkles },
  ] },
  { group: "Admin", items: [{ href: "/costs", label: "Costs", icon: Receipt }] },
];

export async function Shell({ title, active, children, updated, wide, team }: { title: string; active: string; children: React.ReactNode; updated?: string | null; wide?: boolean; team?: boolean }) {
  // A gtm_team member only has the Signal Desk.
  const nav = team ? [{ group: "Content", items: NAV.flatMap((g) => g.items).filter((i) => i.href === "/signals") }] : NAV;
  const jar = await cookies();
  const open = jar.get("sidebar_state")?.value !== "false";
  return (
    <SidebarProvider defaultOpen={open}>
      <Sidebar>
        <SidebarHeader>
          <Link href="/" prefetch={false} className="flex items-center gap-2 overflow-hidden">
            <VibranaLogo size={28} wordmark={false} />
            <SidebarLabel>
              <span className="font-display text-base font-semibold tracking-tight text-ink">Vibrana GTM</span>
            </SidebarLabel>
          </Link>
        </SidebarHeader>
        <SidebarContent>
          {nav.map(({ group, items }) => (
            <div key={group ?? "home"} className="mb-3">
              {group && (
                <div className="px-2 pb-1 pt-2 text-[0.7rem] font-medium uppercase tracking-wide text-ink-3">
                  <SidebarLabel>{group}</SidebarLabel>
                </div>
              )}
              <SidebarMenu>
                {items.map((item) => (
                  item.href === "/work" && !team
                    ? <Suspense key={item.href} fallback={<SidebarMenuButton href={item.href} label={item.label} active={item.href === active}><item.icon className="size-4 shrink-0" /></SidebarMenuButton>}><WorkNavigation active={active === "/work"} /></Suspense>
                    : <SidebarMenuButton key={item.href} href={item.href} label={item.label} active={item.href === active}><item.icon className="size-4 shrink-0" /></SidebarMenuButton>
                ))}
              </SidebarMenu>
            </div>
          ))}
        </SidebarContent>
        <SidebarFooter>
          <ThemeToggle />
          <form action="/auth/signout" method="post">
            <Button variant="ghost" size="sm" type="submit" className="w-full justify-start" title="Sign out">
              <LogOut />
              <SidebarLabel>Sign out</SidebarLabel>
            </Button>
          </form>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset>
        <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-line bg-[color:var(--surface-nav)] px-4 backdrop-blur-md">
          <SidebarTrigger />
          <h1 className="min-w-0 truncate font-display text-pl-lg font-semibold tracking-tight text-ink">{title}</h1>
          {updated && <Eyebrow className="hidden sm:block">Updated {new Date(updated).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}</Eyebrow>}
        </header>
        <main className={wide ? "px-4 py-6" : "mx-auto w-full max-w-6xl px-6 py-10"}>{children}</main>
        <Toaster />
      </SidebarInset>
    </SidebarProvider>
  );
}

// Request-local only: a second consumer on /content shares these reads, never another owner's session.
export const requestWorkCounts = cache(async () => workCounts(await sessionDb()));

async function WorkNavigation({ active }: { active: boolean }) {
  const counts = await requestWorkCounts();
  const badges: NavBadge[] = [
    ...(counts?.inProgress ? [{ text: `${counts.inProgress} in progress`, tone: "default" as const }] : []),
    ...(counts?.waiting ? [{ text: `${counts.waiting} waiting`, tone: "warning" as const }] : []),
  ];
  return <SidebarMenuButton href="/work" label="Work" active={active} badges={badges}><ListChecks className="size-4 shrink-0" /></SidebarMenuButton>;
}

export function Section({ title, children, note }: { title: string; children: React.ReactNode; note?: string }) {
  return (
    <section className="mb-12">
      <div className="mb-4 flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
        <h2 className="font-display text-pl-lg font-semibold tracking-tight text-ink">{title}</h2>
        {note && <span className="text-xs text-ink-3">{note}</span>}
      </div>
      {children}
    </section>
  );
}

export function Table({ head, rows, align }: { head: string[]; rows: React.ReactNode[][]; align?: ("l" | "r")[] }) {
  return (
    <UiTable>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          {head.map((h, i) => (
            <TableHead key={h} className={align?.[i] === "r" ? "text-right" : undefined}>{h}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 && (
          <TableRow className="hover:bg-transparent">
            <TableCell colSpan={head.length} className="py-8 text-center text-ink-3">Nothing yet</TableCell>
          </TableRow>
        )}
        {rows.map((r, i) => (
          <TableRow key={i}>
            {r.map((c, j) => (
              <TableCell key={j} className={align?.[j] === "r" ? "text-right tabular-nums" : undefined}>{c}</TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </UiTable>
  );
}

/** Horizontal bar for funnel steps and spend breakdowns: one solid series color, the value labeled at the end. */
export function Bar({ label, value, max, display }: { label: string; value: number; max: number; display?: string }) {
  const pct = max > 0 ? Math.max(0.6, (value / max) * 100) : 0;
  return (
    <div className="grid grid-cols-[11rem_1fr_7rem] items-center gap-4 py-1.5 text-sm">
      <span className="truncate text-ink-2">{label}</span>
      <div className="h-2 rounded-full bg-surface-overlay">
        <div className="h-2 rounded-full bg-viz-1" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-right tabular-nums text-ink">{display ?? value.toLocaleString()}</span>
    </div>
  );
}

export const fmt = (n: number | null | undefined) => (n == null ? "-" : n.toLocaleString());
export const eur = (n: number) => `€${n.toLocaleString("en-GB", { maximumFractionDigits: Math.abs(n) < 10 ? 2 : 0 })}`;
