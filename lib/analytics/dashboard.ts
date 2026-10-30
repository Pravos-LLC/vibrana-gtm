// The /performance dashboard's aggregation (VIB-419). Pure functions over rows the page has already read,
// so every number on the dashboard can be unit tested. The rules are the report's (lib/reports/pack.ts):
// - absolute counts first; a rate always names its denominator and is a median, never a pooled ratio;
// - reach is never added across platforms (LinkedIn impressions, Instagram accounts reached, YouTube views);
// - a missing number is null, never 0, and the screen says why;
// - a post is ranked or compared only once it is final (7 days old); a maturing post is shown, not judged.
// Weeks run Monday to Sunday in John's timezone (REPORT_TZ, Bali), as the weekly report counts them.
import { PILLARS, type LeadingMetric, type PillarSlug } from "../guide/content";
import { leadingValue, MEASURED_PLATFORMS } from "../reports/pack";
import { localDate } from "../reports/week";
import { addDays, mondayOf } from "../week";
import { engagements, isFinal, isMaturing, median, nativeReach, ownRate, savesAndSends, type PostMetrics } from "./metrics";

export type Snap = PostMetrics & {
  zernio_post_id: string; content_item_id: string | null; is_external: boolean;
  platform_post_url: string | null; content_preview: string | null; captured_at: string;
};
export type ItemLite = { id: string; title: string; pillar: string; format: string; urls?: Record<string, string> | null };
export type FollowerRow = { account_id?: string; platform: string; date: string; followers: number | null };
export type Platform = (typeof MEASURED_PLATFORMS)[number];

export const PLATFORMS = MEASURED_PLATFORMS as readonly string[];
export const PLATFORM_LABEL: Record<string, string> = { linkedin: "LinkedIn", instagram: "Instagram", youtube: "YouTube" };
/** The native reach unit in words, as the report writes it. */
export const UNIT_LABEL: Record<string, string> = { impressions: "impressions", reach: "accounts reached", views: "views" };
/** Calendar formats in the order the heatmap shows them. */
export const FORMAT_ORDER = ["text", "image", "carousel", "document", "video"] as const;

// ---- weeks ------------------------------------------------------------------------------------------------

export type Week = { from: string; to: string; current: boolean };

/** The week holding `param` (any YYYY-MM-DD), else the current one. Weeks after the current one are clamped to it. */
export function resolveWeek(param: string | undefined, today: string): Week {
  const valid = !!param && /^\d{4}-\d{2}-\d{2}$/.test(param) && !Number.isNaN(Date.parse(`${param}T12:00:00Z`));
  const now = mondayOf(today);
  let from = mondayOf(valid ? param! : today);
  if (from > now) from = now;
  return { from, to: addDays(from, 6), current: from === now };
}

/** The Mondays of the `n` weeks ending with the week starting `from`, oldest first. */
export const weekStarts = (from: string, n: number) => Array.from({ length: n }, (_, i) => addDays(from, -7 * (n - 1 - i)));

/** "Oct 5 to 11" (or "Sep 28 to Oct 4" across a month). */
export function weekLabel(from: string): string {
  const to = addDays(from, 6);
  const f = (iso: string, month: boolean) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { ...(month ? { month: "short" } : {}), day: "numeric", timeZone: "UTC" });
  return `${f(from, true)} to ${f(to, from.slice(5, 7) !== to.slice(5, 7))}`;
}

/** Hours east of UTC for `tz` at `at` (Bali is +8 all year). */
export function tzOffsetHours(tz: string, at = new Date()): number {
  const part = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" }).formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(part);
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) + Number(m[3] ?? 0) / 60) : 0;
}

/** The instant a local date starts in `tz`, as ISO (e.g. 2026-10-05T00:00:00+08:00). */
export function localMidnight(date: string, tz: string): string {
  const h = tzOffsetHours(tz, new Date(`${date}T12:00:00Z`));
  const sign = h < 0 ? "-" : "+";
  const abs = Math.abs(h);
  return `${date}T00:00:00${sign}${String(Math.floor(abs)).padStart(2, "0")}:${String(Math.round((abs % 1) * 60)).padStart(2, "0")}`;
}

// ---- posts ------------------------------------------------------------------------------------------------

