// Content analytics data layer (VIB-417): our own engagement rate, UTM tagging, the idempotent per-day
// snapshot upsert, the Zernio delta feed and account reach, all against a mocked fetch.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { installFetchMock, type Route } from "./support/fetch-mock.ts";

Object.assign(process.env, {
  NEXT_PUBLIC_SUPABASE_URL: "https://db.test", SUPABASE_SECRET_KEY: "sb_secret_test",
  ZERNIO_API_URL: "https://zernio.test/api/v1", ZERNIO_API_KEY: "zk_test",
});
delete process.env.GTM_UTM_HOSTS;

const { engagements, isMaturing, median, ownRate, rateBasis } = await import("../lib/analytics/metrics.ts");
const { tagLinks, tagUrl, utmCampaign } = await import("../lib/utm.ts");
const { metricExtras, syncStats, upsertSnapshots } = await import("../lib/sync.ts");
const { syncDelta, zernioRate, DELTA_CURSOR_KEY } = await import("../lib/analytics/delta.ts");
const { syncChannelReach } = await import("../lib/analytics/channels.ts");
const { orSkip } = await import("../lib/zernio-analytics.ts");
const { ZernioError } = await import("../lib/zernio.ts");
const { adminDb } = await import("../lib/db.ts");

const REST = "https://db.test/rest/v1/";
const Z = "https://zernio.test/api/v1";
let mock: ReturnType<typeof installFetchMock> | null = null;
const use = (routes: Route[]) => (mock = installFetchMock(routes));
afterEach(() => { mock?.restore(); mock = null; });
const json = (b: string | null) => JSON.parse(b ?? "null");
const M = (over: Record<string, unknown>) => ({ platform: "linkedin", published_at: "2026-10-07T12:00:00Z", impressions: 0, reach: 0, likes: 0, comments: 0, shares: 0, saves: 0, clicks: 0, views: 0, ...over });

// ---- metrics ------------------------------------------------------------------------------------------------

test("own engagement rate: LinkedIn per impression, Instagram per reach, YouTube per view; missing is null, not 0", () => {
  assert.deepEqual(ownRate(M({ impressions: 324, likes: 7, comments: 4 })), { value: 3.4, per: "impression" });
  assert.deepEqual(ownRate(M({ platform: "instagram", impressions: 248, reach: 217, likes: 7 })), { value: 3.2, per: "account reached" });
  assert.deepEqual(ownRate(M({ platform: "youtube", views: 44 })), { value: 0, per: "view" });
  assert.equal(ownRate(M({ platform: "youtube", impressions: 100, likes: 5 })), null, "YouTube without views has no rate, even with impressions");
  assert.equal(rateBasis("instagram").key, "reach");
  assert.equal(engagements(M({ likes: 1, comments: 2, shares: 3, saves: 4, clicks: 99 })), 10, "clicks are not engagement");
});

test("median ignores non-numbers; maturing windows: Instagram 48 h, YouTube 72 h", () => {
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([NaN, 2]), 2);
  assert.equal(median([]), null);
  const now = new Date("2026-10-11T00:00:00Z");
  assert.equal(isMaturing("instagram", "2026-10-09T12:00:00Z", now), true);
  assert.equal(isMaturing("instagram", "2026-10-08T23:00:00Z", now), false);
  assert.equal(isMaturing("youtube", "2026-10-08T12:00:00Z", now), true);
  assert.equal(isMaturing("linkedin", "2026-10-09T12:00:00Z", now), false);
});

// ---- UTM -------------------------------------------------------------------------------------------------------

const UTM = { source: "linkedin", campaign: "season-1-w02", content: "s1-01-sample-piece-01-linkedin" };

