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

/** Weekly roll-up of reach: impressions summed, CTR weighted by impressions (never an average of rates). */
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

export async function upsertVideos(db: SupabaseClient, videos: VideoMeta[]) {
  const rows = videos.map((v) => ({ ...v, is_short: v.duration_s == null ? null : v.duration_s <= 180, updated_at: new Date().toISOString() }));
  for (const c of chunk(rows)) must(await db.from("gtm_yt_videos").upsert(c, { onConflict: "video_id" }), "yt videos");
}

export async function upsertVideoDays(db: SupabaseClient, days: (Partial<VideoDay> & { date: string; video_id: string; [k: string]: unknown })[], source: string) {
  for (const c of byShape(days.map((d) => ({ ...d, source, updated_at: new Date().toISOString() }))).flatMap((g) => chunk(g))) must(await db.from("gtm_yt_video_daily").upsert(c, { onConflict: "date,video_id" }), "yt video daily");
}

export async function upsertDims(db: SupabaseClient, rows: (DimDay & { watch_minutes?: number | null })[], source: string) {
  for (const c of byShape(rows.map((d) => ({ ...d, source, updated_at: new Date().toISOString() }))).flatMap((g) => chunk(g))) must(await db.from("gtm_yt_dim_daily").upsert(c, { onConflict: "date,dimension,key" }), "yt dims");
}

export async function upsertChannelDays(db: SupabaseClient, rows: { date: string; [k: string]: unknown }[], source: string) {
  for (const c of byShape(rows.map((d) => ({ ...d, source, updated_at: new Date().toISOString() }))).flatMap((g) => chunk(g))) must(await db.from("gtm_yt_channel_daily").upsert(c, { onConflict: "date" }), "yt channel daily");
}

/** Writes each finished week's impressions and CTR into the manual row, keeping any number already typed in. */
export async function rollUpManual(db: SupabaseClient, throughDate: string, sinceDate: string) {
  const days = must(await db.from("gtm_yt_channel_daily").select("date,impressions,ctr").gte("date", mondayOf(sinceDate)).lte("date", throughDate), "yt channel daily read") as { date: string; impressions: number | null; ctr: number | null }[];
  const weeks = weeklyReach(days, throughDate);
  for (const w of weeks) {
    if (w.ctr == null) continue;
    const prior = must(await db.from("gtm_manual_metrics").select("metrics,note,entered_by").eq("week_start", w.week_start).eq("channel", "youtube").maybeSingle(), "manual read") as { metrics: Record<string, number>; note: string; entered_by: string } | null;
    // A hand-typed week is kept; only API-written or empty weeks are refreshed.
    if (prior && prior.entered_by !== "youtube-api" && typeof prior.metrics?.impressions === "number") continue;
    must(await db.from("gtm_manual_metrics").upsert({ week_start: w.week_start, channel: "youtube", metrics: { ...(prior?.metrics ?? {}), impressions: w.impressions, ctr: w.ctr }, note: prior?.note ?? "", entered_by: "youtube-api", updated_at: new Date().toISOString() }, { onConflict: "week_start,channel" }), "manual write");
  }
  return weeks.length;
}

export type SyncResult = { videos: number; videoDays: number; channelDays: number; dims: number; reach: { files: number; rows: number; jobCreated: boolean }; subscribers: number | null; weeks: number; through: string };

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

  // Impressions and CTR from the Reporting API; files not seen before.
  const job = await ensureReachJob(token);
  const seen = new Set((must(await db.from("gtm_yt_report_files").select("report_id"), "yt report files") as { report_id: string }[]).map((r) => r.report_id));
  const reach: ReachRow[] = [];
  const fresh = (await listReports(token, job.id)).filter((f) => !seen.has(f.id));
  for (const f of fresh) reach.push(...parseReach(await downloadReport(token, f.downloadUrl)));
  for (const r of reach) ids.add(r.video_id);

  const known = new Set((must(await db.from("gtm_yt_videos").select("video_id"), "yt videos read") as { video_id: string }[]).map((v) => v.video_id));
  const unknown = [...ids].filter((i) => !known.has(i));
  if (unknown.length) await upsertVideos(db, await videoDetails(token, unknown));

  // A reach row can name a video with no analytics row that day, so merge by (date, video).
  const merged = new Map<string, Record<string, unknown>>(days.map((d) => [`${d.date}|${d.video_id}`, d]));
  for (const r of reach) { const k = `${r.date}|${r.video_id}`; merged.set(k, { ...(merged.get(k) ?? { date: r.date, video_id: r.video_id }), impressions: r.impressions, ctr: r.ctr }); }
  await upsertVideoDays(db, [...merged.values()] as never, "api");

  // Channel-level impressions: the sum of the per-video rows, CTR weighted by impressions.
  const perDay = new Map<string, { imp: number; clicks: number }>();
  for (const r of reach) { const a = perDay.get(r.date) ?? { imp: 0, clicks: 0 }; a.imp += r.impressions; a.clicks += r.impressions * (r.ctr / 100); perDay.set(r.date, a); }
  if (perDay.size) await upsertChannelDays(db, [...perDay].map(([date, a]) => ({ date, impressions: a.imp, ctr: a.imp ? Math.round((a.clicks / a.imp) * 10000) / 100 : null })), "api");
  for (const f of fresh) must(await db.from("gtm_yt_report_files").upsert({ report_id: f.id, report_type: "channel_reach_basic_a1", start_date: f.startTime.slice(0, 10), end_date: f.endTime.slice(0, 10), rows_ingested: 0 }, { onConflict: "report_id" }), "yt report file");

  const traffic = await analyticsQuery(token, { startDate: start, endDate: end, dimensions: ["day", "insightTrafficSourceType"], metrics: ["views", "estimatedMinutesWatched"] });
  const country = await analyticsQuery(token, { startDate: start, endDate: end, dimensions: ["day", "country"], metrics: ["views", "estimatedMinutesWatched"] });
  const dim = (t: Table, dimension: DimDay["dimension"], name: string) => t.rows.map((r) => ({ date: String(r[col(t, "day")]), dimension, key: String(r[col(t, name)]), views: num(r[col(t, "views")]) ?? 0, watch_minutes: num(r[col(t, "estimatedMinutesWatched")]) }));
  const dims = [...dim(traffic, "traffic_source", "insightTrafficSourceType"), ...dim(country, "country", "country")];
  await upsertDims(db, dims, "api");

  const weeks = await rollUpManual(db, end, addDays(start, -7));
  return { videos: unknown.length, videoDays: merged.size, channelDays: channelRows.length, dims: dims.length, reach: { files: fresh.length, rows: reach.length, jobCreated: job.created }, subscribers: info.subscribers, weeks, through: end };
}
