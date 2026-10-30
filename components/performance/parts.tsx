// /performance building blocks (VIB-419). Server components: sparklines and heatmaps are SVG and CSS grid,
// only the line charts (trend-chart.tsx) and the manual-entry sheet run on the client.
import Link from "next/link";
import { ArrowRight, ChevronLeft, ChevronRight } from "lucide-react";
import { SocialMark } from "@/components/guide/social-mark";
import { Sparkline } from "@/components/stat-tile";
import { PILLARS } from "@/lib/guide/content";
import {
  COMPARE_LABEL, PLATFORM_LABEL, SORT_LABEL, UNIT_LABEL, weekLabel,
  type CompareMode, type PillarRow, type Ranked, type SortKey, type TimeCell,
} from "@/lib/analytics/dashboard";
import { cn } from "@/lib/ui/cn";

export const num = (n: number) => n.toLocaleString("en-US");
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const FORMAT_NAME: Record<string, string> = { text: "Text", image: "Image", carousel: "Carousel", document: "Document", video: "Video" };
const pillarName = (slug: string | null) => (slug ? PILLARS.find((p) => p.slug === slug)?.name ?? slug : null);

export type Query = { week?: string; compare?: CompareMode; platform?: string | null; sort?: SortKey };
export function href(q: Query, patch: Partial<Query>) {
  const m = { ...q, ...patch };
  const p = new URLSearchParams();
  if (m.week) p.set("week", m.week);
  if (m.compare && m.compare !== "prev") p.set("compare", m.compare);
  if (m.platform) p.set("platform", m.platform);
  if (m.sort && m.sort !== "comments") p.set("sort", m.sort);
  const s = p.toString();
  return `/performance${s ? `?${s}` : ""}`;
}

const seg = (active: boolean) => cn("rounded-md px-2.5 py-1 text-xs transition-colors", active ? "bg-[color:var(--surface-card-hover)] font-medium text-ink shadow-[inset_0_0_0_1px_var(--border-default)]" : "text-ink-2 hover:text-ink");

