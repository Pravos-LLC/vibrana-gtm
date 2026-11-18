// Pulls YouTube channel analytics into gtm_yt_* and rolls each finished week's impressions and click-through rate
// into gtm_manual_metrics, so the /performance YouTube row completes itself (entered_by "youtube-api").
// Idempotent: every write is an upsert on its natural key, and ingested report files are remembered.
import type { SupabaseClient } from "@supabase/supabase-js";
import { must } from "../db";
import { addDays, mondayOf } from "../week";
import { accessToken, analyticsQuery, channelInfo, downloadReport, ensureReachJob, listReports, parseReach, uploadIds, videoDetails, type ReachRow, type Table } from "./api";
import type { DimDay, VideoDay, VideoMeta } from "./studio";

/**
 * Splits rows into groups that share the same set of keys. PostgREST fills any column missing from a row with null
 * when a batch mixes shapes, so a reach-only row (impressions, no views) would erase views stored earlier. One shape
 * per upsert leaves the columns a row does not carry untouched.
 */
export function byShape<T extends Record<string, unknown>>(rows: T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const r of rows) { const k = Object.keys(r).sort().join(","); (groups.get(k) ?? groups.set(k, []).get(k)!).push(r); }
  return [...groups.values()];
}
const chunk = <T,>(xs: T[], n = 500) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const col = (t: Table, name: string) => t.columns.indexOf(name);

type ReachDay = { date: string; impressions: number | null; ctr: number | null };

/**
 * Weekly roll-up of reach: impressions summed, CTR weighted by impressions (never an average of rates). It sums
 * whatever days are present; `completeReachWeeks` is the gate that decides whether a week may be written.
 */
export function weeklyReach(rows: { date: string; impressions: number | null; ctr: number | null }[], throughDate: string): { week_start: string; impressions: number; ctr: number | null }[] {
  const by = new Map<string, { imp: number; clicks: number }>();
  for (const r of rows) {
    if (r.impressions == null || r.date > throughDate) continue;
    const w = mondayOf(r.date), a = by.get(w) ?? { imp: 0, clicks: 0 };
    a.imp += r.impressions; a.clicks += r.impressions * ((r.ctr ?? 0) / 100);
    by.set(w, a);
  }
  return [...by].filter(([w]) => addDays(w, 6) <= throughDate).map(([week_start, a]) => ({ week_start, impressions: a.imp, ctr: a.imp ? Math.round((a.clicks / a.imp) * 10000) / 100 : null }));
}

/**
 * Splits the finished weeks into those with impressions on all seven days (safe to roll up) and the rest. Reach
 * reports arrive three or four days after views, so a week summed before its last day lands would be an undercount
 * that never heals once written. A finished week with any row but fewer than seven reach days is `partial`.
 */
export function completeReachWeeks(rows: ReachDay[], throughDate: string): { weeks: ReturnType<typeof weeklyReach>; partial: string[] } {
  const reachDays = new Map<string, Set<string>>(), seen = new Set<string>();
  for (const r of rows) {
    if (r.date > throughDate) continue;
    const w = mondayOf(r.date);
    seen.add(w);
    if (r.impressions != null) (reachDays.get(w) ?? reachDays.set(w, new Set()).get(w)!).add(r.date);
  }
  const done = (w: string) => addDays(w, 6) <= throughDate;
  const complete = (w: string) => (reachDays.get(w)?.size ?? 0) >= 7;
  return {
    weeks: weeklyReach(rows, throughDate).filter((w) => complete(w.week_start)),
    partial: [...seen].filter((w) => done(w) && !complete(w)).sort(),
  };
}

export async function upsertVideos(db: SupabaseClient, videos: VideoMeta[], opts: { ignoreExisting?: boolean } = {}) {
  const rows = videos.map((v) => ({ ...v, is_short: v.duration_s == null ? null : v.duration_s <= 180, updated_at: new Date().toISOString() }));
  for (const c of chunk(rows)) must(await db.from("gtm_yt_videos").upsert(c, { onConflict: "video_id", ignoreDuplicates: !!opts.ignoreExisting }), "yt videos");
}

export async function upsertVideoDays(db: SupabaseClient, days: (Partial<VideoDay> & { date: string; video_id: string; [k: string]: unknown })[], source: string, opts: { ignoreExisting?: boolean } = {}) {
  for (const c of byShape(days.map((d) => ({ ...d, source, updated_at: new Date().toISOString() }))).flatMap((g) => chunk(g))) must(await db.from("gtm_yt_video_daily").upsert(c, { onConflict: "date,video_id", ignoreDuplicates: !!opts.ignoreExisting }), "yt video daily");
}

