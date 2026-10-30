// The /performance aggregation helpers (VIB-419): weeks, per-platform rows in native units, the four
// awareness tiles, baselines, the leaderboard cohort, pillar x format medians, best time, growth bands and
// the manual-entry rules. Pure functions, no network.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.REPORT_TZ = "Asia/Makassar";
const D = await import("../lib/analytics/dashboard.ts");
const { parseManualEntry, manualComplete } = await import("../lib/analytics/manual.ts");

const NOW = new Date("2026-10-25T04:00:00Z"); // Sunday, noon in Bali
const snap = (over: Partial<import("../lib/analytics/dashboard.ts").Snap>): import("../lib/analytics/dashboard.ts").Snap => ({
  zernio_post_id: "z", platform: "linkedin", published_at: "2026-10-07T01:00:00Z", content_item_id: null, is_external: false,
  platform_post_url: null, content_preview: "", captured_at: "2026-10-25T00:00:00Z",
  impressions: 0, reach: 0, likes: 0, comments: 0, shares: 0, saves: 0, clicks: 0, views: 0, extras: {}, ...over,
});

test("resolveWeek: any date maps to its Monday; bad input and future weeks fall back to the current week", () => {
  assert.deepEqual(D.resolveWeek("2026-10-08", "2026-10-25"), { from: "2026-10-05", to: "2026-10-11", current: false });
  assert.deepEqual(D.resolveWeek(undefined, "2026-10-25"), { from: "2026-10-19", to: "2026-10-25", current: true });
  assert.equal(D.resolveWeek("not-a-date", "2026-10-25").from, "2026-10-19");
  assert.equal(D.resolveWeek("2027-01-04", "2026-10-25").from, "2026-10-19", "no future weeks");
  assert.deepEqual(D.weekStarts("2026-10-19", 3), ["2026-10-05", "2026-10-12", "2026-10-19"]);
  assert.equal(D.weekLabel("2026-09-28"), "Sep 28 to Oct 4");
  assert.equal(D.weekLabel("2026-10-05"), "Oct 5 to 11");
});

test("timezone helpers: Bali is UTC+8, so a Bali week starts at 16:00 UTC the day before", () => {
  assert.equal(D.tzOffsetHours("Asia/Makassar"), 8);
  assert.equal(D.localMidnight("2026-10-05", "Asia/Makassar"), "2026-10-05T00:00:00+08:00");
  // 23:30 UTC on Sunday Oct 11 is Monday Oct 12 in Bali: the post belongs to the next week.
  assert.equal(D.postDay({ published_at: "2026-10-11T23:30:00Z" }), "2026-10-12");
});

test("platformWeek: native units, medians with the denominator named, nothing summed across platforms", () => {
  const snaps = [
    snap({ zernio_post_id: "a", impressions: 1000, likes: 30, comments: 5, published_at: "2026-10-06T01:00:00Z" }),
    snap({ zernio_post_id: "b", impressions: 500, likes: 5, published_at: "2026-10-08T01:00:00Z", is_external: true }),
    snap({ zernio_post_id: "c", impressions: 9000, likes: 900, published_at: "2026-10-14T01:00:00Z" }),
    snap({ zernio_post_id: "d", platform: "youtube", views: 400, likes: 4, published_at: "2026-10-07T01:00:00Z" }),
  ];
  const li = D.platformWeek(snaps, "linkedin", "2026-10-05", "2026-10-11", NOW);
  assert.equal(li.posts, 2);
  assert.equal(li.reach, 1500, "impressions within one platform may be added");
  assert.equal(li.unit, "impressions");
  assert.deepEqual(li.rate, { value: 2.3, per: "impression", n: 2 }, "median of 3.5% and 1.0%, to 1 dp");
  assert.equal(li.external, 1);
  const yt = D.platformWeek(snaps, "youtube", "2026-10-05", "2026-10-11", NOW);
  assert.equal(yt.reach, 400);
  assert.equal(yt.unit, "views");
  const ig = D.platformWeek(snaps, "instagram", "2026-10-05", "2026-10-11", NOW);
  assert.equal(ig.posts, 0);
  assert.equal(ig.reach, null, "nothing published is unknown, not 0");
  assert.equal(ig.reachGap, "none");
  const unreported = D.platformWeek([snap({ is_external: true, likes: 3 })], "linkedin", "2026-10-05", "2026-10-11", NOW);
  assert.equal(unreported.reach, null, "a post with no analytics reports 0 impressions: unknown, not 0");
  assert.equal(unreported.reachGap, "unreported");
  assert.equal(ig.rate, null);
});

