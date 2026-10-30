// Kill a piece, retry a failed post, move a whole piece, LinkedIn's length limit and the remembered calendar view.
// Supabase and Zernio are a mocked fetch: no live service is reachable.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { installFetchMock, type Route } from "./support/fetch-mock.ts";

Object.assign(process.env, {
  NEXT_PUBLIC_SUPABASE_URL: "https://db.test", SUPABASE_SECRET_KEY: "sb_secret_test",
  ZERNIO_API_URL: "https://zernio.test/api/v1", ZERNIO_API_KEY: "zk_test",
});
const { adminDb } = await import("../lib/db.ts");
const { killPiece } = await import("../lib/kill-piece.ts");
const { eventReason, failureReason, retryCalendarItem, retryKey } = await import("../lib/retry-item.ts");
const { contentHash } = await import("../lib/calendar-db.ts");
const { channelClashes, ClashError, movePiece, moveRefusal, planPieceMove, siblingLegs } = await import("../lib/move-piece.ts");
const { pieceLegs } = await import("../lib/posts.ts");
const { checkChannelLinks, checkLinkedinLength } = await import("../lib/channel-rules.ts");
const { calendarView } = await import("../lib/filter-memory.ts");
import type { Post } from "../lib/posts.ts";

const REST = "https://db.test/rest/v1/";
const Z = "https://zernio.test/api/v1";
let mock: ReturnType<typeof installFetchMock> | null = null;
// The stack's reads and claims these paths now make (a shared review check, the kill record, the delivery ledger, the
// legacy send claim): answered as for a legacy piece, after each test's own routes.
const STACK: Route[] = [
  { method: "GET", url: REST + "gtm_piece_reviews", json: [] },
  { method: "GET", url: REST + "gtm_sync_state", json: [] },
  { method: "POST", url: REST + "gtm_sync_state", status: 201 },
  { method: "GET", url: REST + "gtm_piece_deliveries", json: [] },
  { method: "POST", url: REST + "rpc/gtm_claim_legacy_send", json: true },
];
const use = (routes: Route[]) => (mock = installFetchMock([...routes, ...STACK]));
afterEach(() => { mock?.restore(); mock = null; });
const json = (b: string | null) => JSON.parse(b ?? "null");

test("killPiece: unsent legs go to skipped, their Zernio posts are deleted, published legs stay, notes are resolved", async () => {
  const m = use([
    { method: "GET", url: REST + "gtm_content_items", json: [
      { id: "p-linkedin", status: "scheduled", zernio_post_id: "z1" },
      { id: "p-instagram", status: "drafted", zernio_post_id: null },
      { id: "p-youtube", status: "published", zernio_post_id: "z0" },
    ] },
    { method: "GET", url: `${Z}/posts/z1`, json: { post: { _id: "z1", status: "scheduled", platforms: [] } } },
    { method: "DELETE", url: `${Z}/posts/z1`, json: {} },
    { method: "PATCH", url: REST + "gtm_content_items", status: 204 },
    { method: "GET", url: REST + "gtm_story_assets", json: [{ id: "p-copy" }, { id: "p-video" }] },
    { method: "PATCH", url: REST + "gtm_story_feedback", json: [{ id: "n1" }] },
  ]);
  const r = await killPiece(adminDb(), "p");
  assert.deepEqual(r, { story: "p", skipped: ["p-linkedin", "p-instagram"], deleted: { "p-linkedin": "z1" }, published: ["p-youtube"], notesResolved: 1 });
  // The linked leg is skipped right after its own delete; the unlinked legs together after.
  const order = m.calls.filter((c) => c.method === "DELETE" || (c.method === "PATCH" && c.url.includes("gtm_content_items")));
  assert.deepEqual(order.map((c) => c.method === "DELETE" ? "delete z1" : new URL(c.url).searchParams.get("id")), ["delete z1", "in.(p-linkedin)", "in.(p-instagram)"]);
  assert.deepEqual([json(order[1].body).status, json(order[1].body).zernio_post_id], ["skipped", null]);
  const notes = m.calls.find((c) => c.url.includes("gtm_story_feedback"))!;
  assert.equal(new URL(notes.url).searchParams.get("resolved_at"), "is.null");
  assert.match(json(notes.body).resolution, /Killed/);
});