/** The local day a post went out, or null when the platform never said. */
export const postDay = (s: Pick<Snap, "published_at">, tz?: string) => (s.published_at ? localDate(s.published_at, tz) : null);
const inRange = (d: string | null, from: string, to: string) => !!d && d >= from && d <= to;

/** Joins a snapshot to its calendar item: by content_item_id, else by the post URL on the item (older snapshots). */
export function itemLookup(items: ItemLite[]) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const byUrl = new Map<string, ItemLite>();
  for (const i of items) for (const u of Object.values(i.urls ?? {})) if (typeof u === "string" && u) byUrl.set(u, i);
  return (s: Pick<Snap, "content_item_id" | "platform_post_url">): ItemLite | undefined =>
    (s.content_item_id ? byId.get(s.content_item_id) : undefined) ?? (s.platform_post_url ? byUrl.get(s.platform_post_url) : undefined);
}

export type Stage = "maturing" | "settling" | "final";
export const stageOf = (s: Pick<Snap, "platform" | "published_at">, now: Date): Stage =>
  isFinal(s.published_at, now) ? "final" : isMaturing(s.platform, s.published_at, now) ? "maturing" : "settling";

/** A post's id in cockpit URLs: the Zernio post id (one post can carry several platforms; ?platform= picks one). */
export const postHref = (s: Pick<Snap, "zernio_post_id" | "platform">) => `/performance/post/${encodeURIComponent(s.zernio_post_id)}?platform=${s.platform}`;

// ---- per platform, one week ------------------------------------------------------------------------------

export type PlatformWeek = {
  platform: string; unit: string; posts: number;
  /**
   * Sum of this platform's own reach unit over the week's posts that reported one. Null when nothing went out
   * (`reachGap: "none"`) or when no post reported reach, e.g. a LinkedIn post sent outside Zernio (`"unreported"`).
   */
  reach: number | null; reachGap: "none" | "unreported" | null; engagements: number | null; comments: number | null; savesSends: number | null; clicks: number | null;
  /** Median engagement rate over the week's non-maturing posts, with its denominator and how many posts. */
  rate: { value: number; per: string; n: number } | null;
  maturing: number; external: number;
};

export function platformWeek(snaps: Snap[], platform: string, from: string, to: string, now: Date, tz?: string): PlatformWeek {
  const own = snaps.filter((s) => s.platform === platform && inRange(postDay(s, tz), from, to));
  const unit = nativeReach({ platform } as PostMetrics).unit;
  const sum = (f: (s: Snap) => number) => (own.length ? own.reduce((a, s) => a + f(s), 0) : null);
  const settled = own.filter((s) => !isMaturing(s.platform, s.published_at, now)).map((s) => ownRate(s)).filter((r): r is NonNullable<typeof r> => !!r);
  const rate = settled.length ? { value: median(settled.map((r) => r.value))!, per: settled[0].per, n: settled.length } : null;
  // A platform reports 0 reach when it has no analytics for the post; that is unknown, not zero.
  const reported = own.filter((s) => nativeReach(s).value > 0);
  return {
    platform, unit, posts: own.length,
    reach: reported.length ? reported.reduce((a, s) => a + nativeReach(s).value, 0) : null, reachGap: !own.length ? "none" : reported.length ? null : "unreported",
    engagements: sum(engagements), comments: sum((s) => s.comments), savesSends: sum(savesAndSends), clicks: sum((s) => s.clicks),
    rate, maturing: own.filter((s) => isMaturing(s.platform, s.published_at, now)).length, external: own.filter((s) => s.is_external).length,
  };
}

// ---- followers ----------------------------------------------------------------------------------------------

const byAccount = (rows: FollowerRow[], platform: string) => {
  const m = new Map<string, FollowerRow[]>();
  for (const r of rows) if (r.platform === platform && r.followers != null) m.set(r.account_id ?? platform, [...(m.get(r.account_id ?? platform) ?? []), r]);
  for (const list of m.values()) list.sort((a, b) => a.date.localeCompare(b.date));
  return [...m.values()];
};