/** The one filter row: week stepper, comparison, platform. Everything below follows it. */
export function FilterRow({ q, from, prev, next, seasonWeek, current }: { q: Query; from: string; prev: string; next: string | null; seasonWeek: number | null; current: boolean }) {
  return (
    <nav aria-label="Week and filters" className="flex flex-wrap items-center gap-x-5 gap-y-3">
      <div className="flex items-center gap-1">
        <Link href={href(q, { week: prev })} aria-label="Previous week" className="rounded-md p-1.5 text-ink-2 hover:bg-[color:var(--surface-card-hover)] hover:text-ink" data-testid="week-prev"><ChevronLeft className="size-4" /></Link>
        <h2 className="min-w-[13.5rem] text-center text-sm" data-testid="week-label">
          <span className="font-semibold text-ink">{seasonWeek ? `Week ${seasonWeek}` : "Week of"}</span> <span className="text-ink-2">{weekLabel(from)}</span>
        </h2>
        {next ? <Link href={href(q, { week: next })} aria-label="Next week" className="rounded-md p-1.5 text-ink-2 hover:bg-[color:var(--surface-card-hover)] hover:text-ink" data-testid="week-next"><ChevronRight className="size-4" /></Link>
          : <span className="p-1.5 text-ink-3 opacity-40" aria-hidden><ChevronRight className="size-4" /></span>}
        {!current && <Link href={href(q, { week: undefined })} className="ml-1 text-xs text-blue-strong underline-offset-2 hover:underline">This week</Link>}
      </div>
      <div className="flex items-center gap-1" role="group" aria-label="Compare with">
        <span className="mr-1 text-xs text-ink-3">Compare</span>
        {(Object.keys(COMPARE_LABEL) as CompareMode[]).map((c) => (
          <Link key={c} href={href(q, { compare: c })} aria-current={(q.compare ?? "prev") === c ? "true" : undefined} className={seg((q.compare ?? "prev") === c)}>{c === "prev" ? "Last week" : "4-week median"}</Link>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Platform">
        <Link href={href(q, { platform: null, sort: q.sort === "rate" ? undefined : q.sort })} aria-current={!q.platform ? "true" : undefined} className={seg(!q.platform)}>All platforms</Link>
        {Object.entries(PLATFORM_LABEL).map(([p, label]) => (
          <Link key={p} href={href(q, { platform: p })} aria-current={q.platform === p ? "true" : undefined} className={cn(seg(q.platform === p), "inline-flex items-center gap-1.5")}>
            <SocialMark channel={p} mono className="size-3" />{label}
          </Link>
        ))}
      </div>
    </nav>
  );
}

const ago = (iso: string | null, now: Date) => {
  if (!iso) return "never";
  const h = (now.getTime() - Date.parse(iso.length === 10 ? `${iso}T12:00:00Z` : iso)) / 3600_000;
  return h < 1 ? "under an hour ago" : h < 36 ? `${Math.round(h)}h ago` : `${Math.round(h / 24)} days ago`;
};

/** When each source last synced (the /signals pattern). */
export function SyncLine({ sync, now }: { sync: { metrics: string | null; followers: string | null; comments: string | null }; now: Date }) {
  return (
    <p className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-ink-3" data-testid="sync-line">
      <span>Post metrics: {ago(sync.metrics, now)}</span>
      <span>Followers: {sync.followers ?? "never"}</span>
      <span>Comment queue: {ago(sync.comments, now)}</span>
    </p>
  );
}

/** The weekly report's headline and how many changes wait for John. */
export function ReportStrip({ report }: { report: { week: number; headline: string | null; toDecide: number } | null }) {
  if (!report) return null;
  return (
    <Link href={`/performance/report/${report.week}`} className="group flex flex-wrap items-baseline gap-x-3 gap-y-1 border-y border-line py-3 text-sm" data-testid="report-strip">
      <span className="text-xs font-medium text-ink-3">Week {report.week} report</span>
      <span className="font-medium text-ink">{report.headline ?? "Written"}</span>
      {report.toDecide > 0 && <span className="text-blue-strong">{report.toDecide} {report.toDecide === 1 ? "change" : "changes"} to decide</span>}
      <span className="ml-auto inline-flex items-center gap-1 text-ink-2 group-hover:text-ink">Read <ArrowRight className="size-3.5" aria-hidden /></span>
    </Link>
  );
}

/** Status is a symbol and a word; only "manual due" carries a color, and never alone. */
export function StatusChip({ kind, children }: { kind: "maturing" | "partial" | "manual" | "pending"; children: React.ReactNode }) {
  const mark = { maturing: "◔", partial: "◐", manual: "✎", pending: "✎" }[kind];
  return (
    <span className={cn("inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs",
      kind === "manual" ? "border-[color:var(--amber)]/40 bg-[color:var(--amber)]/10 text-amber-strong" : "border-line text-ink-2", kind === "maturing" && "italic text-ink-3")}>
      <span aria-hidden>{mark}</span>{children}
    </span>
  );
}

export type PlatformRowData = {
  platform: string; unit: string; posts: number; reach: number | null; rate: { value: number; per: string; n: number } | null;
  reachGap: "none" | "unreported" | null; maturing: number; external: number; reachSeries: (number | null)[];
  followers: { end: number | null; net: number | null };
};

/** One row per platform, in its own units. */
export function PlatformRows({ rows, q }: { rows: PlatformRowData[]; q: Query }) {
  return (
    <div className="divide-y divide-[color:var(--border-subtle)] border-y border-line" data-testid="platform-rows">
      {rows.map((r) => (
        <div key={r.platform} className="grid grid-cols-2 items-center gap-x-6 gap-y-2 py-4 md:grid-cols-[9rem_4rem_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_12rem]">
          <Link href={href(q, { platform: r.platform })} className="col-span-2 inline-flex items-center gap-2 font-medium text-ink hover:underline md:col-span-1">
            <SocialMark channel={r.platform} mono className="size-4 text-ink-2" />{PLATFORM_LABEL[r.platform]}
          </Link>
          <div>
            <div className="text-lg font-semibold leading-none text-ink">{r.posts}</div>
            <div className="mt-1 text-xs text-ink-3">{r.posts === 1 ? "post" : "posts"}</div>
          </div>
          <div className="flex items-end justify-between gap-3">
            <div className="min-w-0">
              <div className={cn("text-lg font-semibold leading-none", r.reach == null ? "text-ink-3" : "text-ink")}>{r.reach == null ? "—" : num(r.reach)}</div>
              <div className="mt-1 text-xs text-ink-3">{r.reach != null ? UNIT_LABEL[r.unit] : r.reachGap === "unreported" ? `no ${UNIT_LABEL[r.unit]} reported` : "nothing published this week"}</div>
            </div>
            <Sparkline points={r.reachSeries} label={`${PLATFORM_LABEL[r.platform]} ${UNIT_LABEL[r.unit]} per week, last ${r.reachSeries.length} weeks`} />
          </div>
          <div>
            <div className={cn("text-lg font-semibold leading-none", r.rate ? "text-ink" : "text-ink-3")}>{r.rate ? `${r.rate.value}%` : "—"}{r.rate && <span className="ml-1 text-xs font-normal text-ink-2">per {r.rate.per}</span>}</div>
            <div className="mt-1 text-xs text-ink-3">{r.rate ? `median of ${r.rate.n} ${r.rate.n === 1 ? "post" : "posts"}` : r.posts ? "no settled post yet" : "no posts"}</div>
          </div>
          <div>
            <div className={cn("text-lg font-semibold leading-none", r.followers.end == null ? "text-ink-3" : "text-ink")}>{r.followers.end == null ? "—" : num(r.followers.end)}</div>
            <div className="mt-1 text-xs text-ink-3">{r.followers.net == null ? (r.followers.end == null ? "no follower count" : "net change unknown") : `${r.followers.net > 0 ? "+" : ""}${num(r.followers.net)} followers this week`}</div>
          </div>
          <div className="col-span-2 flex flex-wrap gap-1.5 md:col-span-1 md:justify-end">
            {r.maturing > 0 && <StatusChip kind="maturing">{r.maturing} maturing</StatusChip>}
            {r.platform === "linkedin" && r.external > 0 && <StatusChip kind="partial">Partial: {r.external} sent outside Zernio</StatusChip>}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Inline bar for the sort column: solid accent, no track, width relative to the column's max. */
function InlineBar({ value, max }: { value: number; max: number }) {
  if (!(max > 0) || value <= 0) return null;
  return <span aria-hidden className="ml-auto mt-1 block h-1 rounded-full bg-viz-1" style={{ width: `${Math.max(4, (value / max) * 100)}%` }} />;
}

/** Settled posts (at least 7 days old), best first by the chosen column. */
export function Leaderboard({ rows, sort, q, cohort, rateAllowed }: { rows: Ranked[]; sort: SortKey; q: Query; cohort: number; rateAllowed: boolean }) {
  const val = (r: Ranked, k: SortKey) => (k === "comments" ? r.comments : k === "engagements" ? r.engagements : k === "saves_sends" ? r.savesSends : r.rate?.value ?? 0);
  const max = Math.max(0, ...rows.map((r) => val(r, sort)));
  const cols: SortKey[] = rateAllowed ? ["comments", "engagements", "saves_sends", "rate"] : ["comments", "engagements", "saves_sends"];
  if (!rows.length) return <p className="rounded-lg border border-dashed border-line px-4 py-6 text-sm text-ink-3">— no post in this range is 7 days old yet, so nothing is ranked. Newer posts show in the platform rows as maturing.</p>;
  const cell = (r: Ranked, k: SortKey) => k === "rate" ? (r.rate ? `${r.rate.value}%` : "—") : num(val(r, k));
  return (
    <>
      <table className="hidden w-full text-sm md:table" data-testid="leaderboard">
        <caption className="sr-only">Top {rows.length} of {cohort} settled posts by {SORT_LABEL[sort].toLowerCase()}</caption>
        <thead>
          <tr className="border-b border-line text-left text-xs text-ink-3">
            <th className="py-2 pr-4 font-medium">Post</th>
            <th className="py-2 pr-4 text-right font-medium">Reach</th>
            {cols.map((k) => (
              <th key={k} className="w-28 py-2 pl-4 text-right font-medium" aria-sort={k === sort ? "descending" : undefined}>
                <Link href={href(q, { sort: k })} className={cn("hover:text-ink", k === sort && "text-ink")}>{SORT_LABEL[k]}{k === sort ? " ↓" : ""}</Link>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.href} className="border-b border-line align-top last:border-0">
              <td className="max-w-md py-3 pr-4">
                <Link href={r.href} className="line-clamp-1 font-medium text-ink hover:underline">{r.title}</Link>
                <span className="mt-0.5 flex items-center gap-1.5 text-xs text-ink-3">
                  <SocialMark channel={r.platform} mono className="size-3" />
                  {r.published_on}{pillarName(r.pillar) ? `, ${pillarName(r.pillar)}` : ""}{r.format ? `, ${FORMAT_NAME[r.format] ?? r.format}` : ""}
                </span>
              </td>
              <td className="py-3 pr-4 text-right tabular-nums text-ink-2">{r.reach.value ? num(r.reach.value) : "—"}<span className="block text-xs text-ink-3">{r.reach.value ? UNIT_LABEL[r.reach.unit] : "not reported"}</span></td>
              {cols.map((k) => (
                <td key={k} className={cn("py-3 pl-4 text-right tabular-nums", k === sort ? "font-medium text-ink" : "text-ink-2")}>
                  {cell(r, k)}
                  {k === "rate" && r.rate && <span className="block text-xs font-normal text-ink-3">per {r.rate.per}</span>}
                  {k === sort && <InlineBar value={val(r, k)} max={max} />}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <ol className="space-y-3 md:hidden">
        {rows.map((r) => (
          <li key={r.href} className="rounded-xl border border-line p-4">
            <Link href={r.href} className="font-medium text-ink">{r.title}</Link>
            <p className="mt-1 flex items-center gap-1.5 text-xs text-ink-3"><SocialMark channel={r.platform} mono className="size-3" />{r.published_on}{pillarName(r.pillar) ? `, ${pillarName(r.pillar)}` : ""}</p>
            <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
              {(["comments", "engagements", "saves_sends"] as SortKey[]).map((k) => (
                <div key={k}><dt className="text-ink-3">{SORT_LABEL[k]}</dt><dd className="text-base font-semibold text-ink">{num(val(r, k))}</dd></div>
              ))}
            </dl>
            <p className="mt-2 text-xs text-ink-3">{r.reach.value ? `${num(r.reach.value)} ${UNIT_LABEL[r.reach.unit]}` : `— ${UNIT_LABEL[r.reach.unit]} not reported`}{r.rate ? `, ${r.rate.value}% per ${r.rate.per}` : ""}</p>
          </li>
        ))}
      </ol>
    </>
  );
}

const fmtCell = (v: number) => (v >= 10_000 ? `${(v / 1000).toFixed(1).replace(/\.0$/, "")}K` : Number.isInteger(v) ? num(v) : v.toFixed(1));

/**
 * Pillar x format medians on one platform. Each row is shaded against its own max because each pillar
 * counts a different thing; n is in every cell, and cells with fewer than 3 posts are hatched.
 */
export function PillarHeatmap({ platform, formats, rows, n }: { platform: string; formats: string[]; rows: PillarRow[]; n: number }) {
  return (
    <figure className="min-w-0" data-testid={`pillar-heatmap-${platform}`}>
      <figcaption className="mb-2 flex items-center gap-1.5 text-sm font-medium text-ink"><SocialMark channel={platform} mono className="size-3.5 text-ink-2" /><span>{PLATFORM_LABEL[platform]}<span className="font-normal text-ink-3">, {n} settled {n === 1 ? "post" : "posts"}</span></span></figcaption>
      {!formats.length ? <p className="rounded-lg border border-dashed border-line px-3 py-4 text-xs italic text-ink-3">— no settled post linked to the calendar yet</p> : (
        <div className="overflow-x-auto">
          <table className="w-full border-separate border-spacing-[2px] text-xs">
            <caption className="sr-only">Median of each pillar&apos;s own leading metric by format on {PLATFORM_LABEL[platform]}; n is the number of posts.</caption>
            <thead>
              <tr>
                <th className="sticky left-0 z-[1] bg-[color:var(--surface-base)] pr-2 text-left font-normal text-ink-3">Pillar, judged on</th>
                {formats.map((f) => <th key={f} className="min-w-20 px-1 pb-1 text-left font-normal text-ink-3">{FORMAT_NAME[f] ?? f}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                // Shade against the row's settled cells when it has any, so one thin cell cannot wash out a solid one.
                const solid = formats.map((f) => r.cells[f]).filter((c) => c && c.n && !c.thin);
                const max = Math.max(0, ...(solid.length ? solid : formats.map((f) => r.cells[f])).map((c) => c?.median ?? 0));
                return (
                  <tr key={r.slug}>
                    <th scope="row" className="sticky left-0 z-[1] bg-[color:var(--surface-base)] py-1 pr-3 text-left font-normal">
                      <span className="block font-medium text-ink">{r.name}</span><span className="block text-ink-3">{r.unit}</span>
                    </th>
                    {formats.map((f) => {
                      const c = r.cells[f];
                      if (!c || !c.n) return <td key={f} className="viz-cell-empty rounded-md px-2 py-2" title="No posts">—</td>;
                      // A thin cell never reads as strong: its shade is capped, and the hatch says "tentative".
                      const v = (max > 0 && c.median != null ? c.median / max : 0) * (c.thin ? 0.45 : 1);
                      return (
                        <td key={f} className={cn("viz-cell rounded-md px-2 py-2", c.thin && "viz-hatch")} style={{ ["--v" as string]: v.toFixed(3) }} data-strong={v > 0.55 ? "true" : undefined}
                          title={`${r.name}, ${FORMAT_NAME[f] ?? f}: median ${c.median} ${r.unit} over ${c.n} ${c.n === 1 ? "post" : "posts"}${c.thin ? " (thin: fewer than 3)" : ""}`}>
                          <span className="block text-sm font-semibold tabular-nums">{c.median == null ? "—" : fmtCell(c.median)}</span>
                          <span className="block opacity-80">n={c.n}{c.thin ? ", thin" : ""}</span>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </figure>
  );
}

/**
 * 7 x 24 best-time grid in John's local time. The grid is one keyboard stop (a scrollable region with a spoken
 * summary); hovering a cell shows its numbers, and the Table toggle below lists the slots for keyboard and
 * screen-reader users.
 */
export function BestTimeHeatmap({ cells, max, source, gap, posts, tz }: { cells: TimeCell[][]; max: number; source: "zernio" | "own"; gap: string | null; posts: number; tz: string }) {
  const filled = cells.flatMap((row, d) => row.map((c, h) => ({ d, h, ...c }))).filter((c) => c.value != null).sort((a, b) => b.value! - a.value!);
  const hourLabel = (h: number) => `${String(h).padStart(2, "0")}:00`;
  return (
    <figure className="min-w-0" data-testid="best-time">
      <p id={`best-time-summary-${tz}`} className="sr-only">{filled.length ? `Best slot: ${DAYS[filled[0].d]} ${hourLabel(filled[0].h)}, average ${filled[0].value} engagements over ${filled[0].n} posts.` : "No posting history yet."}</p>
      {!filled.length ? <p className="rounded-lg border border-dashed border-line px-3 py-4 text-xs italic text-ink-3">— no settled posts to learn from yet{gap ? ` (${gap})` : ""}</p> : (
        <>
          <div className="overflow-x-auto rounded-md pb-1" tabIndex={0} role="region" aria-label={`Best time to post, average engagements per post by weekday and hour, ${tz}`} aria-describedby={`best-time-summary-${tz}`}>
            <div className="grid min-w-[44rem] grid-cols-[2.5rem_repeat(24,minmax(0,1fr))] gap-[2px] text-[0.65rem]" aria-hidden>
              <div className="contents">
                <span className="sticky left-0 bg-[color:var(--surface-base)]" />
                {Array.from({ length: 24 }, (_, h) => <span key={h} className="text-center text-ink-3">{h % 3 === 0 ? String(h).padStart(2, "0") : ""}</span>)}
              </div>
              {cells.map((row, d) => (
                <div key={d} className="contents">
                  <span className="sticky left-0 z-[1] bg-[color:var(--surface-base)] pr-1 leading-6 text-ink-3">{DAYS[d]}</span>
                  {row.map((c, h) => c.value == null
                    ? <span key={h} className="h-6 rounded-[3px] bg-[color:var(--surface-overlay)] opacity-50" />
                    : (
                      <span key={h} className="viz-cell group relative h-6 rounded-[3px]" style={{ ["--v" as string]: (max ? c.value / max : 0).toFixed(3) }}>
                        <span className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded-md border border-line bg-[color:var(--surface-inset)] px-2 py-1 text-xs text-ink shadow-sm group-hover:block">
                          <b className="tabular-nums">{c.value}</b> <span className="text-ink-3">avg engagements, {DAYS[d]} {hourLabel(h)}, {c.n} {c.n === 1 ? "post" : "posts"}</span>
                        </span>
                      </span>
                    ))}
                </div>
              ))}
            </div>
          </div>
          <figcaption className="mt-2 text-xs text-ink-3">
            {source === "zernio" ? "Zernio's average engagements per post" : "Our settled posts, mean engagements per post"} by publish hour, in {tz} time; a deeper blue is higher. {posts} {posts === 1 ? "post" : "posts"}.{gap && source === "own" ? ` ${gap}.` : ""}
          </figcaption>
          <details className="mt-2 text-xs">
            <summary className="cursor-pointer text-ink-3 hover:text-ink">Table</summary>
            <table className="mt-2 w-full max-w-md">
              <caption className="sr-only">Every slot with posts, highest average first</caption>
              <thead><tr className="text-left text-ink-3"><th className="py-1 font-medium">Slot</th><th className="py-1 text-right font-medium">Avg engagements</th><th className="py-1 text-right font-medium">Posts</th></tr></thead>
              <tbody>{filled.map((c) => <tr key={`${c.d}-${c.h}`} className="border-t border-line"><td className="py-1">{DAYS[c.d]} {hourLabel(c.h)}</td><td className="py-1 text-right tabular-nums">{c.value}</td><td className="py-1 text-right tabular-nums">{c.n}</td></tr>)}</tbody>
            </table>
          </details>
        </>
      )}
    </figure>
  );
}