test("platformWeek: maturing posts are counted but kept out of the rate", () => {
  const now = new Date("2026-10-08T12:00:00Z");
  const snaps = [snap({ platform: "instagram", reach: 100, likes: 50, published_at: "2026-10-08T00:00:00Z" })];
  const ig = D.platformWeek(snaps, "instagram", "2026-10-05", "2026-10-11", now);
  assert.equal(ig.maturing, 1);
  assert.equal(ig.rate, null);
});

test("followerWindow: start before the window, end inside it; one observation is not a change", () => {
  const rows = [
    { platform: "linkedin", date: "2026-10-04", followers: 100 },
    { platform: "linkedin", date: "2026-10-09", followers: 112 },
    { platform: "instagram", date: "2026-10-08", followers: 50 },
  ];
  assert.deepEqual(D.followerWindow(rows, "linkedin", "2026-10-05", "2026-10-11"), { start: 100, end: 112, net: 12 });
  assert.equal(D.followerWindow(rows, "instagram", "2026-10-05", "2026-10-11").net, null);
  assert.equal(D.followersAt(rows, "linkedin", "2026-10-05"), 100);
  assert.equal(D.followersAt(rows, "youtube", "2026-10-05"), null);
});

test("conversations: the queue is the only source when readable; platform comments only when it is not", () => {
  assert.deepEqual(D.conversations({ instagram: { comments: 3, dms: 2, total: 5 } }, { instagram: 40, linkedin: 6 }), { total: 5, comments: 3, dms: 2, source: "queue" },
    "platform counts (cumulative, with John's replies) never mix into a queue week");
  assert.deepEqual(D.conversations(null, { linkedin: 2, youtube: 1 }), { total: 3, comments: 3, dms: 0, source: "posts" });
  assert.equal(D.conversations(null, {}), null, "no data at all is unknown");
  assert.deepEqual(D.conversations({}, { linkedin: 9 }), { total: 0, comments: 0, dms: 0, source: "queue" }, "a readable, empty queue is a real 0");
});

test("comparableBaseline: like for like only; a week counted from another source gives no delta", () => {
  const q = (value: number | null) => ({ value, source: value == null ? null : "queue" });
  // Reviewer's case: last week was counted from platform comments (12, John's replies included), this week from the queue (10).
  assert.deepEqual(D.comparableBaseline([{ value: 12, source: "posts" }, q(10)], "prev"), { value: null, comparable: false });
  assert.deepEqual(D.comparableBaseline([q(8), q(10)], "prev"), { value: 8, comparable: true });
  assert.deepEqual(D.comparableBaseline([q(4), { value: 9, source: "posts" }, q(6), q(8), q(10)], "median4"), { value: null, comparable: false });
  assert.deepEqual(D.comparableBaseline([q(99), q(4), q(null), q(6), q(8), q(10)], "median4"), { value: 6, comparable: true }, "empty weeks are skipped, not a source change");
  assert.equal(D.countDelta(10, 7.5), 3, "count deltas are whole numbers");
  assert.equal(D.countDelta(null, 3), null);
});