/** One account's window: the last count before it (else the first inside it) and the last count inside it. */
function accountWindow(own: FollowerRow[], from: string, to: string) {
  const start = own.filter((r) => r.date < from).at(-1) ?? own.find((r) => r.date >= from && r.date <= to);
  const end = own.filter((r) => r.date <= to).at(-1);
  if (!start || !end || end.date < from || start === end) return { start: start?.followers ?? null, end: end && end.date >= from ? end.followers : null, net: null };
  return { start: start.followers, end: end.followers, net: end.followers! - start.followers! };
}

/**
 * Note: gtm_channel_daily.date is the UTC date of the sync (lib/sync.ts), compared here with Bali week bounds.
 * A count synced between 16:00 and 24:00 UTC on a Sunday is dated Sunday though it is already Monday in Bali,
 * so a week's closing count can be one sync late. The daily cron runs at 06:00 UTC, so this does not happen
 * on the schedule; it can on a manual late-day `gtm sync`. Fixing it means dating rows in REPORT_TZ at sync time.
 *
 * Followers at the start and end of a window for one platform, per account and then added up (two accounts on
 * one platform are two audiences). One observation is not a change, so an account with a single count in the
 * window has no net, and the platform's net is null when no account has one.
 */
export function followerWindow(rows: FollowerRow[], platform: string, from: string, to: string): { start: number | null; end: number | null; net: number | null } {
  const w = byAccount(rows, platform).map((own) => accountWindow(own, from, to));
  const add = (k: "start" | "end" | "net") => { const v = w.map((x) => x[k]).filter((x): x is number => x != null); return v.length ? v.reduce((a, b) => a + b, 0) : null; };
  return { start: add("start"), end: add("end"), net: add("net") };
}

/** Followers on `date` for one platform: each account's last count on or before it, added up; null when none. */
export function followersAt(rows: FollowerRow[], platform: string, date: string): number | null {
  const v = byAccount(rows, platform).map((own) => own.filter((r) => r.date <= date).at(-1)?.followers).filter((x): x is number => x != null);
  return v.length ? v.reduce((a, b) => a + b, 0) : null;
}

// ---- the four awareness tiles --------------------------------------------------------------------------------

export type QueueCounts = Record<string, { comments: number; dms: number; total: number }>;
export type QueueRow = { platform: string; kind: string; commented_at: string; content_item_id?: string | null };
/** Where a week's conversations came from: the comment queue, or (when the queue cannot be read) platform comment counts. */
export type ConversationSource = "queue" | "posts";
export type WeekTiles = {
  conversations: { total: number; comments: number; dms: number; source: ConversationSource } | null;
  engagements: number | null; netFollowers: { total: number; known: string[]; unknown: string[] } | null; savesSends: number | null; posts: number;
};

/**
 * Buckets queue rows (others' comments and DMs, own rows already excluded) into the weeks starting `weeks`, by the
 * local day they were written: the same counts `conversationCounts` returns per week, from one read.
 */
export function bucketQueue(rows: QueueRow[], weeks: string[], tz?: string): QueueCounts[] {
  const index = new Map(weeks.map((w, i) => [w, i]));
  const out: QueueCounts[] = weeks.map(() => ({}));
  for (const r of rows) {
    const i = index.get(mondayOf(localDate(r.commented_at, tz)));
    if (i == null) continue;
    const c = (out[i][r.platform] ??= { comments: 0, dms: 0, total: 0 });
    if (r.kind === "dm") c.dms++; else c.comments++;
    c.total++;
  }
  return out;
}

/**
 * Conversations for a week: comments from others and DMs, by when they were written. When the comment queue
 * (gtm_comments) is readable it is the only source, so every week counts the same population. Only when it
 * cannot be read does the tile fall back to the platforms' comment counts on the week's posts (cumulative, and
 * including John's own replies), and says so; a week counted that way is never compared with a queue week.
 */
export function conversations(queue: QueueCounts | null, postComments: Record<string, number>): WeekTiles["conversations"] {
  if (queue) {
    const v = Object.values(queue);
    const comments = v.reduce((a, c) => a + c.comments, 0), dms = v.reduce((a, c) => a + c.dms, 0);
    return { total: comments + dms, comments, dms, source: "queue" };
  }
  const p = Object.values(postComments);
  if (!p.length) return null;
  const comments = p.reduce((a, b) => a + b, 0);
  return { total: comments, comments, dms: 0, source: "posts" };
}

