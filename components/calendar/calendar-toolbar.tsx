"use client";

import { useEffect, useRef, useState } from "react";
import Form from "next/form";
import Link from "next/link";
import { CalendarDays, CalendarRange, List, Search } from "lucide-react";
import { channelLabel } from "@/components/content/post-card";
import { CHANNELS, hasPostFilters, type PostFilters } from "@/lib/posts";
import { cn } from "@/lib/ui/cn";
import { CALENDAR_VIEW_COOKIE } from "@/lib/filter-memory";

const FIELD = "h-9 min-w-0 rounded-md border border-[color:var(--border-default)] bg-[color:var(--surface-inset)] px-3 text-sm text-ink focus-visible:border-violet focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20";
const SEG = "inline-flex h-9 items-center gap-1.5 px-3 text-sm font-medium";

/**
 * View toggle (week or list), search and filters. A GET form, so the address bar is the whole state and a
 * filtered view is a link you can send. Choosing a filter applies it at once.
 */
export function CalendarToolbar({ view, week, filters, statuses, pillars, summary, nav }: {
  view: "month" | "week" | "list"; week: string | null; filters: PostFilters; statuses: readonly string[]; pillars: readonly string[];
  /** `week` is the view's cursor from the URL: a Monday for the week view, a YYYY-MM month for the month view. */
  summary: string; nav?: { param: "week" | "month"; labels: [string, string, string]; today: string; previous: string; next: string };
}) {
  const form = useRef<HTMLFormElement>(null);
  // Remember the view for the next visit (lib/filter-memory.ts calendarView).
  useEffect(() => { document.cookie = `${CALENDAR_VIEW_COOKIE}=${view}; path=/calendar; max-age=31536000; samesite=lax`; }, [view]);
  const submit = () => form.current?.requestSubmit();
  const query = (extra: Record<string, string>) => {
    const q = new URLSearchParams(Object.entries({ ...filters, ...extra }).filter(([, v]) => v) as [string, string][]).toString();
    return q ? `/calendar?${q}` : "/calendar";
  };
  const sel = (name: keyof PostFilters, label: string, options: readonly string[], show: (v: string) => string = (v) => v) => (
    <select name={name} defaultValue={filters[name]} onChange={submit} aria-label={label} className={FIELD}>
      <option value="">{label}</option>
      {options.map((o) => <option key={o} value={o}>{show(o)}</option>)}
    </select>
  );
  return (
    <div className="mb-5 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex overflow-hidden rounded-md border border-[color:var(--border-default)]" role="group" aria-label="View">
          <Link href={query({ view: "month", week: "", month: "" })} aria-current={view === "month" ? "page" : undefined}
            className={cn(SEG, view === "month" ? "bg-[color:var(--surface-frost)] text-ink" : "text-ink-2 hover:text-ink")}>
            <CalendarRange aria-hidden className="size-4" /> Month
          </Link>
          <Link href={query({ view: "week", month: "", week: view === "week" ? week ?? "" : "" })} aria-current={view === "week" ? "page" : undefined}
            className={cn(SEG, "border-l border-[color:var(--border-default)]", view === "week" ? "bg-[color:var(--surface-frost)] text-ink" : "text-ink-2 hover:text-ink")}>
            <CalendarDays aria-hidden className="size-4" /> Week
          </Link>
          <Link href={query({ view: "list", week: "", month: "" })} aria-current={view === "list" ? "page" : undefined}
            className={cn(SEG, "border-l border-[color:var(--border-default)]", view === "list" ? "bg-[color:var(--surface-frost)] text-ink" : "text-ink-2 hover:text-ink")}>
            <List aria-hidden className="size-4" /> List
          </Link>
        </div>
        <Form ref={form} action="/calendar" replace scroll={false} aria-label="Search and filter the calendar" key={JSON.stringify(filters)}
          className="flex flex-1 flex-wrap items-center gap-2">
          <input type="hidden" name="view" value={view} />
          {view !== "list" && week && <input type="hidden" name={view === "month" ? "month" : "week"} value={week} />}
          <div className="relative min-w-48 flex-1 sm:max-w-72">
            <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-3" />
            <input type="search" name="q" defaultValue={filters.q} placeholder="Search titles and captions" aria-label="Search titles and captions" className={cn(FIELD, "w-full pl-9")} />
          </div>
          {sel("channel", "Any channel", CHANNELS, channelLabel)}
          {sel("status", "Any status", statuses)}
          {sel("pillar", "Any pillar", pillars)}
          {hasPostFilters(filters) && <Link href={query({ q: "", channel: "", status: "", pillar: "", view, [view === "month" ? "month" : "week"]: week ?? "" })}
            replace scroll={false} className="text-xs font-medium text-ink-2 underline underline-offset-4 hover:text-ink">Clear</Link>}
        </Form>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-ink-2">{summary}</p>
        {nav && (
          <div className="flex gap-2">
            {([[nav.labels[0], nav.today, 0], [nav.labels[1], nav.previous, -7], [nav.labels[2], nav.next, 7]] as const).map(([label, w, days]) => (
              <NavLink key={label} href={query({ view, [nav.param]: w })} label={label} shift={nav.param === "week" ? days : 0} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * A week-navigation button. In the week view, Previous week and Next week also take a dropped post: it moves seven days
 * back or forward (the whole piece, like any drag). The board listens for the `calendar:shift` event and does the move.
 */
function NavLink({ href, label, shift }: { href: string; label: string; shift: number }) {
  const [over, setOver] = useState(false);
  const drop = shift !== 0;
  return (
    <Link href={href}
      onDragOver={drop ? (e) => { if (e.dataTransfer.types.includes("text/x-post")) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setOver(true); } } : undefined}
      onDragLeave={drop ? () => setOver(false) : undefined}
      onDrop={drop ? (e) => {
        e.preventDefault(); setOver(false);
        const id = e.dataTransfer.getData("text/x-post");
        if (id) window.dispatchEvent(new CustomEvent(SHIFT_EVENT, { detail: { id, days: shift } }));
      } : undefined}
      title={drop ? `Drop a post here to move it ${shift > 0 ? "a week later" : "a week earlier"}` : undefined}
      className={cn("inline-flex h-8 items-center rounded-md border border-[color:var(--border-default)] px-3 text-sm text-ink-2 hover:bg-[color:var(--surface-card-hover)] hover:text-ink", over && "ring-2 ring-violet")}>{label}</Link>
  );
}

/** Fired by a drop on Previous week / Next week: `{ id, days }`. */
export const SHIFT_EVENT = "calendar:shift";
