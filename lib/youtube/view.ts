// The /performance YouTube section: the last 28 days of gtm_yt_* by video and traffic source. Pure aggregation over
// rows already read, so it is tested without a database. A missing number stays null (never 0) and every rate is
// shown with its denominator.
import type { SupabaseClient } from "@supabase/supabase-js";
import { addDays } from "../week";

export type DayRow = { date: string; video_id: string; views: number | null; watch_minutes: number | null; avg_view_pct: number | null; subs_gained: number | null; impressions: number | null; ctr: number | null };
export type VideoRow = { video_id: string; title: string; published_at: string | null; duration_s: number | null; is_short: boolean | null };
export type DimRow = { date: string; dimension: string; key: string; views: number | null; watch_minutes: number | null };

export type YtVideo = { video_id: string; title: string; short: boolean | null; published: string | null; views: number; watchHours: number | null; impressions: number | null; ctr: number | null; avgPctViewed: number | null; subs: number | null; viewsDay1Share: number | null };
export type YtView = { from: string; to: string; views: number; watchHours: number | null; impressions: number | null; ctr: number | null; subs: number | null; videos: YtVideo[]; traffic: { key: string; views: number; share: number }[]; sources: string[] };

const sum = (xs: (number | null)[]): number | null => { const v = xs.filter((x): x is number => x != null); return v.length ? v.reduce((a, b) => a + b, 0) : null; };
const r1 = (n: number) => Math.round(n * 10) / 10;

export function buildYouTubeView(videos: VideoRow[], days: DayRow[], dims: DimRow[], from: string, to: string, sources: string[] = []): YtView {
  const meta = new Map(videos.map((v) => [v.video_id, v]));
  const by = new Map<string, DayRow[]>();
  for (const d of days) { if (d.date < from || d.date > to) continue; (by.get(d.video_id) ?? by.set(d.video_id, []).get(d.video_id)!).push(d); }
  const rows: YtVideo[] = [...by].map(([id, ds]) => {
    const m = meta.get(id), views = sum(ds.map((d) => d.views)) ?? 0;
    const imp = sum(ds.map((d) => d.impressions));
    // CTR over the window is weighted by impressions, never an average of daily rates.
    const clicks = imp ? sum(ds.map((d) => (d.impressions != null && d.ctr != null ? d.impressions * d.ctr / 100 : null))) : null;
    // Average % viewed, weighted by views.
    const pv = ds.filter((d) => d.avg_view_pct != null && d.views);
    const pvViews = sum(pv.map((d) => d.views));
    const day1 = m?.published_at?.slice(0, 10);
    const first = day1 ? sum(ds.filter((d) => d.date <= addDays(day1, 1)).map((d) => d.views)) : null;
    const mins = sum(ds.map((d) => d.watch_minutes));
    return { video_id: id, title: m?.title ?? id, short: m?.is_short ?? null, published: m?.published_at?.slice(0, 10) ?? null, views, watchHours: mins == null ? null : r1(mins / 60), impressions: imp, ctr: imp && clicks != null ? Math.round((clicks / imp) * 1000) / 10 : null, avgPctViewed: pvViews ? r1(pv.reduce((a, d) => a + d.avg_view_pct! * d.views!, 0) / pvViews) : null, subs: sum(ds.map((d) => d.subs_gained)), viewsDay1Share: first != null && views ? Math.round((first / views) * 100) : null };
  }).filter((v) => v.views > 0 || (v.impressions ?? 0) > 0).sort((a, b) => b.views - a.views);
  const traffic = new Map<string, number>();
  for (const d of dims) if (d.dimension === "traffic_source" && d.date >= from && d.date <= to) traffic.set(d.key, (traffic.get(d.key) ?? 0) + (d.views ?? 0));
  const tv = [...traffic.values()].reduce((a, b) => a + b, 0);
  const views = rows.reduce((a, v) => a + v.views, 0);
  const imp = sum(rows.map((v) => v.impressions));
  const clicks = sum(rows.map((v) => (v.impressions != null && v.ctr != null ? v.impressions * v.ctr / 100 : null)));
  return { from, to, views, watchHours: sum(rows.map((v) => v.watchHours)), impressions: imp, ctr: imp && clicks != null ? Math.round((clicks / imp) * 1000) / 10 : null, subs: sum(rows.map((v) => v.subs)), videos: rows, traffic: [...traffic].map(([key, v]) => ({ key, views: v, share: tv ? Math.round((v / tv) * 100) : 0 })).sort((a, b) => b.views - a.views), sources };
}

/** Reads the 28 days ending at `to` for the owner's session; null when the tables are absent or empty. */
export async function loadYouTube(db: SupabaseClient, to: string): Promise<YtView | null> {
  const from = addDays(to, -27);
  // PostgREST caps a response (1,000 rows by default), so each read pages until a short page.
  type Page = PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
  const all = async (q: (a: number, b: number) => Page) => {
    const rows: unknown[] = [];
    for (let a = 0; ; a += 1000) {
      const r = await q(a, a + 999);
      if (r.error) return { data: null, error: r.error };
      rows.push(...(r.data ?? []));
      if ((r.data ?? []).length < 1000) return { data: rows, error: null };
    }
  };
  const [v, d, x] = await Promise.all([
    all((a, b) => db.from("gtm_yt_videos").select("video_id,title,published_at,duration_s,is_short").order("video_id").range(a, b)),
    all((a, b) => db.from("gtm_yt_video_daily").select("date,video_id,views,watch_minutes,avg_view_pct,subs_gained,impressions,ctr,source").gte("date", from).lte("date", to).order("date").order("video_id").range(a, b)),
    all((a, b) => db.from("gtm_yt_dim_daily").select("date,dimension,key,views,watch_minutes").eq("dimension", "traffic_source").gte("date", from).lte("date", to).order("date").order("key").range(a, b)),
  ]);
  if (v.error || d.error || x.error || !(d.data ?? []).length) return null;
  const sources = [...new Set(((d.data ?? []) as { source: string }[]).map((r) => r.source))];
  return buildYouTubeView((v.data ?? []) as VideoRow[], (d.data ?? []) as DayRow[], (x.data ?? []) as DimRow[], from, to, sources);
}