export async function upsertDims(db: SupabaseClient, rows: (DimDay & { watch_minutes?: number | null })[], source: string, opts: { ignoreExisting?: boolean } = {}) {
  for (const c of byShape(rows.map((d) => ({ ...d, source, updated_at: new Date().toISOString() }))).flatMap((g) => chunk(g))) must(await db.from("gtm_yt_dim_daily").upsert(c, { onConflict: "date,dimension,key", ignoreDuplicates: !!opts.ignoreExisting }), "yt dims");
}

export async function upsertChannelDays(db: SupabaseClient, rows: { date: string; [k: string]: unknown }[], source: string, opts: { ignoreExisting?: boolean } = {}) {
  for (const c of byShape(rows.map((d) => ({ ...d, source, updated_at: new Date().toISOString() }))).flatMap((g) => chunk(g))) must(await db.from("gtm_yt_channel_daily").upsert(c, { onConflict: "date", ignoreDuplicates: !!opts.ignoreExisting }), "yt channel daily");
}

/**
 * Writes each finished week's impressions and CTR into the manual row, keeping any number already typed in. A week
 * missing reach on any of its days is skipped and returned in `partialWeeks`, so whatever the row already holds
 * (a complete roll-up or a hand-typed number) stays until the full week is in.
 */
export async function rollUpManual(db: SupabaseClient, throughDate: string, sinceDate: string): Promise<{ weeks: number; partialWeeks: string[] }> {
  const days = must(await db.from("gtm_yt_channel_daily").select("date,impressions,ctr").gte("date", mondayOf(sinceDate)).lte("date", throughDate), "yt channel daily read") as ReachDay[];
  const { weeks, partial } = completeReachWeeks(days, throughDate);
  for (const w of weeks) {
    if (w.ctr == null) continue;
    const prior = must(await db.from("gtm_manual_metrics").select("metrics,note,entered_by").eq("week_start", w.week_start).eq("channel", "youtube").maybeSingle(), "manual read") as { metrics: Record<string, number>; note: string; entered_by: string } | null;
    // A hand-typed week is kept; only API-written or empty weeks are refreshed.
    if (prior && prior.entered_by !== "youtube-api" && (typeof prior.metrics?.impressions === "number" || typeof prior.metrics?.ctr === "number")) continue;
    must(await db.from("gtm_manual_metrics").upsert({ week_start: w.week_start, channel: "youtube", metrics: { ...(prior?.metrics ?? {}), impressions: w.impressions, ctr: w.ctr }, note: prior?.note ?? "", entered_by: "youtube-api", updated_at: new Date().toISOString() }, { onConflict: "week_start,channel" }), "manual write");
  }
  return { weeks: weeks.length, partialWeeks: partial };
}

/** `partialWeeks`: finished weeks (Monday dates) left out of the roll-up because some day has no reach yet. */
export type SyncResult = { videos: number; videoDays: number; channelDays: number; dims: number; reach: { files: number; rows: number; jobCreated: boolean }; subscribers: number | null; weeks: number; partialWeeks: string[]; through: string; reachErrors: string[] };

