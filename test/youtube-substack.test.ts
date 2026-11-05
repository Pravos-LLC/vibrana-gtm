// YouTube Studio export parsing, the API clients (against a mocked fetch), the weekly reach roll-up and the Substack
// export ingest. Nothing here reaches Google, Substack or a database.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { installFetchMock } from "./support/fetch-mock.ts";

const { parseCsv, parseCsvObjects } = await import("../lib/youtube/csv.ts");
const { parseContentChart, parseContentTable, parseDimChart, studioDate } = await import("../lib/youtube/studio.ts");
const api = await import("../lib/youtube/api.ts");
const { weeklyReach } = await import("../lib/youtube/sync.ts");
const { parseSubscribers, parseGrowth, weeklyStats } = await import("../lib/substack/ingest.ts");

let restore: (() => void) | null = null;
afterEach(() => { restore?.(); restore = null; });

test("csv reader handles quotes, doubled quotes, commas, CRLF and a BOM", () => {
  assert.deepEqual(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n'), [["a", "b"], ["x, y", 'say "hi"']]);
  assert.deepEqual(parseCsvObjects("a,b\n1,2\n"), [{ a: "1", b: "2" }]);
});

test("studio content chart and table become videos and daily views; the Total row is skipped", () => {
  const chart = 'Date,Content,Video title,Video publish time,Duration,Views\n2026-10-07,NqiAZrew80Q,"""You are the only example it has.""","Oct 17, 2026",54,3\n2026-10-08,NqiAZrew80Q,"""You are the only example it has.""","Oct 17, 2026",54,0\n';
  const c = parseContentChart(chart);
  assert.equal(c.videos.length, 1);
  assert.equal(c.videos[0].published_at, "2026-10-17T12:00:00Z");
  assert.equal(c.videos[0].duration_s, 54);
  assert.deepEqual(c.days.map((d) => d.views), [3, 0]);
  const table = "Content,Video title,Video publish time,Duration,Views\nTotal,,,,1121\npMY-JeMi-lg,Title,\"Oct 29, 2026\",53,312\n";
  assert.deepEqual(parseContentTable(table).map((v) => v.video_id), ["pMY-JeMi-lg"]);
  assert.equal(studioDate("garbage"), null);
});

test("studio traffic and geography charts map to dimension rows", () => {
  assert.deepEqual(parseDimChart("Date,Traffic source,Views\n2026-10-07,Shorts feed,10\n", "traffic_source"), [{ date: "2026-10-07", dimension: "traffic_source", key: "Shorts feed", views: 10 }]);
  assert.equal(parseDimChart("Date,Geography,Views\n2026-10-07,GB,37\n", "country")[0].key, "GB");
});

test("ISO durations parse to seconds", () => {
  assert.equal(api.isoSeconds("PT1M5S"), 65);
  assert.equal(api.isoSeconds("PT1H"), 3600);
  assert.equal(api.isoSeconds("nope"), null);
});

test("reach CSV: CTR fraction becomes percent, dates are ISO", () => {
  const rows = api.parseReach("date,channel_id,video_id,video_thumbnail_impressions,video_thumbnail_impressions_ctr\n20261029,UC1,pMY-JeMi-lg,45,0.0222\n");
  assert.deepEqual(rows, [{ date: "2026-10-29", video_id: "pMY-JeMi-lg", impressions: 45, ctr: 2.22 }]);
});

test("weekly reach weights CTR by impressions and drops unfinished weeks", () => {
  // Week of Mon 2026-10-26: 100 impressions at 10% and 300 at 2% is 4% overall, not the 6% average of the rates.
  const rows = [
    { date: "2026-10-26", impressions: 100, ctr: 10 }, { date: "2026-10-27", impressions: 300, ctr: 2 },
    { date: "2026-11-02", impressions: 50, ctr: 1 },
  ];
  const w = weeklyReach(rows, "2026-11-03");
  assert.deepEqual(w, [{ week_start: "2026-10-26", impressions: 400, ctr: 4 }]);
});

test("token refresh posts the refresh grant and never returns the secret", async () => {
  const m = installFetchMock([{ method: "POST", url: "https://oauth2.googleapis.com/token", json: { access_token: "at" } }]);
  restore = m.restore;
  assert.equal(await api.accessToken({ YOUTUBE_CLIENT_ID: "id", YOUTUBE_CLIENT_SECRET: "s", YOUTUBE_REFRESH_TOKEN: "r" }), "at");
  assert.match(Buffer.from(m.calls[0].body ?? "", "base64").toString(), /grant_type=refresh_token/);
  await assert.rejects(api.accessToken({}), /not connected/);
});

test("a report download from any other host is refused", async () => {
  await assert.rejects(api.downloadReport("t", "https://evil.example/report.csv"), /Unexpected/);
});

test("the reach job is created only when missing", async () => {
  const m = installFetchMock([
    { method: "GET", url: "https://youtubereporting.googleapis.com/v1/jobs", json: { jobs: [] }, times: 1 },
    { method: "POST", url: "https://youtubereporting.googleapis.com/v1/jobs", json: { id: "job1" } },
  ]);
  restore = m.restore;
  assert.deepEqual(await api.ensureReachJob("t"), { id: "job1", created: true });
});

test("substack exports: the owner row is not an audience member; weekly stats leave unknown weeks out", () => {
  const subs = parseSubscribers("Email,Name,Type,Activity,Start date,Revenue\no@x.com,Owner,Author,0,2024-03-27T11:36:00.532Z,$0.00\na@x.com,A,Free,0,2026-10-14T10:00:00.000Z,$0.00\nb@x.com,B,Free,1,2026-10-21T10:00:00.000Z,$0.00\n");
  const growth = parseGrowth("Date,Source,Category,Unique visitors,New subscribers,New revenue\n2026/10/20,Direct,Other,5,1,0\n2026/10/22,Google,Search,3,0,0\n");
  const s = weeklyStats(subs, growth, "2026-11-05", 4);
  assert.deepEqual(s.map((x) => x.week_start), ["2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"]);
  const wk = (d: string) => s.find((x) => x.week_start === d)!;
  assert.equal(wk("2026-10-12").subscribers, 1);
  assert.equal(wk("2026-10-19").subscribers, 2);
  assert.equal(wk("2026-10-19").visitors, undefined); // the week the file starts in may be cut off: unknown, not 0
  assert.equal(wk("2026-10-26").visitors, 0);
  assert.equal(wk("2026-10-26").new_subscribers, 0);
});

test("a file that is not a Substack export fails loudly", () => {
  assert.throws(() => parseSubscribers("a,b\n1,2\n"), /Not a Substack subscriber export/);
  assert.throws(() => parseGrowth("a,b\n1,2\n"), /Not a Substack growth export/);
});

test("YouTube view: CTR is weighted by impressions, absent stays null, traffic shares sum from the dimension rows", async () => {
  const { buildYouTubeView } = await import("../lib/youtube/view.ts");
  const videos = [{ video_id: "aaaaaaaaaaa", title: "A", published_at: "2026-10-20T12:00:00Z", duration_s: 30, is_short: true }];
  const days = [
    { date: "2026-10-20", video_id: "aaaaaaaaaaa", views: 90, watch_minutes: 60, avg_view_pct: 40, subs_gained: 1, impressions: 100, ctr: 10 },
    { date: "2026-10-27", video_id: "aaaaaaaaaaa", views: 10, watch_minutes: 6, avg_view_pct: 20, subs_gained: 0, impressions: 300, ctr: 2 },
  ];
  const dims = [{ date: "2026-10-20", dimension: "traffic_source", key: "Shorts feed", views: 75, watch_minutes: null }, { date: "2026-10-20", dimension: "traffic_source", key: "YouTube search", views: 25, watch_minutes: null }];
  const v = buildYouTubeView(videos, days, dims, "2026-10-07", "2026-11-03", ["api"]);
  assert.equal(v.videos[0].ctr, 4);            // 100 at 10% + 300 at 2% = 16 clicks of 400, not the 6% average of rates
  assert.equal(v.videos[0].avgPctViewed, 38);  // weighted by views: (40*90 + 20*10) / 100
  assert.equal(v.videos[0].viewsDay1Share, 90); // only the publish day and the next count as "first days"
  assert.deepEqual(v.traffic.map((t) => [t.key, t.share]), [["Shorts feed", 75], ["YouTube search", 25]]);
  const none = buildYouTubeView(videos, [{ ...days[0], impressions: null, ctr: null }], [], "2026-10-07", "2026-11-03");
  assert.equal(none.videos[0].ctr, null);
  assert.equal(none.impressions, null);
});

test("rows with different column sets are upserted in separate batches, so a reach-only row cannot null out stored views", async () => {
  const { byShape } = await import("../lib/youtube/sync.ts");
  const groups = byShape([{ date: "a", video_id: "v", views: 5 }, { date: "b", video_id: "v", impressions: 9 }, { date: "c", video_id: "v", views: 7 }]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((g) => g.length).sort(), [1, 2]);
});