export function weekTiles(snaps: Snap[], followers: FollowerRow[], queue: QueueCounts | null, from: string, to: string, tz?: string, platforms: readonly string[] = PLATFORMS): WeekTiles {
  const own = snaps.filter((s) => platforms.includes(s.platform) && inRange(postDay(s, tz), from, to));
  const postComments: Record<string, number> = {};
  for (const s of own) postComments[s.platform] = (postComments[s.platform] ?? 0) + s.comments;
  const scopedQueue = queue ? Object.fromEntries(Object.entries(queue).filter(([p]) => platforms.includes(p))) : null;
  const nets = platforms.map((p) => [p, followerWindow(followers, p, from, to).net] as const);
  const known = nets.filter(([, n]) => n != null);
  return {
    // Counts are the same unit on every platform (a comment, a save, a follower), so these may be added up.
    conversations: conversations(scopedQueue, postComments),
    engagements: own.length ? own.reduce((a, s) => a + engagements(s), 0) : null,
    savesSends: own.length ? own.reduce((a, s) => a + savesAndSends(s), 0) : null,
    netFollowers: known.length ? { total: known.reduce((a, [, n]) => a + n!, 0), known: known.map(([p]) => p), unknown: nets.filter(([, n]) => n == null).map(([p]) => p) } : null,
    posts: own.length,
  };
}

export type CompareMode = "prev" | "median4";
export const COMPARE_LABEL: Record<CompareMode, string> = { prev: "vs last week", median4: "vs 4-week median" };

/** The baseline the current (last) value is compared with: the week before, or the median of the 4 before. */
export function baseline(series: (number | null)[], mode: CompareMode): number | null {
  if (mode === "prev") return series.length >= 2 ? series.at(-2) ?? null : null;
  const prior = series.slice(-5, -1).filter((v): v is number => v != null);
  return prior.length ? median(prior) : null;
}

/**
 * Like `baseline`, for a series whose weeks may be counted from different sources. If any baseline week used a
 * different source than the current week, there is no like-for-like comparison: `comparable` is false and the
 * value null, and the screen says "no comparable week" instead of a signed number.
 */
export function comparableBaseline(series: { value: number | null; source: string | null }[], mode: CompareMode): { value: number | null; comparable: boolean } {
  const cur = series.at(-1)?.source ?? null;
  const window = (mode === "prev" ? series.slice(-2, -1) : series.slice(-5, -1)).filter((w) => w.value != null);
  if (window.some((w) => w.source !== cur)) return { value: null, comparable: false };
  return { value: baseline(series.map((w) => w.value), mode), comparable: true };
}

/** A count delta: whole numbers only (a median of four counts can end in .5). */
export const countDelta = (cur: number | null | undefined, base: number | null) => (cur == null || base == null ? null : Math.round(cur - base));

// ---- leaderboard -------------------------------------------------------------------------------------------------

export type SortKey = "comments" | "engagements" | "saves_sends" | "rate";
export const SORT_LABEL: Record<SortKey, string> = { comments: "Comments", engagements: "Engagements", saves_sends: "Saves + sends", rate: "Rate" };

export type Ranked = {
  href: string; platform: string; title: string; pillar: string | null; format: string | null; published_on: string;
  reach: { value: number; unit: string }; engagements: number; comments: number; savesSends: number; rate: { value: number; per: string } | null; url: string | null;
};

/**
 * Final posts (at least 7 days old) published in [from, to], best first. A rate is only comparable within
 * one platform, so sorting by rate needs `platform`; without it the sort falls back to comments.
 */
