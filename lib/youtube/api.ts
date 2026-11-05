// YouTube clients for the channel owner's data, over plain fetch (no SDK). Access comes from a long-lived refresh
// token minted once by `gtm youtube auth` and held as server env: YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET,
// YOUTUBE_REFRESH_TOKEN. Nothing here prints or returns a credential.
import { parseCsvObjects } from "./csv";

export const SCOPES = ["https://www.googleapis.com/auth/yt-analytics.readonly", "https://www.googleapis.com/auth/youtube.readonly"];
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const ANALYTICS = "https://youtubeanalytics.googleapis.com/v2/reports";
const REPORTING = "https://youtubereporting.googleapis.com/v1";
const DATA = "https://www.googleapis.com/youtube/v3";
export const REACH_REPORT = "channel_reach_basic_a1";

export type YtEnv = Record<string, string | undefined>;

export function youtubeConfigured(env: YtEnv = process.env): boolean {
  return !!(env.YOUTUBE_CLIENT_ID && env.YOUTUBE_CLIENT_SECRET && env.YOUTUBE_REFRESH_TOKEN);
}

async function json<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // Google error bodies name the problem (quota, scope, API not enabled) and never echo a credential.
    throw new Error(`${what}: HTTP ${res.status} ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

/** Exchanges the refresh token for a short-lived access token. */
export async function accessToken(env: YtEnv = process.env): Promise<string> {
  if (!youtubeConfigured(env)) throw new Error("YouTube is not connected: YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET and YOUTUBE_REFRESH_TOKEN are required (run `gtm youtube auth`)");
  const body = new URLSearchParams({ client_id: env.YOUTUBE_CLIENT_ID!, client_secret: env.YOUTUBE_CLIENT_SECRET!, refresh_token: env.YOUTUBE_REFRESH_TOKEN!, grant_type: "refresh_token" });
  const r = await json<{ access_token?: string }>(await fetch(TOKEN_URL, { method: "POST", body }), "YouTube token refresh");
  if (!r.access_token) throw new Error("YouTube token refresh returned no access token");
  return r.access_token;
}

export type Table = { columns: string[]; rows: (string | number | null)[][] };

/** One Analytics API report as columns and rows. `ids` is always the signed-in channel. */
export async function analyticsQuery(token: string, q: { startDate: string; endDate: string; metrics: string[]; dimensions?: string[]; sort?: string; maxResults?: number; filters?: string }): Promise<Table> {
  const u = new URL(ANALYTICS);
  u.searchParams.set("ids", "channel==MINE");
  u.searchParams.set("startDate", q.startDate);
  u.searchParams.set("endDate", q.endDate);
  u.searchParams.set("metrics", q.metrics.join(","));
  if (q.dimensions?.length) u.searchParams.set("dimensions", q.dimensions.join(","));
  if (q.sort) u.searchParams.set("sort", q.sort);
  if (q.maxResults) u.searchParams.set("maxResults", String(q.maxResults));
  if (q.filters) u.searchParams.set("filters", q.filters);
  const r = await json<{ columnHeaders?: { name: string }[]; rows?: (string | number | null)[][] }>(await fetch(u, { headers: { authorization: `Bearer ${token}` } }), "YouTube Analytics query");
  return { columns: (r.columnHeaders ?? []).map((c) => c.name), rows: r.rows ?? [] };
}

/** Live subscriber total and the uploads playlist, from the Data API. */
export async function channelInfo(token: string): Promise<{ subscribers: number | null; uploads: string | null }> {
  const u = new URL(`${DATA}/channels`);
  u.searchParams.set("part", "statistics,contentDetails");
  u.searchParams.set("mine", "true");
  const r = await json<{ items?: { statistics?: { subscriberCount?: string; hiddenSubscriberCount?: boolean }; contentDetails?: { relatedPlaylists?: { uploads?: string } } }[] }>(await fetch(u, { headers: { authorization: `Bearer ${token}` } }), "YouTube channel");
  const c = r.items?.[0];
  return { subscribers: c?.statistics?.subscriberCount != null && !c.statistics.hiddenSubscriberCount ? Number(c.statistics.subscriberCount) : null, uploads: c?.contentDetails?.relatedPlaylists?.uploads ?? null };
}

/** ISO-8601 duration ("PT1M5S") to seconds. */
export function isoSeconds(d: string): number | null {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(d);
  return m ? Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0) : null;
}

/** Titles, publish times and durations for video ids, 50 per call. */
export async function videoDetails(token: string, ids: string[]): Promise<{ video_id: string; title: string; published_at: string | null; duration_s: number | null }[]> {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const u = new URL(`${DATA}/videos`);
    u.searchParams.set("part", "snippet,contentDetails");
    u.searchParams.set("id", ids.slice(i, i + 50).join(","));
    const r = await json<{ items?: { id: string; snippet?: { title?: string; publishedAt?: string }; contentDetails?: { duration?: string } }[] }>(await fetch(u, { headers: { authorization: `Bearer ${token}` } }), "YouTube videos");
    for (const v of r.items ?? []) out.push({ video_id: v.id, title: v.snippet?.title ?? "", published_at: v.snippet?.publishedAt ?? null, duration_s: v.contentDetails?.duration ? isoSeconds(v.contentDetails.duration) : null });
  }
  return out;
}

/** The uploads playlist's video ids, newest first, up to `max`. */
export async function uploadIds(token: string, playlist: string, max = 500): Promise<string[]> {
  const ids: string[] = [];
  let page: string | undefined;
  while (ids.length < max) {
    const u = new URL(`${DATA}/playlistItems`);
    u.searchParams.set("part", "contentDetails");
    u.searchParams.set("playlistId", playlist);
    u.searchParams.set("maxResults", "50");
    if (page) u.searchParams.set("pageToken", page);
    const r = await json<{ items?: { contentDetails?: { videoId?: string } }[]; nextPageToken?: string }>(await fetch(u, { headers: { authorization: `Bearer ${token}` } }), "YouTube uploads");
    for (const i of r.items ?? []) if (i.contentDetails?.videoId) ids.push(i.contentDetails.videoId);
    if (!r.nextPageToken) break;
    page = r.nextPageToken;
  }
  return ids.slice(0, max);
}

// ---- Reporting API: thumbnail impressions and click-through rate (the Analytics API does not expose them) ----

export type ReportFile = { id: string; startTime: string; endTime: string; createTime: string; downloadUrl: string };

/** The job that produces the reach report, created on first use. Reports begin to appear within about a day. */
export async function ensureReachJob(token: string): Promise<{ id: string; created: boolean }> {
  const h = { authorization: `Bearer ${token}` };
  const list = await json<{ jobs?: { id: string; reportTypeId: string }[] }>(await fetch(`${REPORTING}/jobs`, { headers: h }), "YouTube reporting jobs");
  const found = list.jobs?.find((j) => j.reportTypeId === REACH_REPORT);
  if (found) return { id: found.id, created: false };
  const made = await json<{ id: string }>(await fetch(`${REPORTING}/jobs`, { method: "POST", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify({ reportTypeId: REACH_REPORT, name: "Vibrana GTM reach" }) }), "YouTube reporting job create");
  return { id: made.id, created: true };
}

export async function listReports(token: string, jobId: string, since?: string): Promise<ReportFile[]> {
  const out: ReportFile[] = [];
  let page: string | undefined;
  do {
    const u = new URL(`${REPORTING}/jobs/${encodeURIComponent(jobId)}/reports`);
    u.searchParams.set("pageSize", "100");
    if (since) u.searchParams.set("createdAfter", since);
    if (page) u.searchParams.set("pageToken", page);
    const r = await json<{ reports?: ReportFile[]; nextPageToken?: string }>(await fetch(u, { headers: { authorization: `Bearer ${token}` } }), "YouTube reports");
    out.push(...(r.reports ?? []));
    page = r.nextPageToken;
  } while (page);
  return out;
}

export async function downloadReport(token: string, url: string): Promise<string> {
  // The download URL is Google's own; refuse any other host so a poisoned response cannot aim the token elsewhere.
  if (new URL(url).hostname !== "youtubereporting.googleapis.com") throw new Error("Unexpected YouTube report download host");
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`YouTube report download: HTTP ${res.status}`);
  return res.text();
}

export type ReachRow = { date: string; video_id: string; impressions: number; ctr: number | null };

const REACH_COLUMNS = ["date", "video_id", "video_thumbnail_impressions", "video_thumbnail_impressions_ctr"];

/**
 * Reach CSV rows. The API reports CTR as a fraction, so 0.0244 becomes 2.44 percent. Anything above 1 means the scale
 * is not what we assumed, and the file is refused rather than capped: a silent 100% would be worse than no number.
 * A missing CTR stays null. An unrecognized header throws, so a renamed column cannot turn into silent data loss.
 */
export function parseReach(csv: string): ReachRow[] {
  const rows = parseCsvObjects(csv);
  if (rows.length && !REACH_COLUMNS.every((c) => c in rows[0])) throw new Error(`YouTube reach report: unexpected columns (${Object.keys(rows[0]).join(", ")})`);
  const out: ReachRow[] = [];
  for (const r of rows) {
    const d = r["date"], imp = Number(r["video_thumbnail_impressions"]);
    if (!/^\d{8}$/.test(d ?? "") || !r["video_id"] || !Number.isFinite(imp)) continue;
    const raw = r["video_thumbnail_impressions_ctr"];
    const ctr = raw === "" || raw == null ? null : Number(raw);
    if (ctr != null && (!Number.isFinite(ctr) || ctr < 0 || ctr > 1)) throw new Error(`YouTube reach report: CTR ${raw} is not a fraction between 0 and 1; check the scale before importing`);
    out.push({ date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`, video_id: r["video_id"], impressions: Math.round(imp), ctr: ctr == null ? null : Math.round(ctr * 10000) / 100 });
  }
  return out;
}
