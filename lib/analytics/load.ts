// Reads for /performance (VIB-419). Everything goes through the signed-in session client, so RLS (owner only)
// applies. Optional sources (the comment queue, the candidates table, Zernio's best-time) degrade to a
// reason the screen can show, never to an error page and never to a 0.
import type { SupabaseClient } from "@supabase/supabase-js";
import { currentSeason } from "../seasons";
import { REPORT_TZ } from "../reports/week";
import { addDays, seasonWeek } from "../week";
import { bestTime, isSkipped, orSkip } from "../zernio-analytics";
import {
  bestTimeGrid, bucketQueue, comparableBaseline, followersAt, followerWindow, leaderboard, localMidnight, ownTimeSlots, pillarFormatGrid, platformWeek,
  PLATFORMS, tzOffsetHours, weekStarts, weekTiles, type CompareMode, type FollowerRow, type ItemLite, type QueueCounts, type QueueRow, type Snap, type SortKey, type Week,
} from "./dashboard";
import { manualComplete, MANUAL_CHANNELS } from "./manual";

const WEEKS = 12;
const COHORT_WEEKS = 8;

/** True when a PostgREST error means the table (or a column) is not there yet. */
export const missingRelation = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === "42P01" || e.code === "42703" || e.code === "PGRST205" || e.code === "PGRST204" || /does not exist|could not find/i.test(e.message ?? ""));

export type ReportTeaser = { week: number; headline: string | null; toDecide: number; period_start: string };

/** The latest finished weekly report and how many of its changes still wait for John (Today's tile). */
export async function latestReport(db: SupabaseClient): Promise<ReportTeaser | null> {
  const { data } = await db.from("gtm_content_reports").select("id,week,headline,period_start").eq("kind", "weekly").eq("status", "done").not("week", "is", null).order("period_start", { ascending: false }).limit(1);
  const r = (data ?? [])[0] as { id: string; week: number; headline: string | null; period_start: string } | undefined;
  if (!r) return null;
  const { count } = await db.from("gtm_report_actions").select("id", { count: "exact", head: true }).eq("report_id", r.id).eq("status", "proposed");
  return { week: r.week, headline: r.headline, toDecide: count ?? 0, period_start: r.period_start };
}

/** Sunday candidates waiting for John, or null when the table is absent or empty (the tile then stays hidden). */
export async function waitingCandidates(db: SupabaseClient): Promise<number | null> {
  const { count, error } = await db.from("gtm_content_candidates").select("id", { count: "exact", head: true }).eq("status", "candidate");
  if (error || !count) return null;
  return count;
}