export function leaderboard(snaps: Snap[], items: ItemLite[], opts: { from: string; to: string; now: Date; platform?: string; sort: SortKey; limit?: number; tz?: string }): { sort: SortKey; rows: Ranked[]; cohort: number } {
  const itemOf = itemLookup(items);
  const sort: SortKey = opts.sort === "rate" && !opts.platform ? "comments" : opts.sort;
  const cohort = snaps.filter((s) => PLATFORMS.includes(s.platform) && (!opts.platform || s.platform === opts.platform) && inRange(postDay(s, opts.tz), opts.from, opts.to) && isFinal(s.published_at, opts.now));
  const rows = cohort.map((s): Ranked => {
    const item = itemOf(s);
    return {
      href: postHref(s), platform: s.platform, title: item?.title ?? ((s.content_preview ?? "").replace(/\s+/g, " ").trim().slice(0, 90) || "Untitled post"),
      pillar: item?.pillar ?? null, format: item?.format ?? null, published_on: postDay(s, opts.tz)!,
      reach: nativeReach(s), engagements: engagements(s), comments: s.comments, savesSends: savesAndSends(s), rate: ownRate(s), url: s.platform_post_url,
    };
  });
  const key = (r: Ranked) => (sort === "comments" ? r.comments : sort === "engagements" ? r.engagements : sort === "saves_sends" ? r.savesSends : r.rate?.value ?? -1);
  rows.sort((a, b) => key(b) - key(a) || b.engagements - a.engagements || b.published_on.localeCompare(a.published_on));
  return { sort, rows: rows.slice(0, opts.limit ?? 10), cohort: cohort.length };
}

// ---- pillar x format medians ---------------------------------------------------------------------------------

export type GridCell = { median: number | null; n: number; thin: boolean };
export type PillarRow = { slug: PillarSlug; name: string; metric: LeadingMetric; unit: string; cells: Record<string, GridCell> };

/** What a pillar's leading metric counts on one platform, in words. */
export function metricUnit(key: LeadingMetric["key"], platform: string): string {
  if (key === "reach") return UNIT_LABEL[nativeReach({ platform } as PostMetrics).unit];
  if (key === "saves_sends") return "saves + sends";
  if (key === "conversations") return "conversations";
  return "comments";
}

/**
 * Medians of each pillar's own leading metric, per calendar format, over final posts on one platform. One
 * platform at a time because a reach-judged pillar (Perspective) counts in that platform's unit. Cells with
 * fewer than 3 posts are marked thin. `conversationsByItem` adds the comment queue to Proof's count.
 */
export function pillarFormatGrid(snaps: Snap[], items: ItemLite[], platform: string, opts: { from: string; to: string; now: Date; tz?: string; conversationsByItem?: Map<string, number> }): { formats: string[]; rows: PillarRow[]; n: number } {
  const itemOf = itemLookup(items);
  const posts = snaps
    .filter((s) => s.platform === platform && inRange(postDay(s, opts.tz), opts.from, opts.to) && isFinal(s.published_at, opts.now))
    .map((s) => ({ s, item: itemOf(s) }))
    .filter((x): x is { s: Snap; item: ItemLite } => !!x.item);
  // The calendar's five formats in their order, then any other format a post carries, so every post in `n` has a column.
  const seen = new Set(posts.map((p) => p.item.format).filter(Boolean));
  const formats = [...FORMAT_ORDER.filter((f) => seen.has(f)), ...[...seen].filter((f) => !(FORMAT_ORDER as readonly string[]).includes(f)).sort()];
  const rows = PILLARS.map((p): PillarRow => {
    const cells: Record<string, GridCell> = {};
    for (const f of formats) {
      const vals = posts.filter((x) => x.item.pillar === p.slug && x.item.format === f).map(({ s, item }) =>
        leadingValue(p.leading_metric.key, { metrics: { comments: s.comments } as never, native_reach: nativeReach(s), saves_sends: savesAndSends(s), conversations: opts.conversationsByItem?.get(item.id) }));
      cells[f] = { median: median(vals), n: vals.length, thin: vals.length < 3 };
    }
    return { slug: p.slug, name: p.name, metric: p.leading_metric, unit: metricUnit(p.leading_metric.key, platform), cells };
  });
  return { formats, rows, n: posts.length };
}

// ---- best time ------------------------------------------------------------------------------------------------

/** Zernio's best-time slot: weekday 0 = Monday, hour in UTC. */
export type TimeSlot = { day_of_week: number; hour: number; avg_engagement: number; post_count: number };
export type TimeCell = { value: number | null; n: number };

