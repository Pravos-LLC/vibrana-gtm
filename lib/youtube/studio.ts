// YouTube Studio "Advanced mode" exports (Content, Traffic source, Geography), the fallback when the API is not
// connected. Each export zip holds `Chart data.csv` (one row per day and item) and `Table data.csv` (the period's
// totals per item). Only the daily chart rows can be dated, so only they become daily rows; the Content table
// supplies video titles, publish dates and durations. Impressions and click-through rate are period totals in the
// export, so they are NOT stored per day here: the Reporting API (lib/youtube/sync.ts) fills those.
import { parseCsvObjects } from "./csv";

export type VideoMeta = { video_id: string; title: string; published_at: string | null; duration_s: number | null };
export type VideoDay = { date: string; video_id: string; views: number };
export type DimDay = { date: string; dimension: "traffic_source" | "country"; key: string; views: number };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Oct 29, 2026" (Studio, en-US) to an ISO timestamp at noon UTC; null when it does not parse. */
export function studioDate(s: string): string | null {
  const m = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})$/.exec(s.trim());
  const mi = m ? MONTHS.indexOf(m[1]) : -1;
  if (!m || mi < 0) return null;
  return `${m[3]}-${String(mi + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}T12:00:00Z`;
}

const int = (s: string) => (/^\d+$/.test(s.trim()) ? Number(s) : null);
const VIDEO_ID = /^[A-Za-z0-9_-]{6,20}$/;

export function parseContentChart(csv: string): { videos: VideoMeta[]; days: VideoDay[] } {
  const videos = new Map<string, VideoMeta>(), days: VideoDay[] = [];
  for (const r of parseCsvObjects(csv)) {
    const id = (r["Content"] ?? "").trim();
    const date = r["Date"], views = int(r["Views"] ?? "");
    if (!VIDEO_ID.test(id) || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? "") || views == null) continue;
    videos.set(id, { video_id: id, title: r["Video title"] ?? "", published_at: studioDate(r["Video publish time"] ?? ""), duration_s: int(r["Duration"] ?? "") });
    days.push({ date, video_id: id, views });
  }
  return { videos: [...videos.values()], days };
}

/** The table export also lists videos with no views in the window, so it is the fuller source of metadata. */
export function parseContentTable(csv: string): VideoMeta[] {
  const out: VideoMeta[] = [];
  for (const r of parseCsvObjects(csv)) {
    const id = (r["Content"] ?? "").trim();
    if (!VIDEO_ID.test(id)) continue; // skips the Total row
    out.push({ video_id: id, title: r["Video title"] ?? "", published_at: studioDate(r["Video publish time"] ?? ""), duration_s: int(r["Duration"] ?? "") });
  }
  return out;
}

export function parseDimChart(csv: string, dimension: DimDay["dimension"]): DimDay[] {
  const keyCol = dimension === "traffic_source" ? "Traffic source" : "Geography";
  const out: DimDay[] = [];
  for (const r of parseCsvObjects(csv)) {
    const views = int(r["Views"] ?? ""), key = (r[keyCol] ?? "").trim();
    if (views == null || !key || !/^\d{4}-\d{2}-\d{2}$/.test(r["Date"] ?? "")) continue;
    out.push({ date: r["Date"], dimension, key, views });
  }
  return out;
}

/** Daily channel views from `Totals.csv` (Date, Views). */
export function parseTotals(csv: string): { date: string; views: number }[] {
  return parseCsvObjects(csv).flatMap((r) => { const v = int(r["Views"] ?? ""); return v != null && /^\d{4}-\d{2}-\d{2}$/.test(r["Date"] ?? "") ? [{ date: r["Date"], views: v }] : []; });
}