export async function loadPerformance(db: SupabaseClient, opts: { week: Week; compare: CompareMode; platform: string | null; sort: SortKey; now: Date }) {
  const tz = REPORT_TZ();
  const { week, now, platform } = opts;
  const weeks = weekStarts(week.from, WEEKS);
  const first = weeks[0];
  const scope = platform ? [platform] : [...PLATFORMS];

  // Zernio's best-time answers (or times out) while the database reads run.
  const bestRead = readBestTime(platform);
  const [metrics, items, channels, seasons, reports, manual, lastSnap, lastRun, crm, lastFollowers, queueRead] = await Promise.all([
    db.from("gtm_post_metrics_latest").select("*").gte("published_at", `${addDays(first, -1)}T00:00:00Z`).lte("published_at", `${addDays(week.to, 1)}T23:59:59Z`),
    db.from("gtm_content_items").select("id,title,pillar,format,urls"),
    db.from("gtm_channel_daily").select("account_id,platform,date,followers").gte("date", addDays(first, -14)).lte("date", week.to).order("date"),
    db.from("gtm_seasons").select("id,starts_on,ends_on").order("starts_on"),
    db.from("gtm_content_reports").select("id,week,headline,period_start").eq("kind", "weekly").eq("status", "done").not("week", "is", null).lte("period_start", week.from).order("period_start", { ascending: false }).limit(1),
    db.from("gtm_manual_metrics").select("week_start,channel,metrics").gte("week_start", first).lte("week_start", week.from),
    db.from("gtm_post_metrics").select("captured_at").order("captured_at", { ascending: false }).limit(1),
    db.from("gtm_comment_runs").select("finished_at").not("finished_at", "is", null).order("finished_at", { ascending: false }).limit(1),
    db.from("gtm_crm_snapshots").select("date,metrics").gte("date", addDays(week.from, -8)).lte("date", week.to).order("date"),
    db.from("gtm_channel_daily").select("date").order("date", { ascending: false }).limit(1),
    readQueue(db, localMidnight(first, tz), localMidnight(addDays(week.from, 7), tz)),
  ]);
  const errors = [metrics, items, channels].map((r) => r.error?.message).filter(Boolean) as string[];
  // Optional sources: a failed read is said out loud, never shown as "manual due" or a missing snapshot.
  if (manual.error && !missingRelation(manual.error)) errors.push(`manual stats: ${manual.error.message}`);
  if (crm.error) errors.push(`CRM snapshots: ${crm.error.message}`);
  const snaps = ((metrics.data ?? []) as Snap[]).filter((s) => PLATFORMS.includes(s.platform));
  const allItems = (items.data ?? []) as ItemLite[];
  const followers = (channels.data ?? []) as FollowerRow[];

  // Conversations per week from one grouped read of the comment queue; null (with a reason) if it cannot be read.
  const queue: (QueueCounts | null)[] = queueRead.rows ? bucketQueue(queueRead.rows, weeks, tz) : weeks.map(() => null);
  const queueGap = queueRead.error ? `Comment queue unavailable (${queueRead.error.slice(0, 80)}); counting platform comments only.` : null;

  // Proof is judged on conversations: the queue's comments per calendar item, for the pillar grid.
  const byItem = new Map<string, number>();
  for (const r of queueRead.rows ?? []) if (r.kind === "comment" && r.content_item_id) byItem.set(r.content_item_id, (byItem.get(r.content_item_id) ?? 0) + 1);

  const pSnaps = platform ? snaps.filter((s) => s.platform === platform) : snaps;
  const pFollowers = platform ? followers.filter((f) => f.platform === platform) : followers;
  const perWeek = weeks.map((w, i) => weekTiles(pSnaps, pFollowers, queue[i], w, addDays(w, 6), tz, scope));
  const series = {
    conversations: perWeek.map((t) => t.conversations?.total ?? null),
    engagements: perWeek.map((t) => t.engagements),
    netFollowers: perWeek.map((t) => t.netFollowers?.total ?? null),
    savesSends: perWeek.map((t) => t.savesSends),
  };
  const current = perWeek.at(-1)!;
  // Every series compares like with like; conversations also check that each week used the same source.
  const conv = comparableBaseline(perWeek.map((t) => ({ value: t.conversations?.total ?? null, source: t.conversations?.source ?? null })), opts.compare);
  const base = {
    conversations: conv.value,
    engagements: comparableBaseline(series.engagements.map((value) => ({ value, source: null })), opts.compare).value,
    netFollowers: comparableBaseline(series.netFollowers.map((value) => ({ value, source: null })), opts.compare).value,
    savesSends: comparableBaseline(series.savesSends.map((value) => ({ value, source: null })), opts.compare).value,
  };
  const comparable = { conversations: conv.comparable };

  // One row per platform, each in its own units.
  const rows = scope.map((p) => {
    const w = platformWeek(snaps, p, week.from, week.to, now, tz);
    return {
      ...w,
      reachSeries: weeks.map((m) => platformWeek(snaps, p, m, addDays(m, 6), now, tz).reach),
      followers: { ...followerWindow(followers, p, week.from, week.to), series: weeks.map((m) => followersAt(followers, p, addDays(m, 6))) },
    };
  });

  const manualRows = (manual.data ?? []) as { week_start: string; channel: string; metrics: Record<string, number> }[];
  const manualFor = (channel: string) => manualRows.find((r) => r.week_start === week.from && r.channel === channel) ?? null;
  const manualChannels = MANUAL_CHANNELS.filter((c) => !platform || c.slug === platform).map((c) => {
    const row = manualFor(c.slug);
    return { ...c, metrics: row?.metrics ?? null, complete: manualComplete(c.slug, row?.metrics), series: weeks.map((m) => manualRows.find((r) => r.week_start === m && r.channel === c.slug)?.metrics?.[c.required[0]] ?? null) };
  });

  // Best time: Zernio's slots when it answers, else our own settled posts.
  const zb = await bestRead;
  const slots = zb.slots ?? ownTimeSlots(pSnaps, now);
  const bestSource: "zernio" | "own" = zb.slots ? "zernio" : "own";
  const bestGap = zb.gap;
  const best = { ...bestTimeGrid(slots, tzOffsetHours(tz, now)), source: bestSource, gap: bestGap, posts: slots.reduce((a, s) => a + s.post_count, 0) };

  const cohortFrom = addDays(week.from, -7 * (COHORT_WEEKS - 1));
  const board = leaderboard(snaps, allItems, { from: cohortFrom, to: week.to, now, platform: platform ?? undefined, sort: opts.sort, tz });
  const grids = scope.map((p) => ({ platform: p, ...pillarFormatGrid(snaps, allItems, p, { from: cohortFrom, to: week.to, now, tz, conversationsByItem: byItem }) }));

  // Small multiples: per platform, 12 weeks of native reach, engagements and followers at week end.
  const multiples = scope.map((p) => ({
    platform: p,
    unit: platformWeek(snaps, p, week.from, week.to, now, tz).unit,
    weeks: weeks.map((m) => {
      const w = platformWeek(snaps, p, m, addDays(m, 6), now, tz);
      return { from: m, reach: w.reach, engagements: w.engagements, followers: followersAt(followers, p, addDays(m, 6)) };
    }),
  }));

  const season = currentSeason((seasons.data ?? []) as { id: string; starts_on: string; ends_on: string }[], week.from);
  const seasonWeekNo = season && week.from >= addDays(season.starts_on, -6) && week.from <= season.ends_on ? seasonWeek(season.starts_on, week.from) : null;

  const rep = (reports.data ?? [])[0] as { id: string; week: number; headline: string | null; period_start: string } | undefined;
  let report: ReportTeaser | null = null;
  if (rep && (rep.period_start === week.from || (week.current && rep.period_start >= addDays(week.from, -7)))) {
    const { count } = await db.from("gtm_report_actions").select("id", { count: "exact", head: true }).eq("report_id", rep.id).eq("status", "proposed");
    report = { week: rep.week, headline: rep.headline, toDecide: count ?? 0, period_start: rep.period_start };
  }

  // Later-phase signal: link clicks from this week's posts, and CRM movement (tracked, not judged).
  const clicks = rows.reduce<number | null>((a, r) => (r.clicks == null ? a : (a ?? 0) + r.clicks), null);
  const crmRows = (crm.data ?? []) as { date: string; metrics: Record<string, number> }[];
  const crmStart = crmRows.filter((r) => r.date < week.from).at(-1) ?? null;
  const crmEnd = crmRows.filter((r) => r.date <= week.to).at(-1) ?? null;
  const warmDelta = crmStart && crmEnd && crmEnd !== crmStart && crmEnd.metrics.warm != null && crmStart.metrics.warm != null ? crmEnd.metrics.warm - crmStart.metrics.warm : null;

  return {
    tz, weeks, season: season ? { id: season.id, week: seasonWeekNo } : null,
    tiles: { current, series, base, comparable, queueGap }, rows, manualChannels, best, board, grids, multiples, report,
    funnel: { clicks, warmDelta, warmEnd: crmEnd?.metrics.warm ?? null },
    sync: {
      metrics: (lastSnap.data?.[0] as { captured_at?: string } | undefined)?.captured_at ?? null,
      followers: (lastFollowers.data?.[0] as { date?: string } | undefined)?.date ?? null,
      comments: (lastRun.data?.[0] as { finished_at?: string } | undefined)?.finished_at ?? null,
    },
    errors,
  };
}