test("UTM tagging: only our own links, never twice, punctuation kept outside the link", () => {
  assert.equal(tagUrl("https://brand.example.com/case-studies/sample-extra-38", UTM),
    "https://brand.example.com/case-studies/sample-extra-38?utm_source=linkedin&utm_medium=social&utm_campaign=season-1-w02&utm_content=s1-01-sample-piece-01-linkedin");
  assert.equal(tagUrl("https://brand.example.com/ai-transformation?ref=x#start", UTM),
    "https://brand.example.com/ai-transformation?ref=x&utm_source=linkedin&utm_medium=social&utm_campaign=season-1-w02&utm_content=s1-01-sample-piece-01-linkedin#start");
  assert.equal(tagUrl("https://brand.example.com/x?utm_source=newsletter", UTM), "https://brand.example.com/x?utm_source=newsletter", "an existing tag is left alone");
  assert.equal(tagUrl("https://notvibrana.ai/x", UTM), "https://notvibrana.ai/x", "a look-alike host is not ours");
  assert.equal(tagUrl("https://github.com/vibrana/aios", UTM), "https://github.com/vibrana/aios");
  const text = "Case study: https://brand.example.com/orion. Source: https://example.com/a, and (https://brand.example.com/assess)";
  assert.equal(tagLinks(text, UTM),
    "Case study: https://brand.example.com/orion?utm_source=linkedin&utm_medium=social&utm_campaign=season-1-w02&utm_content=s1-01-sample-piece-01-linkedin. Source: https://example.com/a, and (https://brand.example.com/assess?utm_source=linkedin&utm_medium=social&utm_campaign=season-1-w02&utm_content=s1-01-sample-piece-01-linkedin)");
});

test("UTM tagging stops at typographic quotes and ellipses, keeping both the link and the character (review finding 2)", () => {
  const t = (s: string) => tagLinks(s, UTM);
  const q = "utm_source=linkedin&utm_medium=social&utm_campaign=season-1-w02&utm_content=s1-01-sample-piece-01-linkedin";
  assert.equal(t("“https://brand.example.com/x”"), `“https://brand.example.com/x?${q}”`);
  assert.equal(t("‘https://brand.example.com/x’ and more"), `‘https://brand.example.com/x?${q}’ and more`);
  assert.equal(t("See https://brand.example.com/x…"), `See https://brand.example.com/x?${q}…`);
  assert.equal(t("'https://brand.example.com/x'"), `'https://brand.example.com/x?${q}'`);
  assert.equal(t("(https://brand.example.com/a-b_c~d/e%20f?x=1)"), `(https://brand.example.com/a-b_c~d/e%20f?x=1&${q})`);
});

test("UTM campaign: season and season week when a season covers the date, else the ISO week", () => {
  const seasons = [{ id: "season-1", starts_on: "2026-10-06", ends_on: "2026-12-11" }];
  assert.equal(utmCampaign("2026-10-07", seasons), "season-1-w01");
  assert.equal(utmCampaign("2026-10-14", seasons), "season-1-w02");
  assert.equal(utmCampaign("2027-01-05", seasons), "2027-w01");
  assert.equal(utmCampaign("2026-11-12"), "2026-w46");
});

test("UTM hosts can be widened with GTM_UTM_HOSTS", () => {
  process.env.GTM_UTM_HOSTS = "brand.example.com, sample-author.com";
  try {
    assert.match(tagUrl("https://sample-author.com/lab", UTM), /utm_source=linkedin/);
  } finally { delete process.env.GTM_UTM_HOSTS; }
});

// ---- snapshots: one row per post, platform and day ---------------------------------------------------------

test("metricExtras keeps reported extras and drops Zernio's 0-for-unsupported, except a real 0 follows", () => {
  assert.deepEqual(metricExtras({ igReelsAvgWatchTime: 14708, reelsSkipRate: 61.9, follows: null, profileViews: 0, sends: 3, videoDurationSeconds: 44 }),
    { sends: 3, igReelsAvgWatchTime: 14708, reelsSkipRate: 61.9, videoDurationSeconds: 44 });
  assert.deepEqual(metricExtras({ follows: 0 }), { follows: 0 });
  assert.deepEqual(metricExtras(null), {});
});