test("killPiece refuses, changing nothing, when Zernio says a linked post already went out", async () => {
  const m = use([
    { method: "GET", url: REST + "gtm_content_items", json: [{ id: "p-linkedin", status: "scheduled", zernio_post_id: "z1" }] },
    { method: "GET", url: `${Z}/posts/z1`, json: { post: { _id: "z1", status: "published", platforms: [] } } },
  ]);
  await assert.rejects(killPiece(adminDb(), "p"), /already went out on Zernio/);
  assert.ok(!m.calls.some((c) => c.method === "DELETE" || c.method === "PATCH"));
});

test("killPiece refuses a post Zernio sent on some platforms (partial)", async () => {
  const m = use([
    { method: "GET", url: REST + "gtm_content_items", json: [{ id: "p-linkedin", status: "scheduled", zernio_post_id: "z1" }] },
    { method: "GET", url: `${Z}/posts/z1`, json: { post: { _id: "z1", status: "partial", platforms: [] } } },
  ]);
  await assert.rejects(killPiece(adminDb(), "p"), /already went out on Zernio \(z1, partial\)/);
  assert.ok(!m.calls.some((c) => c.method === "DELETE" || c.method === "PATCH"));
});

test("killPiece of an unknown story is an error, not a success", async () => {
  use([{ method: "GET", url: REST + "gtm_content_items", json: [] }]);
  await assert.rejects(killPiece(adminDb(), "s1-typo"), /s1-typo has no calendar rows/);
});

test("killPiece: a Zernio error part way leaves no row pointing at a deleted post", async () => {
  const m = use([
    { method: "GET", url: REST + "gtm_content_items", json: [
      { id: "p-linkedin", status: "scheduled", zernio_post_id: "z1" },
      { id: "p-instagram", status: "scheduled", zernio_post_id: "z2" },
    ] },
    { method: "GET", url: `${Z}/posts/z1`, json: { post: { _id: "z1", status: "scheduled", platforms: [] } } },
    { method: "GET", url: `${Z}/posts/z2`, json: { post: { _id: "z2", status: "scheduled", platforms: [] } } },
    { method: "DELETE", url: `${Z}/posts/z1`, json: {} },
    { method: "DELETE", url: `${Z}/posts/z2`, status: 502, body: "bad gateway" },
    { method: "PATCH", url: REST + "gtm_content_items", status: 204 },
  ]);
  await assert.rejects(killPiece(adminDb(), "p"), /Zernio 502/);
  const patches = m.calls.filter((c) => c.method === "PATCH");
  assert.deepEqual(patches.map((c) => new URL(c.url).searchParams.get("id")), ["in.(p-linkedin)"], "the deleted leg is already skipped; the other is untouched");
});

test("killPiece: a Zernio post that no longer exists is not an error", async () => {
  use([
    { method: "GET", url: REST + "gtm_content_items", json: [{ id: "p-linkedin", status: "scheduled", zernio_post_id: "gone" }] },
    { method: "GET", url: `${Z}/posts/gone`, status: 404, body: "not found" },
    { method: "PATCH", url: REST + "gtm_content_items", status: 204 },
    { method: "GET", url: REST + "gtm_story_assets", json: [] },
  ]);
  const r = await killPiece(adminDb(), "p");
  assert.deepEqual([r.skipped, r.deleted], [["p-linkedin"], {}]);
});

test("retry refuses anything that did not fail", async () => {
  use([{ method: "GET", url: REST + "gtm_content_items", json: [{ id: "x", status: "scheduled", zernio_post_id: "z1" }] }]);
  await assert.rejects(retryCalendarItem(adminDb(), "x"), /only a failed post can be retried/);
});

test("retry runs the send guards before touching Zernio: a refusal leaves the post failed and its Zernio post in place", async () => {
  const m = use([
    { method: "GET", url: REST + "gtm_content_items?select=id%2Cstatus", json: [{ id: "x", status: "failed", zernio_post_id: "z-old" }] },
    { method: "GET", url: `${Z}/posts/z-old`, json: { post: { _id: "z-old", status: "failed", platforms: [] } } },
    // The calendar the dry run reads: x is not in it, so the guards refuse.
    { method: "GET", url: REST + "gtm_content_items", json: [] },
  ]);
  await assert.rejects(retryCalendarItem(adminDb(), "x"), /no calendar item x/);
  assert.ok(!m.calls.some((c) => c.method === "DELETE" || c.method === "PATCH"));
});