test("bucketQueue: one read, bucketed by the Bali week each comment was written in", () => {
  const rows = [
    { platform: "instagram", kind: "comment", commented_at: "2026-10-05T01:00:00Z" },
    { platform: "instagram", kind: "dm", commented_at: "2026-10-11T15:59:00Z" },
    { platform: "linkedin", kind: "comment", commented_at: "2026-10-11T16:30:00Z" }, // Monday 00:30 in Bali: next week
    { platform: "linkedin", kind: "comment", commented_at: "2026-09-01T00:00:00Z" }, // outside the weeks: ignored
  ];
  assert.deepEqual(D.bucketQueue(rows, ["2026-10-05", "2026-10-12"]), [
    { instagram: { comments: 1, dms: 1, total: 2 } },
    { linkedin: { comments: 1, dms: 0, total: 1 } },
  ]);
});

test("weekTiles: counts may be added across platforms, and net followers says which platforms are unknown", () => {
  const snaps = [
    snap({ zernio_post_id: "a", impressions: 1000, likes: 10, comments: 2, saves: 1, extras: { sends: 3 } }),
    snap({ zernio_post_id: "b", platform: "youtube", views: 50, likes: 5, comments: 1 }),
  ];
  const followers = [{ platform: "linkedin", date: "2026-10-04", followers: 10 }, { platform: "linkedin", date: "2026-10-11", followers: 15 }];
  const t = D.weekTiles(snaps, followers, null, "2026-10-05", "2026-10-11");
  assert.equal(t.conversations?.source, "posts");
  assert.equal(t.engagements, 19);
  assert.equal(t.savesSends, 4);
  assert.equal(t.conversations?.total, 3);
  assert.deepEqual(t.netFollowers, { total: 5, known: ["linkedin"], unknown: ["instagram", "youtube"] });
  const empty = D.weekTiles([], [], null, "2026-10-12", "2026-10-18");
  assert.equal(empty.engagements, null);
  assert.equal(empty.netFollowers, null);
});

test("baseline: last week, or the median of the 4 weeks before; gaps are skipped, not zeroed", () => {
  assert.equal(D.baseline([1, 2, 3, 10], "prev"), 3);
  assert.equal(D.baseline([7, 1, null, 3, 5, 99], "median4"), 3, "median of 1, 3, 5");
  assert.equal(D.baseline([99], "median4"), null);
  assert.equal(D.baseline([null, 4], "prev"), null);
});

test("leaderboard: final posts only, best first; rate sorting needs one platform", () => {
  const items = [{ id: "i1", title: "Orion", pillar: "proof", format: "carousel", urls: { linkedin: "https://li/1" } }];
  const snaps = [
    snap({ zernio_post_id: "old", comments: 2, impressions: 100, published_at: "2026-10-06T01:00:00Z", platform_post_url: "https://li/1" }),
    snap({ zernio_post_id: "top", comments: 9, impressions: 1000, published_at: "2026-10-10T01:00:00Z" }),
    snap({ zernio_post_id: "fresh", comments: 50, impressions: 100, published_at: "2026-10-23T01:00:00Z" }),
  ];
  const r = D.leaderboard(snaps, items, { from: "2026-09-01", to: "2026-10-25", now: NOW, sort: "comments" });
  assert.deepEqual(r.rows.map((x) => x.href), ["/performance/post/top?platform=linkedin", "/performance/post/old?platform=linkedin"], "the 2-day-old post is not ranked");
  assert.equal(r.rows[1].title, "Orion", "joined to the calendar by URL");
  assert.equal(r.cohort, 2);
  assert.equal(D.leaderboard(snaps, items, { from: "2026-09-01", to: "2026-10-25", now: NOW, sort: "rate" }).sort, "comments");
  assert.equal(D.leaderboard(snaps, items, { from: "2026-09-01", to: "2026-10-25", now: NOW, sort: "rate", platform: "linkedin" }).rows[0].href, "/performance/post/old?platform=linkedin", "2% beats 0.9%");
});