test("syncStats upserts on (post, platform, day), joins by latePostId (the id we scheduled) or the post URL, and keeps extras", async () => {
  const m = use([
    { url: `${Z}/analytics`, json: { posts: [
      { _id: "ext-1", latePostId: "zp-1", status: "published", isExternal: true, content: "Power vs purpose", platforms: [
        { platform: "instagram", accountId: "ig", platformPostUrl: "https://ig.test/1", analytics: { impressions: 248, reach: 217, likes: 7, follows: null, igReelsAvgWatchTime: 14708, reelsSkipRate: 61.9 } },
      ] },
      { _id: "ext-2", status: "published", isExternal: true, platform: "linkedin", platformPostUrl: "https://li.test/2", analytics: { impressions: 10 } },
      { _id: "ext-3", status: "published", isExternal: true, platform: "youtube", analytics: { views: 1 } },
    ] } },
    { method: "GET", url: REST + "gtm_content_items", json: [
      { id: "pvp-instagram", zernio_post_id: "zp-1", urls: {} },
      { id: "doc-linkedin", zernio_post_id: null, urls: { linkedin: "https://li.test/2" } },
      { id: "pending-one", zernio_post_id: "pending", urls: null },
    ] },
    { method: "POST", url: REST + "gtm_post_metrics", status: 201 },
  ]);
  assert.deepEqual(await syncStats(7), { posts: 3, rows: 3 });
  const post = m.calls.at(-1)!;
  assert.equal(new URL(post.url).searchParams.get("on_conflict"), "zernio_post_id,platform,captured_on");
  assert.match(post.headers.prefer, /resolution=merge-duplicates/, "an upsert, so a second run the same day updates the row");
  const rows = json(post.body);
  assert.deepEqual(rows.map((r: any) => [r.zernio_post_id, r.platform, r.content_item_id]), [
    ["ext-1", "instagram", "pvp-instagram"], ["ext-2", "linkedin", "doc-linkedin"], ["ext-3", "youtube", null],
  ]);
  assert.deepEqual(rows[0].extras, { igReelsAvgWatchTime: 14708, reelsSkipRate: 61.9 });
  assert.ok(!("captured_on" in rows[0]), "captured_on is generated by the database from captured_at");
});

test("upsertSnapshots collapses repeats of one post, platform and day within a batch (Postgres refuses them in one upsert)", async () => {
  const m = use([{ method: "POST", url: REST + "gtm_post_metrics", status: 201 }]);
  const row = (likes: number, at: string) => ({ zernio_post_id: "p", platform: "linkedin", captured_at: at, content_item_id: null, is_external: true, published_at: null, platform_post_url: null, content_preview: "", impressions: 0, reach: 0, likes, comments: 0, shares: 0, saves: 0, clicks: 0, views: 0, engagement_rate: null, extras: {} });
  assert.equal(await upsertSnapshots(adminDb(), [row(1, "2026-10-11T01:00:00Z"), row(2, "2026-10-11T05:00:00Z"), row(3, "2026-10-12T01:00:00Z")]), 2);
  assert.deepEqual(json(m.calls[0].body).map((r: any) => r.likes), [2, 3]);
});

// ---- the delta feed ----------------------------------------------------------------------------------------

const STATE = REST + "gtm_sync_state";