test("retry: guards pass, the failed post is deleted, the send uses its own idempotency key, a refusal writes failed back", async () => {
  const body = "A post that fits.";
  const row = {
    id: "x", week: 43, date: "2099-10-20", time: "08:30", pillar: "perspective", title: "X", format: "text", channels: ["linkedin"],
    status: "failed", link: null, cta: null, zernio_post_id: "z-old", published_at: null, urls: {}, story_id: null, story_assets: [],
    publication: null, body, media: [], copy_path: null, approved_hash: contentHash({ body, media: [] }),
  };
  const m = use([
    { method: "GET", url: REST + "gtm_content_items?select=id%2Cstatus", json: [{ id: "x", status: "failed", zernio_post_id: "z-old" }] },
    { method: "GET", url: `${Z}/posts/z-old`, json: { post: { _id: "z-old", status: "failed", platforms: [] } } },
    { method: "GET", url: REST + "gtm_content_items", json: [row], times: 1 },
    { method: "GET", url: REST + "gtm_seasons", json: [] },
    { method: "GET", url: REST + "gtm_people", json: [] },
    { method: "GET", url: REST + "gtm_zernio_events", json: [{ payload: { post: { _id: "z-old", platforms: [{ platform: "linkedin", errorMessage: "text too long" }] } } }] },
    { method: "DELETE", url: `${Z}/posts/z-old`, json: {} },
    { method: "PATCH", url: REST + "gtm_content_items", json: [{ id: "x" }] },
    { method: "GET", url: REST + "gtm_content_items", json: [{ ...row, status: "approved", zernio_post_id: null }] },
    { method: "POST", url: `${Z}/posts`, status: 422, body: "{\"error\":\"rejected\"}" },
    { method: "POST", url: REST + "gtm_zernio_events", status: 201 },
  ]);
  await assert.rejects(retryCalendarItem(adminDb(), "x"), /Zernio 422/);
  const del = m.calls.findIndex((c) => c.method === "DELETE");
  const firstPatch = m.calls.findIndex((c) => c.method === "PATCH");
  assert.ok(del > 0 && firstPatch > del, "deleted only after the dry run, reset after the delete");
  const post = m.calls.find((c) => c.method === "POST" && c.url.startsWith(`${Z}/posts`))!;
  assert.equal(post.headers["idempotency-key"], "gtm-x-retry-z-old");
  const last = m.calls.filter((c) => c.method === "PATCH").at(-1)!;
  assert.equal(json(last.body).status, "failed");
  assert.equal(new URL(last.url).searchParams.get("zernio_post_id"), "is.null");
  // The reason outlives the deleted post: stored where the failed panel reads it, with Zernio's earlier reason.
  const noted = m.calls.find((c) => c.method === "POST" && c.url.startsWith(REST + "gtm_zernio_events"))!;
  const payload = json(noted.body).payload ?? json(noted.body)[0]?.payload;
  assert.equal(payload.calendarId, "x");
  assert.match(payload.reason, /^Retry refused: Zernio 422.*before that, Zernio said: linkedin: text too long/);
});

test("retry: a write-back that fails is said, not swallowed", async () => {
  const body = "A post that fits.";
  const row = {
    id: "x", week: 43, date: "2099-10-20", time: "08:30", pillar: "perspective", title: "X", format: "text", channels: ["linkedin"],
    status: "failed", link: null, cta: null, zernio_post_id: null, published_at: null, urls: {}, story_id: null, story_assets: [],
    publication: null, body, media: [], copy_path: null, approved_hash: contentHash({ body, media: [] }),
  };
  use([
    { method: "GET", url: REST + "gtm_content_items?select=id%2Cstatus", json: [{ id: "x", status: "failed", zernio_post_id: null }] },
    { method: "GET", url: REST + "gtm_content_items", json: [row], times: 1 },
    { method: "GET", url: REST + "gtm_seasons", json: [] },
    { method: "GET", url: REST + "gtm_people", json: [] },
    // The reset, then the 4xx reset of the claim (the claim itself is the gtm_claim_legacy_send RPC, not a PATCH);
    // the write-back to failed is the one that fails.
    { method: "PATCH", url: REST + "gtm_content_items", json: [{ id: "x" }], times: 2 },
    { method: "PATCH", url: REST + "gtm_content_items", status: 500, json: { message: "db down" } },
    { method: "GET", url: REST + "gtm_content_items", json: [{ ...row, status: "approved" }] },
    { method: "POST", url: `${Z}/posts`, status: 422, body: "{}" },
    { method: "POST", url: REST + "gtm_zernio_events", status: 201 },
  ]);
  await assert.rejects(retryCalendarItem(adminDb(), "x"), /Zernio 422.*could not be set back to failed \(db down\)/s);
});