/** Our own posts as best-time slots (mean engagements per post, by UTC weekday and hour), for when Zernio cannot answer. */
export function ownTimeSlots(snaps: Snap[], now: Date): TimeSlot[] {
  const g = new Map<string, { sum: number; n: number; d: number; h: number }>();
  for (const s of snaps) {
    if (!s.published_at || !PLATFORMS.includes(s.platform) || !isFinal(s.published_at, now)) continue;
    const t = new Date(s.published_at);
    const d = (t.getUTCDay() + 6) % 7, h = t.getUTCHours();
    const c = g.get(`${d}|${h}`) ?? { sum: 0, n: 0, d, h };
    c.sum += engagements(s); c.n++;
    g.set(`${d}|${h}`, c);
  }
  return [...g.values()].map((c) => ({ day_of_week: c.d, hour: c.h, avg_engagement: Math.round((c.sum / c.n) * 10) / 10, post_count: c.n }));
}

/** A 7 x 24 grid (Monday first) in local time, shifted from UTC by `offsetHours`. Empty slots are null, not 0. */
export function bestTimeGrid(slots: TimeSlot[], offsetHours: number): { cells: TimeCell[][]; max: number } {
  const cells: TimeCell[][] = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ value: null, n: 0 })));
  const whole = Math.round(offsetHours);
  for (const s of slots) {
    if (!(s.post_count > 0)) continue;
    const t = s.day_of_week * 24 + s.hour + whole;
    const k = ((t % 168) + 168) % 168;
    cells[Math.floor(k / 24)][k % 24] = { value: s.avg_engagement, n: s.post_count };
  }
  const max = Math.max(0, ...cells.flat().map((c) => c.value ?? 0));
  return { cells, max };
}

// ---- growth curves ---------------------------------------------------------------------------------------------

export type CurvePoint = { day: number; value: number };

/** Cumulative values by whole day since publishing, the last snapshot of each day winning. */
export function growthCurve(points: { at: string; value: number }[], publishedAt: string, maxDay = 30): CurvePoint[] {
  const t0 = Date.parse(publishedAt);
  const byDay = new Map<number, { at: number; value: number }>();
  for (const p of points) {
    const at = Date.parse(p.at);
    const day = Math.floor((at - t0) / 86400_000);
    if (day < 0 || day > maxDay) continue;
    const prev = byDay.get(day);
    if (!prev || at >= prev.at) byDay.set(day, { at, value: p.value });
  }
  return [...byDay].sort((a, b) => a[0] - b[0]).map(([day, v]) => ({ day, value: v.value }));
}

export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * The middle half (25th to 75th percentile) and median across curves. One fixed set of curves draws the
 * whole band: the longest span at least `minN` curves all reach, so the band never jumps where an older
 * post's history runs out. Days a curve skipped are left out of that day's quantiles.
 */
export function curveBand(curves: CurvePoint[][], minN = 3): { day: number; p25: number; p50: number; p75: number; n: number }[] {
  const ends = curves.filter((c) => c.length).map((c) => c.at(-1)!.day).sort((a, b) => b - a);
  if (ends.length < minN) return [];
  const end = ends[minN - 1];
  const set = curves.filter((c) => c.length && c.at(-1)!.day >= end);
  const r = (x: number) => Math.round(x * 10) / 10;
  const out: { day: number; p25: number; p50: number; p75: number; n: number }[] = [];
  for (let day = 0; day <= end; day++) {
    const v = set.map((c) => c.find((p) => p.day === day)?.value).filter((x): x is number => x != null).sort((a, b) => a - b);
    if (v.length < minN) continue;
    out.push({ day, p25: r(quantile(v, 0.25)), p50: r(quantile(v, 0.5)), p75: r(quantile(v, 0.75)), n: v.length });
  }
  return out;
}

/** The YouTube video id in a watch, shorts, embed or youtu.be URL. */
export function youtubeId(url: string | null): string | null {
  if (!url) return null;
  const m = /(?:youtu\.be\/|[?&]v=|\/shorts\/|\/embed\/)([\w-]{6,})/.exec(url);
  return m ? m[1] : null;
}

// ---- formatting ---------------------------------------------------------------------------------------------

/** 1,284 / 12.9K / 4.2M for tile values; full numbers below 10,000. */
export function compact(n: number): string {
  const a = Math.abs(n);
  if (a < 10_000) return n.toLocaleString("en-US");
  if (a < 1_000_000) return `${(n / 1000).toFixed(a < 100_000 ? 1 : 0).replace(/\.0$/, "")}K`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** "+12" / "-3" / "0". */
export const signed = (n: number) => (n > 0 ? `+${n.toLocaleString("en-US")}` : n.toLocaleString("en-US"));
