"use client";

import { useRef, useState } from "react";
import Form from "next/form";
import Link from "next/link";
import { ChevronDown, Search, SlidersHorizontal, X } from "lucide-react";
import { cn } from "@/lib/ui/cn";
import { filterCookie, rememberedQuery } from "@/lib/filter-memory";

const FIELD = "h-9 w-full min-w-0 rounded-md border border-[color:var(--border-default)] bg-[color:var(--surface-inset)] px-3 text-sm text-ink focus-visible:border-violet focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20";
const LABEL = "flex flex-col gap-1.5 text-xs font-medium text-ink-2";

export type FilterSelect = { name: string; label: string; value: string; options: { value: string; label: string }[] };
export type FilterChip = { key: string; label: string; href: string };

/**
 * Search plus a Filters button that opens a panel, in the pattern of the Sample Person partner screens (/content, /studio).
 * The form is a GET form, so the address bar is the whole state: a filtered view is a link you can send. Choosing a
 * filter applies it at once. The panel stays mounted while closed so the search box keeps its siblings. The selects
 * named in `remember` (all of them by default) are kept for the next bare visit to the view (lib/filter-memory.ts).
 */
export function FilterToolbar({ path, query, id, label, q, searchLabel, placeholder, selects, chips, count, summary, clear, hidden = {}, remember }: {
  path: string;
  /** The current query string, so a new filter remounts the form with fresh defaults. */
  query: string;
  /** Prefix for the search box and panel ids. */
  id: string;
  label: string; q: string; searchLabel: string; placeholder: string;
  selects: FilterSelect[]; chips: FilterChip[];
  /** Filters set in the panel (the search box is always visible); the panel starts open when any is. */
  count: number;
  summary: string;
  /** "Clear filters" target, or null when nothing is filtered. */
  clear: string | null;
  hidden?: Record<string, string>;
  /** The selects to remember for this view; defaults to every select. */
  remember?: string[];
}) {
  const [open, setOpen] = useState(count > 0);
  const form = useRef<HTMLFormElement>(null);
  const submit = () => form.current?.requestSubmit();
  const names = remember ?? selects.map((s) => s.name);
  const keep = (entries: Iterable<[string, string]>) => {
    document.cookie = `${filterCookie(path)}=${encodeURIComponent(rememberedQuery(entries, names))}; path=/; max-age=31536000; samesite=lax`;
  };
  const keepHref = (href: string) => keep(new URL(href, window.location.origin).searchParams.entries());
  return (
    <div className="space-y-3">
      <Form ref={form} action={path} replace scroll={false} aria-label={label} key={query}
        onSubmit={(e) => keep([...new FormData(e.currentTarget).entries()].map(([k, v]) => [k, String(v)] as [string, string]))}>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 basis-full sm:basis-80">
            <label htmlFor={`${id}-search`} className="sr-only">{searchLabel}</label>
            <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-3" />
            <input id={`${id}-search`} type="search" name="q" defaultValue={q} placeholder={placeholder} className={cn(FIELD, "pl-9")} />
          </div>
          <button type="button" aria-expanded={open} aria-controls={`${id}-filters`} onClick={() => setOpen(!open)}
            className="group inline-flex h-9 items-center gap-2 rounded-md border border-[color:var(--border-default)] px-3 text-sm font-medium text-ink-2 hover:bg-[color:var(--surface-card-hover)] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30">
            <SlidersHorizontal aria-hidden className="size-4" />
            Filters
            {count > 0 && <span className="rounded bg-violet/10 px-1.5 text-xs text-violet-strong">{count}</span>}
            <ChevronDown aria-hidden className={cn("size-3.5 transition-transform", open && "rotate-180")} />
          </button>
          <span className="ml-auto text-xs text-ink-3" aria-live="polite">{summary}</span>
        </div>
        <div id={`${id}-filters`} className={cn(open ? "grid" : "hidden", "mt-3 grid-cols-1 gap-3 rounded-lg border border-line bg-[color:var(--surface-frost)] p-4 sm:grid-cols-2 xl:grid-cols-4")}>
          {selects.map((s) => (
            <label key={s.name} className={LABEL}>{s.label}
              <select name={s.name} defaultValue={s.value} onChange={submit} className={FIELD}>
                {s.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
          ))}
          {Object.entries(hidden).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
        </div>
      </Form>
      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-2" aria-label="Applied filters">
          {chips.map((chip) => (
            <Link key={chip.key} href={chip.href} replace scroll={false} aria-label={`Remove ${chip.label}`} onClick={() => keepHref(chip.href)}
              className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-line bg-[color:var(--surface-frost)] px-2 py-1 text-xs text-ink-2 hover:bg-[color:var(--surface-card-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30">
              <span className="min-w-0 break-words">{chip.label}</span><X aria-hidden className="size-3 shrink-0" />
            </Link>
          ))}
          {clear && <Link href={clear} replace scroll={false} onClick={() => keep([])} className="text-xs font-medium text-ink-2 underline underline-offset-4 hover:text-ink">Clear filters</Link>}
        </div>
      )}
    </div>
  );
}