export type PerformanceData = Awaited<ReturnType<typeof loadPerformance>>;

/** Others' comments and DMs written in [from, to), paged; `rows` is null with an error when the queue cannot be read. */
async function readQueue(db: SupabaseClient, from: string, to: string): Promise<{ rows: QueueRow[] | null; error: string | null }> {
  const rows: QueueRow[] = [];
  for (let at = 0; ; at += 1000) {
    const { data, error } = await db.from("gtm_comments").select("platform,kind,commented_at,content_item_id").eq("is_own", false)
      .gte("commented_at", from).lt("commented_at", to).order("id").range(at, at + 999);
    if (error) return { rows: null, error: error.message };
    rows.push(...(data as QueueRow[]));
    if (data.length < 1000) return { rows, error: null };
  }
}

/** Zernio's best-time slots, or a reason they are absent. Never throws. */
async function readBestTime(platform: string | null): Promise<{ slots: { day_of_week: number; hour: number; avg_engagement: number; post_count: number }[] | null; gap: string | null }> {
  if (!process.env.ZERNIO_API_KEY && !process.env.LATE_API_KEY) return { slots: null, gap: "No Zernio key on this deployment." };
  try {
    const r = await orSkip(() => bestTime(platform ? { platform } : {}, { timeoutMs: 4000 }));
    if (isSkipped(r)) return { slots: null, gap: r.skipped };
    return r.slots?.length ? { slots: r.slots, gap: null } : { slots: null, gap: "Zernio has no best-time slots yet." };
  } catch (e) {
    return { slots: null, gap: `Zernio did not answer (${(e as Error).message.slice(0, 80)})` };
  }
}