test("pillarFormatGrid: each pillar's own leading metric, n per cell, fewer than 3 is thin", () => {
  const items = [
    { id: "p1", title: "a", pillar: "perspective", format: "text" }, { id: "p2", title: "b", pillar: "perspective", format: "text" },
    { id: "p3", title: "c", pillar: "perspective", format: "text" }, { id: "q1", title: "d", pillar: "proof", format: "carousel" },
  ];
  const snaps = [
    snap({ content_item_id: "p1", impressions: 100 }), snap({ content_item_id: "p2", impressions: 300 }), snap({ content_item_id: "p3", impressions: 200 }),
    snap({ content_item_id: "q1", comments: 2 }),
  ];
  const g = D.pillarFormatGrid(snaps, items, "linkedin", { from: "2026-09-01", to: "2026-10-25", now: NOW, conversationsByItem: new Map([["q1", 5]]) });
  assert.deepEqual(g.formats, ["text", "carousel"]);
  const odd = D.pillarFormatGrid([...snaps, snap({ content_item_id: "o1", impressions: 50 })], [...items, { id: "o1", title: "e", pillar: "perspective", format: "other" }], "linkedin", { from: "2026-09-01", to: "2026-10-25", now: NOW });
  assert.deepEqual(odd.formats, ["text", "carousel", "other"], "a format outside the five gets its own column, so n and the cells agree");
  const perspective = g.rows.find((r) => r.slug === "perspective")!;
  assert.deepEqual(perspective.cells.text, { median: 200, n: 3, thin: false });
  assert.equal(perspective.unit, "impressions");
  const proof = g.rows.find((r) => r.slug === "proof")!;
  assert.deepEqual(proof.cells.carousel, { median: 5, n: 1, thin: true }, "Proof counts the queue's conversations when larger");
  assert.deepEqual(proof.cells.text, { median: null, n: 0, thin: true });
  assert.equal(D.metricUnit("reach", "instagram"), "accounts reached");
});

test("bestTimeGrid: UTC slots shift into local time across midnight and the week's end", () => {
  const g = D.bestTimeGrid([{ day_of_week: 6, hour: 20, avg_engagement: 12, post_count: 2 }, { day_of_week: 0, hour: 1, avg_engagement: 3, post_count: 1 }], 8);
  assert.deepEqual(g.cells[0][4], { value: 12, n: 2 }, "Sunday 20:00 UTC is Monday 04:00 in Bali");
  assert.deepEqual(g.cells[0][9], { value: 3, n: 1 });
  assert.equal(g.cells[3][3].value, null, "an empty slot is null, not 0");
  assert.equal(g.max, 12);
  const own = D.ownTimeSlots([snap({ published_at: "2026-10-05T02:00:00Z", likes: 4 }), snap({ published_at: "2026-10-05T02:30:00Z", likes: 8 }), snap({ published_at: "2026-10-24T02:00:00Z", likes: 99 })], NOW);
  assert.deepEqual(own, [{ day_of_week: 0, hour: 2, avg_engagement: 6, post_count: 2 }], "settled posts only, mean per slot");
});

test("growthCurve and curveBand: last snapshot per day; the band needs 3 curves on a day", () => {
  const c = D.growthCurve([{ at: "2026-10-05T03:00:00Z", value: 10 }, { at: "2026-10-05T20:00:00Z", value: 30 }, { at: "2026-10-06T05:00:00Z", value: 50 }, { at: "2026-10-04T05:00:00Z", value: 1 }], "2026-10-05T01:00:00Z");
  assert.deepEqual(c, [{ day: 0, value: 30 }, { day: 1, value: 50 }]);
  const band = D.curveBand([[{ day: 0, value: 10 }, { day: 1, value: 20 }], [{ day: 0, value: 20 }], [{ day: 0, value: 30 }, { day: 1, value: 40 }]]);
  assert.deepEqual(band, [{ day: 0, p25: 15, p50: 20, p75: 25, n: 3 }], "only day 0 is reached by all three");
  const four = [[0, 1, 2], [0, 1, 2], [0, 1, 2], [0]].map((days, i) => days.map((day) => ({ day, value: (i + 1) * 10 + day })));
  assert.deepEqual(D.curveBand(four).map((b) => [b.day, b.n]), [[0, 3], [1, 3], [2, 3]], "one fixed set: the short curve is left out on every day");
  assert.equal(D.quantile([1, 2, 3, 4], 0.5), 2.5);
});

