// The weekly reach roll-up only writes weeks whose seven days all have impressions, and a reissued daily reach report
// clears reach a newer file no longer carries. Nothing here reaches Google or a database.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { installFetchMock } from "./support/fetch-mock.ts";

const { completeReachWeeks, rollUpManual, syncYouTube } = await import("../lib/youtube/sync.ts");
const { addDays } = await import("../lib/week.ts");

let restore: (() => void) | null = null;
afterEach(() => { restore?.(); restore = null; });

type Row = Record<string, unknown>;

// An in-memory stand-in for the Supabase client: select / eq / in / gte / lte / maybeSingle / upsert / update.
function fakeDb(seed: Record<string, Row[]> = {}) {
  const t: Record<string, Row[]> = Object.fromEntries(Object.entries(seed).map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
  const keys: Record<string, string[]> = { gtm_yt_videos: ["video_id"], gtm_yt_video_daily: ["date", "video_id"], gtm_yt_channel_daily: ["date"], gtm_yt_dim_daily: ["date", "dimension", "key"], gtm_yt_report_files: ["report_id"], gtm_manual_metrics: ["week_start", "channel"] };
  const from = (name: string) => {
    const rows = (t[name] ??= []);
    const filt: ((r: Row) => boolean)[] = [];
    let patch: Row | null = null;
    const match = () => rows.filter((r) => filt.every((f) => f(r)));
    const b: Record<string, unknown> = {
      select: () => b,
      eq: (c: string, v: unknown) => (filt.push((r) => r[c] === v), b),
      in: (c: string, vs: unknown[]) => (filt.push((r) => vs.includes(r[c])), b),
      gte: (c: string, v: string) => (filt.push((r) => String(r[c]) >= v), b),
      lte: (c: string, v: string) => (filt.push((r) => String(r[c]) <= v), b),
      maybeSingle: async () => ({ data: match()[0] ?? null, error: null }),
      update: (p: Row) => ((patch = p), b),
      then: (res: (v: unknown) => unknown) => {
        if (patch) { for (const r of match()) Object.assign(r, patch); return res({ data: null, error: null }); }
        return res({ data: match(), error: null });
      },
      upsert: async (batch: Row[] | Row, o: { ignoreDuplicates?: boolean } = {}) => {
        for (const row of Array.isArray(batch) ? batch : [batch]) {
          const k = keys[name], i = rows.findIndex((r) => k.every((c) => r[c] === row[c]));
          if (i < 0) rows.push({ ...row }); else if (!o.ignoreDuplicates) rows[i] = { ...rows[i], ...row };
        }
        return { data: null, error: null };
      },
    };
    return b;
  };
  return { db: { from } as never, t };
}

/** Channel days from `first` for `n` days, each 100 impressions at 2%. */
const reachDays = (first: string, n: number) => Array.from({ length: n }, (_, i) => ({ date: addDays(first, i), impressions: 100, ctr: 2 }));

test("a week is complete only with impressions on all seven days; a finished week short of that is partial", () => {
  // Week of Mon 2026-10-05: YouTube only generated reach from Sat 2026-10-10, so two of seven days, not the whole week.
  const rows = [
    ...Array.from({ length: 5 }, (_, i) => ({ date: addDays("2026-10-05", i), impressions: null, ctr: null })), // views only
    { date: "2026-10-10", impressions: 20, ctr: 5 }, { date: "2026-10-11", impressions: 18, ctr: 0 },
    ...reachDays("2026-10-12", 7),
    ...reachDays("2026-10-19", 3), // unfinished on the through date: neither written nor reported
  ];
  const r = completeReachWeeks(rows, "2026-10-21");
  assert.deepEqual(r.weeks, [{ week_start: "2026-10-12", impressions: 700, ctr: 2 }]);
  assert.deepEqual(r.partial, ["2026-10-05"]); // not a permanent 38-impression week
  // Six days of seven is still partial, and a day with 0 impressions counts as a known day.
  const six = completeReachWeeks([...reachDays("2026-10-26", 6)], "2026-11-03");
  assert.deepEqual([six.weeks.length, six.partial], [0, ["2026-10-26"]]);
  const zero = completeReachWeeks([...reachDays("2026-10-26", 6), { date: "2026-11-01", impressions: 0, ctr: null }], "2026-11-03");
  assert.deepEqual(zero.weeks, [{ week_start: "2026-10-26", impressions: 600, ctr: 2 }]);
});

test("roll-up: a complete week is written, a partial one is skipped and reported, existing values are never replaced by a partial", async () => {
  const { db, t } = fakeDb({
    gtm_yt_channel_daily: [
      ...reachDays("2026-10-05", 2).map((d) => ({ ...d, impressions: null, ctr: null })), // week of 10-05: reach on 1 day only
      { date: "2026-10-07", impressions: 38, ctr: 2 },
      ...reachDays("2026-10-12", 7),  // complete, no row yet
      ...reachDays("2026-10-19", 7),  // complete, but John typed this week by hand
      ...reachDays("2026-10-26", 5),  // partial, already holds an earlier complete API roll-up
    ],
    gtm_manual_metrics: [
      { week_start: "2026-10-19", channel: "youtube", metrics: { impressions: 999, ctr: 3.1 }, note: "typed", entered_by: "john" },
      { week_start: "2026-10-26", channel: "youtube", metrics: { impressions: 812, ctr: 2.5, views: 40 }, note: "", entered_by: "youtube-api" },
    ],
  });
  const before = structuredClone(t.gtm_manual_metrics);
  const r = await rollUpManual(db, "2026-11-03", "2026-10-05");
  assert.deepEqual(r.partialWeeks, ["2026-10-05", "2026-10-26"]);
  assert.equal(r.weeks, 2);
  const row = (w: string) => t.gtm_manual_metrics.find((x) => x.week_start === w && x.channel === "youtube");
  assert.equal(row("2026-10-05"), undefined);                                   // no undercount written
  assert.deepEqual(row("2026-10-12")!.metrics, { impressions: 700, ctr: 2 });  // complete: written
  assert.equal(row("2026-10-12")!.entered_by, "youtube-api");
  assert.deepEqual(row("2026-10-19"), before[0]);                              // hand-typed: untouched
  assert.deepEqual(row("2026-10-26"), before[1]);                              // partial: the earlier complete value stays
});

test("sync: the result lists partial weeks without failing the run", async () => {
  const m = installFetchMock([
    { method: "POST", url: "https://oauth2.googleapis.com/token", json: { access_token: "at" } },
    { url: "https://www.googleapis.com/youtube/v3/channels", json: { items: [{}] } },
    { url: "https://youtubereporting.googleapis.com/v1/jobs/job1/reports", json: { reports: [] } },
    { url: "https://youtubereporting.googleapis.com/v1/jobs", json: { jobs: [{ id: "job1", reportTypeId: "channel_reach_basic_a1" }] } },
    { url: "https://youtubeanalytics.googleapis.com/v2/reports", json: { columnHeaders: [{ name: "day" }, { name: "views" }], rows: [] } },
  ]);
  restore = m.restore;
  const { db, t } = fakeDb({ gtm_yt_channel_daily: [...reachDays("2026-10-26", 4), ...reachDays("2026-10-19", 7)] });
  const r = await syncYouTube(db, { today: "2026-11-05", days: 7, env: { YOUTUBE_CLIENT_ID: "i", YOUTUBE_CLIENT_SECRET: "s", YOUTUBE_REFRESH_TOKEN: "r" } });
  assert.deepEqual(r.partialWeeks, ["2026-10-26"]);
  assert.equal(r.weeks, 1);
  assert.deepEqual(t.gtm_manual_metrics.map((x) => x.week_start), ["2026-10-19"]);
});

test("sync: a reissued day report clears reach for videos it no longer names, leaving their views and source alone", async () => {
  const head = "date,channel_id,video_id,video_thumbnail_impressions,video_thumbnail_impressions_ctr\n";
  const m = installFetchMock([
    { method: "POST", url: "https://oauth2.googleapis.com/token", json: { access_token: "at" } },
    { url: "https://www.googleapis.com/youtube/v3/channels", json: { items: [{}] } },
    { url: "https://youtubereporting.googleapis.com/v1/jobs/job1/reports", json: { reports: [
      { id: "r1", startTime: "2026-10-27T00:00:00Z", endTime: "2026-10-28T00:00:00Z", createTime: "2026-10-30T00:00:00Z", downloadUrl: "https://youtubereporting.googleapis.com/dl/r1" },
      { id: "r2", startTime: "2026-10-27T00:00:00Z", endTime: "2026-10-28T00:00:00Z", createTime: "2026-11-01T00:00:00Z", downloadUrl: "https://youtubereporting.googleapis.com/dl/r2" },
    ] } },
    { url: "https://youtubereporting.googleapis.com/v1/jobs", json: { jobs: [{ id: "job1", reportTypeId: "channel_reach_basic_a1" }] } },
    { url: "https://youtubereporting.googleapis.com/dl/r2", body: head + "20261027,UC1,video_aaaaa,80,0.05\n" },
    { url: "https://youtubeanalytics.googleapis.com/v2/reports", json: { columnHeaders: [{ name: "day" }, { name: "views" }], rows: [] } },
  ]);
  restore = m.restore;
  const { db, t } = fakeDb({
    gtm_yt_videos: ["video_aaaaa", "video_bbbbb", "video_ccccc"].map((video_id) => ({ video_id, title: video_id, published_at: null, duration_s: 30 })),
    // r1 was ingested on an earlier run and named a and b; r2 (the reissue) names only a.
    gtm_yt_report_files: [{ report_id: "r1", report_type: "channel_reach_basic_a1", start_date: "2026-10-27", end_date: "2026-10-28", rows_ingested: 2 }],
    gtm_yt_video_daily: [
      { date: "2026-10-27", video_id: "video_aaaaa", views: 9, likes: 1, impressions: 100, ctr: 4, source: "api" },
      { date: "2026-10-27", video_id: "video_bbbbb", views: 3, likes: 2, impressions: 50, ctr: 6, source: "studio-export" },
      { date: "2026-10-27", video_id: "video_ccccc", views: 4, impressions: null, ctr: null, source: "api" },
      { date: "2026-10-26", video_id: "video_bbbbb", views: 7, impressions: 30, ctr: 1, source: "api" }, // another day: not this file's
    ],
    gtm_yt_channel_daily: [{ date: "2026-10-27", views: 16, impressions: 150, ctr: 4.67, source: "api" }],
  });
  const r = await syncYouTube(db, { today: "2026-10-29", days: 1, env: { YOUTUBE_CLIENT_ID: "i", YOUTUBE_CLIENT_SECRET: "s", YOUTUBE_REFRESH_TOKEN: "r" } });
  assert.equal(r.reach.files, 1);
  assert.ok(!m.calls.some((c) => c.url.includes("/dl/r1"))); // the old file is not read again
  const vd = (date: string, id: string) => t.gtm_yt_video_daily.find((x) => x.date === date && x.video_id === id)!;
  assert.deepEqual([vd("2026-10-27", "video_aaaaa").impressions, vd("2026-10-27", "video_aaaaa").ctr, vd("2026-10-27", "video_aaaaa").views], [80, 5, 9]);
  const b = vd("2026-10-27", "video_bbbbb");
  assert.deepEqual([b.impressions, b.ctr], [null, null]);                   // stale reach cleared
  assert.deepEqual([b.views, b.likes, b.source], [3, 2, "studio-export"]); // nothing else touched
  assert.equal(vd("2026-10-27", "video_ccccc").views, 4);
  assert.deepEqual([vd("2026-10-26", "video_bbbbb").impressions, vd("2026-10-26", "video_bbbbb").ctr], [30, 1]); // other dates untouched
  const ch = t.gtm_yt_channel_daily.find((x) => x.date === "2026-10-27")!;
  assert.deepEqual([ch.impressions, ch.ctr, ch.views], [80, 5, 16]); // the day total follows the newest file
});