/** `today` is the UTC date; the API settles about two days late, so the window ends two days before it. */
export async function syncYouTube(db: SupabaseClient, opts: { today: string; days?: number; env?: Record<string, string | undefined> }): Promise<SyncResult> {
  const token = await accessToken(opts.env ?? process.env);
  const end = addDays(opts.today, -2), start = addDays(end, -((opts.days ?? 7) - 1));
  const base = ["views", "estimatedMinutesWatched", "averageViewDuration", "subscribersGained", "subscribersLost"];

  const info = await channelInfo(token);
  const channel = await analyticsQuery(token, { startDate: start, endDate: end, dimensions: ["day"], metrics: base, sort: "day" });
  const channelRows = channel.rows.map((r) => ({ date: String(r[col(channel, "day")]), views: num(r[col(channel, "views")]), watch_minutes: num(r[col(channel, "estimatedMinutesWatched")]), avg_view_duration_s: num(r[col(channel, "averageViewDuration")]), subs_gained: num(r[col(channel, "subscribersGained")]), subs_lost: num(r[col(channel, "subscribersLost")]) }));
  if (info.subscribers != null && channelRows.length) (channelRows[channelRows.length - 1] as Record<string, unknown>).subscribers_total = info.subscribers;
  await upsertChannelDays(db, channelRows, "api");

  // Per-video figures: the video dimension cannot be combined with day, so one call per day.
  const vmetrics = [...base, "averageViewPercentage", "likes", "comments", "shares"];
  const days: Record<string, unknown>[] = [], ids = new Set<string>();
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const t = await analyticsQuery(token, { startDate: d, endDate: d, dimensions: ["video"], metrics: vmetrics, sort: "-views", maxResults: 200 });
    for (const r of t.rows) {
      const id = String(r[col(t, "video")]); ids.add(id);
      days.push({ date: d, video_id: id, views: num(r[col(t, "views")]), watch_minutes: num(r[col(t, "estimatedMinutesWatched")]), avg_view_duration_s: num(r[col(t, "averageViewDuration")]), avg_view_pct: num(r[col(t, "averageViewPercentage")]), subs_gained: num(r[col(t, "subscribersGained")]), subs_lost: num(r[col(t, "subscribersLost")]), likes: num(r[col(t, "likes")]), comments: num(r[col(t, "comments")]), shares: num(r[col(t, "shares")]) });
    }
  }

  // Impressions and CTR from the Reporting API. Google can reissue a day's report under a new id, so only the newest
  // file per day counts and a day is never added twice.
  const job = await ensureReachJob(token);
  const seen = new Set((must(await db.from("gtm_yt_report_files").select("report_id"), "yt report files") as { report_id: string }[]).map((r) => r.report_id));
  const listed = (await listReports(token, job.id)).filter((f) => !seen.has(f.id));
  const newest = new Map<string, (typeof listed)[number]>();
  for (const f of listed) { const k = f.startTime.slice(0, 10); const cur = newest.get(k); if (!cur || f.createTime > cur.createTime) newest.set(k, f); }
  const fresh = [...newest.values()];
  const reach: ReachRow[] = [], perFile = new Map<string, number>();
  // One bad file (a CTR scale or column change) must not stop the views, titles and roll-up. It is reported, not marked
  // as read, so it is retried once the parser is fixed.
  const reachErrors: string[] = [], bad = new Set<string>();
  // Video ids each ingested file reports, by the day it covers; read below to clear reach a reissue no longer carries.
  const inFile = new Map<string, Set<string>>();
  for (const f of fresh) {
    try {
      const rows = parseReach(await downloadReport(token, f.downloadUrl)), day = f.startTime.slice(0, 10);
      perFile.set(f.id, rows.length); reach.push(...rows);
      // Only the file's own day is replaced (cleared or zeroed); a row dated otherwise is added but proves nothing there.
      inFile.set(day, new Set(rows.filter((r) => r.date === day).map((r) => r.video_id)));
    }
    catch (e) { bad.add(f.id); reachErrors.push(`${f.startTime.slice(0, 10)}: ${(e as Error).message}`); console.error(`youtube sync: reach file ${f.id}: ${(e as Error).message}`); }
  }
  for (const r of reach) ids.add(r.video_id);

  // Placeholders for deleted videos are looked up again, so a video that comes back gets its real title.
  const known = new Set((must(await db.from("gtm_yt_videos").select("video_id,title"), "yt videos read") as { video_id: string; title: string }[]).filter((v) => !v.title.startsWith("(deleted or private")).map((v) => v.video_id));
  const unknown = [...ids].filter((i) => !known.has(i));
  if (unknown.length) {
    const found = await videoDetails(token, unknown);
    // A deleted or private video has analytics rows but no Data API entry; a placeholder keeps its rows from failing the foreign key.
    const got = new Set(found.map((v) => v.video_id));
    await upsertVideos(db, [...found, ...unknown.filter((i) => !got.has(i)).map((i) => ({ video_id: i, title: "(deleted or private video)", published_at: null, duration_s: null }))]);
  }

  // A reach row can name a video with no analytics row that day, so merge by (date, video).
  const merged = new Map<string, Record<string, unknown>>(days.map((d) => [`${d.date}|${d.video_id}`, d]));
  for (const r of reach) { const k = `${r.date}|${r.video_id}`; merged.set(k, { ...(merged.get(k) ?? { date: r.date, video_id: r.video_id }), impressions: r.impressions, ctr: r.ctr }); }
  await upsertVideoDays(db, [...merged.values()] as never, "api");

  // The newest file for a day replaces the day's reach. A video an earlier file named but this one does not keeps stale
  // impressions unless cleared, so those rows get impressions and ctr set to null. A plain update on just those two
  // columns: views, the other analytics and the source of a Studio-imported row are left as they are.
  for (const [date, present] of inFile) {
    const held = must(await db.from("gtm_yt_video_daily").select("video_id,impressions,ctr").eq("date", date), "yt video daily read") as { video_id: string; impressions: number | null; ctr: number | null }[];
    const stale = held.filter((r) => (r.impressions != null || r.ctr != null) && !present.has(r.video_id)).map((r) => r.video_id);
    for (const ids of chunk(stale)) must(await db.from("gtm_yt_video_daily").update({ impressions: null, ctr: null, updated_at: new Date().toISOString() }).eq("date", date).in("video_id", ids), "yt video daily clear reach");
  }

  // Channel-level impressions: the sum of the per-video rows, CTR weighted by impressions (null when no row reported one).
  // Every ingested file sets its day, so a reissue that drops videos lowers the total and an empty file records 0.
  const perDay = new Map<string, { imp: number; clicks: number; known: number }>([...inFile.keys()].map((d) => [d, { imp: 0, clicks: 0, known: 0 }]));
  for (const r of reach) { const a = perDay.get(r.date) ?? { imp: 0, clicks: 0, known: 0 }; a.imp += r.impressions; if (r.ctr != null) { a.clicks += r.impressions * (r.ctr / 100); a.known += r.impressions; } perDay.set(r.date, a); }
  if (perDay.size) await upsertChannelDays(db, [...perDay].map(([date, a]) => ({ date, impressions: a.imp, ctr: a.known ? Math.round((a.clicks / a.known) * 10000) / 100 : null })), "api");
  for (const f of fresh.filter((x) => !bad.has(x.id))) must(await db.from("gtm_yt_report_files").upsert({ report_id: f.id, report_type: "channel_reach_basic_a1", start_date: f.startTime.slice(0, 10), end_date: f.endTime.slice(0, 10), rows_ingested: perFile.get(f.id) ?? 0 }, { onConflict: "report_id" }), "yt report file");
  // Reissued files we skipped are marked seen too, so they are not downloaded again.
  for (const f of listed.filter((x) => !fresh.includes(x))) must(await db.from("gtm_yt_report_files").upsert({ report_id: f.id, report_type: "channel_reach_basic_a1", start_date: f.startTime.slice(0, 10), end_date: f.endTime.slice(0, 10), rows_ingested: 0 }, { onConflict: "report_id" }), "yt report file");

  // The weekly roll-up is the point of the sync, so it runs before the optional breakdowns and they cannot stop it.
  const { weeks, partialWeeks } = await rollUpManual(db, end, addDays(start, -7));

  const dims: DimDay[] = [];
  try {
    const t = await analyticsQuery(token, { startDate: start, endDate: end, dimensions: ["day", "insightTrafficSourceType"], metrics: ["views", "estimatedMinutesWatched"] });
    for (const r of t.rows) dims.push({ date: String(r[col(t, "day")]), dimension: "traffic_source", key: String(r[col(t, "insightTrafficSourceType")]), views: num(r[col(t, "views")]) ?? 0, watch_minutes: num(r[col(t, "estimatedMinutesWatched")]) } as DimDay);
  } catch (e) { console.error(`youtube sync: traffic sources: ${(e as Error).message}`); }
  // Country cannot be combined with day (it is a daily-report filter), so one call per day.
  try {
    for (let d = start; d <= end; d = addDays(d, 1)) {
      const c = await analyticsQuery(token, { startDate: d, endDate: d, dimensions: ["country"], metrics: ["views", "estimatedMinutesWatched"], sort: "-views", maxResults: 250 });
      for (const r of c.rows) dims.push({ date: d, dimension: "country", key: String(r[col(c, "country")]), views: num(r[col(c, "views")]) ?? 0, watch_minutes: num(r[col(c, "estimatedMinutesWatched")]) } as DimDay);
    }
  } catch (e) { console.error(`youtube sync: country: ${(e as Error).message}`); }
  await upsertDims(db, dims, "api");

  return { videos: unknown.length, videoDays: merged.size, channelDays: channelRows.length, dims: dims.length, reach: { files: fresh.length, rows: reach.length, jobCreated: job.created }, subscribers: info.subscribers, weeks, partialWeeks, through: end, reachErrors };
}