test("failure reason of an unlinked failed post: the reason its refused retry recorded", async () => {
  const m = use([
    { method: "GET", url: REST + "gtm_content_items", json: [{ id: "x", status: "failed", zernio_post_id: null }] },
    { method: "GET", url: REST + "gtm_zernio_events", json: [{ payload: { calendarId: "x", reason: "Retry refused: too soon" } }] },
  ]);
  assert.equal(await failureReason(adminDb(), "x"), "Retry refused: too soon");
  const q = new URL(m.calls[1].url).searchParams;
  assert.deepEqual([q.get("event"), q.get("payload->>calendarId")], ["eq.gtm.retry.failed", "eq.x"]);
});

test("retry key: its own per failed post, never the original gtm-<id>", () => {
  assert.equal(retryKey("x", "z1"), "gtm-x-retry-z1");
  assert.equal(retryKey("x", null, 42), "gtm-x-retry-42");
});

test("retry stops when the Zernio post is not failed after all", async () => {
  const m = use([
    { method: "GET", url: REST + "gtm_content_items", json: [{ id: "x", status: "failed", zernio_post_id: "z-old" }] },
    { method: "GET", url: `${Z}/posts/z-old`, json: { post: { _id: "z-old", status: "published", platforms: [] } } },
  ]);
  await assert.rejects(retryCalendarItem(adminDb(), "x"), /went out on Zernio after all/);
  assert.ok(!m.calls.some((c) => c.method === "DELETE" || c.method === "PATCH"));
});

test("failure reason: Zernio's per-platform error message", async () => {
  const msg = "HTTP error! status: 400 - ShareCommentary text length (4323 characters) exceeded the maximum allowed (4000 characters)";
  use([
    { method: "GET", url: REST + "gtm_content_items", json: [{ id: "x", status: "failed", zernio_post_id: "z1" }] },
    { method: "GET", url: `${Z}/posts/z1`, json: { post: { _id: "z1", status: "failed", platforms: [{ platform: "linkedin", errorMessage: msg }] } } },
  ]);
  assert.equal(await failureReason(adminDb(), "x"), `linkedin: ${msg}`);
});

test("failure reason from a stored webhook payload, only for the right post", () => {
  const payload = { post: { _id: "z1", platforms: [{ platform: "linkedin", errorMessage: "too long" }] } };
  assert.equal(eventReason(payload, "z1"), "linkedin: too long");
  assert.equal(eventReason(payload, "z2"), null);
  assert.equal(eventReason({ post: { _id: "z1" }, platform: { platform: "instagram", errorMessage: "bad media" } }, "z1"), "instagram: bad media");
  assert.equal(eventReason(null, "z1"), null);
});

test("moving a piece: every leg that can still move goes to the day, a time applies to the chosen post only", () => {
  const legs = [
    { id: "w-linkedin", story_id: "w", status: "scheduled", date: "2026-10-21" },
    { id: "w-youtube", story_id: "w", status: "approved", date: "2026-10-22" },
    { id: "w-instagram", story_id: "w", status: "published", date: "2026-10-21" },
    { id: "w-old", story_id: "w", status: "skipped", date: "2026-10-21" },
    { id: "other", story_id: "o", status: "scheduled", date: "2026-10-21" },
  ];
  assert.deepEqual(planPieceMove(legs, "w-linkedin", { date: "2026-10-26", time: "14:00" }), [
    { id: "w-linkedin", date: "2026-10-26", time: "14:00" },
    { id: "w-youtube", date: "2026-10-26" },
  ]);
  assert.deepEqual(planPieceMove(legs, "w-linkedin", { date: "2026-10-26" }, false), [{ id: "w-linkedin", date: "2026-10-26" }]);
  // A failed sibling stays put (its dead Zernio post is never moved) and is reported.
  const withFailed = [...legs, { id: "w-dead", story_id: "w", status: "failed", date: "2026-10-21" }];
  assert.deepEqual(planPieceMove(withFailed, "w-linkedin", { date: "2026-10-26" }).map((p) => p.id), ["w-linkedin", "w-youtube"]);
  assert.deepEqual(siblingLegs(withFailed, "w-linkedin").failed.map((l) => l.id), ["w-dead"]);
  assert.deepEqual(planPieceMove([{ id: "lone", story_id: null, status: "drafted", date: "2026-10-21" }], "lone", { date: "2026-10-23" }), [{ id: "lone", date: "2026-10-23" }]);
  assert.throws(() => planPieceMove(legs, "missing", { date: "2026-10-26" }), /no calendar item/);
});