test("formatting and ids", () => {
  assert.equal(D.compact(1284), "1,284");
  assert.equal(D.compact(12_940), "12.9K");
  assert.equal(D.compact(4_200_000), "4.2M");
  assert.equal(D.youtubeId("https://www.youtube.com/shorts/abcDEF12345"), "abcDEF12345");
  assert.equal(D.youtubeId("https://youtu.be/xyz987654?t=3"), "xyz987654");
  assert.equal(D.youtubeId("https://www.youtube.com/watch?v=Q1w2e3r4t5y&list=x"), "Q1w2e3r4t5y");
  assert.equal(D.youtubeId(null), null);
});

test("manual entry: blanks are unknown, numbers are checked, the week snaps to Monday", () => {
  const ok = parseManualEntry({ week: "2026-10-08", channel: "youtube", values: { impressions: "1,240", ctr: "4.25%" } });
  assert.deepEqual(ok, { ok: true, entry: { week_start: "2026-10-05", channel: "youtube", metrics: { impressions: 1240, ctr: 4.25 }, note: "" } });
  const partial = parseManualEntry({ week: "2026-10-05", channel: "substack_regenera", values: { subscribers: "812", opens: "" } });
  assert.ok(partial.ok && !("opens" in partial.entry.metrics), "an empty field is left out, not stored as 0");
  assert.deepEqual(parseManualEntry({ week: "2026-10-05", channel: "youtube", values: { ctr: "140" } }), { ok: false, error: "Impressions click-through rate (%): a percent is at most 100." });
  assert.equal(parseManualEntry({ week: "2026-10-05", channel: "youtube", values: { impressions: "1.5" } }).ok, false);
  assert.equal(parseManualEntry({ week: "2026-10-05", channel: "youtube", values: { impressions: "-1" } }).ok, false);
  assert.equal(parseManualEntry({ week: "2026-10-05", channel: "tiktok", values: { impressions: "1" } }).ok, false);
  assert.equal(parseManualEntry({ week: "2026-10-05", channel: "youtube", values: {} }).ok, false);
  assert.equal(parseManualEntry({ week: "2026-10-05", channel: "youtube", values: { impressions: 7 as unknown as string } }).ok, true, "a number from a crafted client is coerced");
  assert.equal(parseManualEntry({ week: "2026-10-05", channel: "youtube", values: { impressions: {} as unknown as string } }).ok, false, "an object is refused, not thrown");
  assert.equal(parseManualEntry(null as never).ok, false);
  assert.equal(manualComplete("youtube", { impressions: 10 }), false);
  assert.equal(manualComplete("youtube", { impressions: 10, ctr: 2 }), true);
});

test("followers: two accounts on one platform are added per account, never diffed against each other", () => {
  const rows = [
    { account_id: "a", platform: "linkedin", date: "2026-10-04", followers: 100 }, { account_id: "a", platform: "linkedin", date: "2026-10-10", followers: 110 },
    { account_id: "b", platform: "linkedin", date: "2026-10-04", followers: 2000 }, { account_id: "b", platform: "linkedin", date: "2026-10-09", followers: 2030 },
  ];
  assert.deepEqual(D.followerWindow(rows, "linkedin", "2026-10-05", "2026-10-11"), { start: 2100, end: 2140, net: 40 });
  assert.equal(D.followersAt(rows, "linkedin", "2026-10-09"), 2130);
});

test("cn keeps a Prism font size next to a text color (tailwind-merge knows text-pl-* is a size)", async () => {
  const { cn } = await import("../lib/ui/cn.ts");
  assert.equal(cn("text-pl-2xl font-semibold", "text-ink"), "text-pl-2xl font-semibold text-ink");
  assert.equal(cn("text-pl-xs", "text-sm"), "text-sm", "two sizes still resolve to the last");
});