test("syncDelta bootstraps: cursor first, then a full snapshot, then the cursor is stored", async () => {
  const m = use([
    { method: "GET", url: STATE, json: null },
    { url: `${Z}/analytics/delta`, json: { data: [], nextCursor: "c0", hasMore: false } },
    { url: `${Z}/analytics?`, json: { posts: [] } },
    { method: "GET", url: REST + "gtm_content_items", json: [] },
    { method: "POST", url: STATE, status: 201 },
  ]);
  const r = await syncDelta(adminDb());
  assert.equal((r as { bootstrapped?: boolean }).bootstrapped, true);
  const order = m.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`);
  assert.ok(order.indexOf("GET /api/v1/analytics/delta") < order.indexOf("GET /api/v1/analytics"), "the cursor is taken before the baseline loads");
  assert.deepEqual(json(m.calls.at(-1)!.body), { key: DELTA_CURSOR_KEY, value: { cursor: "c0" }, updated_at: json(m.calls.at(-1)!.body).updated_at });
});

test("syncDelta reads changed posts, keeps known URL and calendar link, upserts today's row, then advances the cursor", async () => {
  const entry = { postId: "ext-1", accountId: "a", profileId: "p", platform: "linkedin", platformPostId: "urn:1", publishedAt: "2026-10-07T12:00:00Z", syncedAt: "2026-10-11T00:00:00Z", isDeleted: false,
    metrics: { impressions: 330, reach: 200, likes: 8, comments: 4, shares: 0, saves: 1, sends: 2, clicks: 0, views: 120 } };
  const m = use([
    { method: "GET", url: STATE, json: { value: { cursor: "c1" } } },
    { url: `${Z}/analytics/delta?cursor=c1`, json: { data: [entry, { ...entry, postId: "gone", isDeleted: true }], nextCursor: "c2", hasMore: true } },
    { url: `${Z}/analytics/delta?cursor=c2`, json: { data: [], nextCursor: "c3", hasMore: false } },
    { method: "GET", url: REST + "gtm_post_metrics", json: [{ zernio_post_id: "ext-1", platform: "linkedin", content_item_id: "pvp-linkedin", platform_post_url: "https://li.test/1", content_preview: "Power", is_external: true }] },
    { method: "GET", url: REST + "gtm_content_items", json: [] },
    { method: "POST", url: REST + "gtm_post_metrics", status: 201 },
    { method: "POST", url: STATE, status: 201 },
  ]);
  assert.deepEqual(await syncDelta(adminDb(), { now: new Date("2026-10-11T03:00:00Z") }), { pages: 2, changed: 2, rows: 1 });
  const rows = json(m.calls.find((c) => c.method === "POST" && c.url.startsWith(REST + "gtm_post_metrics"))!.body);
  assert.deepEqual(rows[0], {
    zernio_post_id: "ext-1", platform: "linkedin", captured_at: "2026-10-11T03:00:00.000Z", content_item_id: "pvp-linkedin", is_external: true,
    published_at: "2026-10-07T12:00:00Z", platform_post_url: "https://li.test/1", content_preview: "Power",
    impressions: 330, reach: 200, likes: 8, comments: 4, shares: 0, saves: 1, clicks: 0, views: 120, engagement_rate: 3.94, extras: { sends: 2 },
  });
  assert.equal(json(m.calls.at(-1)!.body).value.cursor, "c2", "an empty page is not a reason to advance: c2 is kept, never c3");
});

test("syncDelta keeps the recorded published_at when an entry arrives without one (review finding 5)", async () => {
  const entry = { postId: "ext-1", accountId: "a", profileId: "p", platform: "linkedin", platformPostId: "urn:1", publishedAt: "", syncedAt: "2026-10-11T00:00:00Z", isDeleted: false, metrics: { impressions: 5 } };
  const m = use([
    { method: "GET", url: STATE, json: { value: { cursor: "c1" } } },
    { url: `${Z}/analytics/delta?cursor=c1`, json: { data: [entry], nextCursor: "c2", hasMore: false } },
    { method: "GET", url: REST + "gtm_post_metrics", json: [{ zernio_post_id: "ext-1", platform: "linkedin", content_item_id: null, platform_post_url: null, content_preview: "", is_external: true, published_at: "2026-10-07T12:00:00+00:00" }] },
    { method: "GET", url: REST + "gtm_content_items", json: [] },
    { method: "POST", url: REST + "gtm_post_metrics", status: 201 },
    { method: "POST", url: STATE, status: 201 },
  ]);
  await syncDelta(adminDb());
  assert.equal(json(m.calls.find((c) => c.method === "POST" && c.url.startsWith(REST + "gtm_post_metrics"))!.body)[0].published_at, "2026-10-07T12:00:00+00:00");
});

test("syncDelta: an expired cursor (400) starts over from a fresh cursor and a full snapshot", async () => {
  const m = use([
    { method: "GET", url: STATE, json: { value: { cursor: "old" } }, times: 1 },
    { url: `${Z}/analytics/delta?cursor=old`, status: 400, json: { error: "cursor expired" } },
    { method: "DELETE", url: STATE, status: 204 },
    { method: "GET", url: STATE, json: null },
    { url: `${Z}/analytics/delta`, json: { data: [], nextCursor: "fresh", hasMore: false } },
    { url: `${Z}/analytics?`, json: { posts: [] } },
    { method: "GET", url: REST + "gtm_content_items", json: [] },
    { method: "POST", url: STATE, status: 201 },
  ]);
  const r = await syncDelta(adminDb());
  assert.equal((r as { bootstrapped?: boolean }).bootstrapped, true);
  assert.equal(json(m.calls.at(-1)!.body).value.cursor, "fresh");
});

test("zernioRate mirrors Zernio's formula: first non-zero of impressions, reach, views", () => {
  assert.equal(zernioRate({ likes: 7, impressions: 248, reach: 217 }), 2.82);
  assert.equal(zernioRate({ likes: 1, views: 50 }), 2);
  assert.equal(zernioRate({ likes: 1 }), null);
});

// ---- account reach and skips -----------------------------------------------------------------------------------

test("syncChannelReach fills impressions and reach only on days the follower sync already recorded", async () => {
  const m = use([
    { method: "GET", url: REST + "gtm_channel_daily", json: [
      { account_id: "a-li", platform: "linkedin", date: "2026-10-10" }, { account_id: "a-li", platform: "linkedin", date: "2026-10-11" },
      { account_id: "a-ig", platform: "instagram", date: "2026-10-11" }, { account_id: "a-ig2", platform: "instagram", date: "2026-10-11" },
    ] },
    { url: `${Z}/analytics/dashboard`, json: { totals: {}, followers: {}, daily: [{ date: "2026-10-09", impressions: 1, reach: 1 }, { date: "2026-10-10", impressions: 47, reach: 34 }, { date: "2026-10-11", impressions: 11, reach: 9 }] } },
    { method: "POST", url: REST + "gtm_channel_daily", status: 201 },
  ]);
  const r = await syncChannelReach(adminDb(), { now: new Date("2026-10-11T06:00:00Z") });
  assert.deepEqual(r, { linkedin: 2, instagram: "skipped: 2 accounts on instagram" });
  assert.deepEqual(json(m.calls.find((c) => c.method === "POST")!.body), [
    { account_id: "a-li", platform: "linkedin", date: "2026-10-10", impressions: 47, reach: 34 },
    { account_id: "a-li", platform: "linkedin", date: "2026-10-11", impressions: 11, reach: 9 },
  ]);
  assert.match(new URL(m.calls[1].url).search, /platform=linkedin/);
});

test("orSkip turns 402 and 403 into a reason; other errors still throw", async () => {
  assert.deepEqual(await orSkip(async () => { throw new ZernioError(402, "upgrade", "/x"); }), { skipped: "Zernio analytics not enabled on this plan" });
  assert.match((await orSkip(async () => { throw new ZernioError(403, "scope", "/x"); }) as { skipped: string }).skipped, /403/);
  await assert.rejects(orSkip(async () => { throw new ZernioError(500, "boom", "/x"); }), /500/);
});