test("a whole-piece move flags a day whose channel another piece already holds", () => {
  const moving = [
    { id: "w-linkedin", story_id: "w", status: "scheduled", date: "2026-10-21", channels: ["linkedin"] },
    { id: "w-instagram", story_id: "w", status: "scheduled", date: "2026-10-21", channels: ["instagram"] },
  ];
  const onDay = [
    { id: "o-linkedin", story_id: "o", status: "scheduled", date: "2026-10-26", channels: ["linkedin"] },
    { id: "k-instagram", story_id: "k", status: "skipped", date: "2026-10-26", channels: ["instagram"] },
    { id: "w-youtube", story_id: "w", status: "approved", date: "2026-10-26", channels: ["youtube"] },
  ];
  assert.deepEqual(channelClashes(moving, onDay), ["linkedin already has o-linkedin that day"]);
  assert.deepEqual(channelClashes(moving, onDay.slice(1)), [], "killed posts and the piece's own legs do not clash");
  // Only what the scheduler counts holds a channel: a draft, an idea or a failed post does not.
  for (const status of ["drafted", "idea", "failed"]) assert.deepEqual(channelClashes(moving, [{ ...onDay[0], status }]), [], status);
  assert.equal(channelClashes(moving, [{ ...onDay[0], status: "approved" }]).length, 1);
});

test("movePiece onto a day another piece holds: a ClashError and nothing moves; with force, every leg moves", async () => {
  const legs = [
    { id: "w-linkedin", story_id: "w", status: "approved", date: "2099-10-21", time: "14:00", channels: ["linkedin"] },
    { id: "w-instagram", story_id: "w", status: "approved", date: "2099-10-21", time: "18:00", channels: ["instagram"] },
  ];
  const routes = (): Route[] => [
    { method: "GET", url: `${REST}gtm_content_items?select=id%2Cstory_id%2Cstatus%2Cdate%2Ctime%2Cchannels&id=eq.w-linkedin`, json: [legs[0]] },
    { method: "GET", url: `${REST}gtm_content_items?select=id%2Cstory_id%2Cstatus%2Cdate%2Ctime%2Cchannels&story_id=eq.w`, json: legs },
    { method: "GET", url: `${REST}gtm_content_items?select=id%2Cstory_id%2Cstatus%2Cdate%2Ctime%2Cchannels&date=eq.2099-10-26`, json: [{ id: "o-linkedin", story_id: "o", status: "scheduled", date: "2099-10-26", time: "14:00", channels: ["linkedin"] }] },
    { method: "GET", url: `${REST}gtm_content_items?select=id%2Cdate%2Ctime%2Cstatus%2Czernio_post_id&id=eq.w-linkedin`, json: [{ ...legs[0], zernio_post_id: null }] },
    { method: "GET", url: `${REST}gtm_content_items?select=id%2Cdate%2Ctime%2Cstatus%2Czernio_post_id&id=eq.w-instagram`, json: [{ ...legs[1], zernio_post_id: null }] },
    { method: "PATCH", url: REST + "gtm_content_items", status: 204 },
  ];
  let m = use(routes());
  const refused = await movePiece(adminDb(), "w-linkedin", { date: "2099-10-26" }).then(() => null, (e) => e);
  assert.ok(refused instanceof ClashError);
  assert.deepEqual(refused.clashes, ["linkedin already has o-linkedin that day"]);
  assert.ok(!m.calls.some((c) => c.method === "PATCH"), "a clash moves nothing");
  mock!.restore();
  m = use(routes());
  const r = await movePiece(adminDb(), "w-linkedin", { date: "2099-10-26" }, { force: true });
  assert.deepEqual([r.moved.map((x) => [x.id, x.to.date]), r.failed], [[["w-linkedin", "2099-10-26"], ["w-instagram", "2099-10-26"]], []]);
  assert.deepEqual(m.calls.filter((c) => c.method === "PATCH").map((c) => new URL(c.url).searchParams.get("id")), ["eq.w-linkedin", "eq.w-instagram"]);
});

test("the move action's refusal: a clash is flagged for Move anyway, any other error is not", () => {
  assert.deepEqual(moveRefusal(new ClashError("2099-10-26", ["linkedin already has o-linkedin that day"])), { ok: false, clash: true, error: "2099-10-26 already has another piece: linkedin already has o-linkedin that day." });
  assert.deepEqual(moveRefusal(new Error("is in the past")), { ok: false, error: "is in the past" });
  assert.deepEqual(moveRefusal("weird"), { ok: false, error: "Could not move the post." });
});

test("on screen, a drag takes the piece's movable legs along", () => {
  const post = (over: Partial<Post>): Post => ({
    id: "p", date: "2026-10-10", time: "08:30", title: "A post", channels: ["linkedin"], status: "scheduled", pillar: "proof", format: "text",
    storyId: null, publication: null, caption: "", thumb: null, mediaKind: null, urls: {}, handsOn: false, linkProblems: [], ...over,
  });
  const posts = [post({ id: "a", storyId: "s" }), post({ id: "b", storyId: "s" }), post({ id: "c", storyId: "s", status: "published" }), post({ id: "d", storyId: "t" })];
  assert.deepEqual(pieceLegs(posts, "a", true), ["a", "b"]);
  assert.deepEqual(pieceLegs(posts, "a", false), ["a"]);
  assert.deepEqual(pieceLegs(posts, "d", true), ["d"]);
});

test("LinkedIn length for approval and staging: over 4,000 is refused, over 3,000 warns, 3,000 passes", () => {
  assert.match(checkLinkedinLength("x", "a".repeat(4323)).errors[0], /the LinkedIn post is 4,323 characters; LinkedIn takes at most 4,000/);
  assert.deepEqual(checkLinkedinLength("x", "a".repeat(4000)).errors, []);
  // Frontier AI at 1.7% (3,892 after John's edit) is scheduled for Mon 10-19: it warns, it is never blocked.
  const ultramarine = checkLinkedinLength("x", "a".repeat(3892));
  assert.deepEqual([ultramarine.errors, ultramarine.warnings.length], [[], 1]);
  assert.deepEqual(checkChannelLinks("x", ["linkedin"], { base: "a".repeat(3892), perChannel: {}, meta: {} }).errors, []);
  assert.equal(checkLinkedinLength("x", "a".repeat(3001)).warnings.length, 1);
  assert.deepEqual(checkLinkedinLength("x", "a".repeat(3000)), { errors: [], warnings: [] });
  // The channel rules carry the hard limit once (checkChannelLength) and the warning; another channel's text is not LinkedIn's.
  const long = { base: "b".repeat(4100), perChannel: { instagram: "short" }, meta: {} };
  assert.equal(checkChannelLinks("x", ["linkedin"], long).errors.length, 1);
  assert.equal(checkChannelLinks("x", ["instagram"], long).errors.length, 0);
  assert.equal(checkChannelLinks("x", ["linkedin"], { base: "b".repeat(3500), perChannel: {}, meta: {} }).warnings.filter((w) => /3,000|3000/.test(w)).length, 1);
});

test("calendar view: the address bar wins, then its cursor, then the remembered view, else week", () => {
  assert.equal(calendarView({}, undefined), "week");
  assert.equal(calendarView({}, "month"), "month");
  assert.equal(calendarView({}, "list"), "list");
  assert.equal(calendarView({}, "bogus"), "week");
  assert.equal(calendarView({ view: "list" }, "month"), "list");
  assert.equal(calendarView({ month: "2026-11" }, "list"), "month");
  assert.equal(calendarView({ week: "2026-10-19" }, "month"), "week");
});
