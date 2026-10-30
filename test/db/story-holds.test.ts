// Pending third-party approval against the LOCAL stack: only the owner can hold a Story; a held Story is skipped by
// the auto-scheduler even though John approved it, the publish gate refuses it, and releasing it makes it schedulable.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { admin, anon, seed, signedIn } from "../support/seed.ts";
import { local } from "../support/local-supabase.ts";

const l = local();
Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: l.url, SUPABASE_SECRET_KEY: l.secretKey, GTM_CALENDAR_SOURCE: "db" });
const { autoSchedule, loadHolds } = await import("../../lib/auto-schedule.ts");
const { setStoryHold } = await import("../../lib/story-ops.ts");
const { sendCalendarItem } = await import("../../lib/publish-item.ts");
const { loadCalendarDb } = await import("../../lib/calendar-db.ts");
before(seed);

const STORY = "hold-fx-piece";
const ITEM = `${STORY}-linkedin`;
const BODY = "A piece a partner has to sign off on first.";
const sha = createHash("sha256").update(BODY).digest("hex");
// A Tuesday well ahead, so the planned slot is open and in the future.
const DATE = "2030-10-08";

async function approvedPiece() {
  const sr = admin();
  await sr.from("gtm_stories").delete().eq("id", STORY);
  await sr.from("gtm_content_items").delete().eq("id", ITEM);
  // A season around DATE, so the piece is inside a season (not parked in the reserve bank).
  await sr.from("gtm_seasons").upsert({ id: "hold-season", title: "Hold season", description: "", starts_on: "2030-09-02", ends_on: "2030-12-13", pillars: ["proof"] });
  assert.equal((await sr.from("gtm_stories").insert({ id: STORY, title: "Held piece", link_url: "https://example.com/held" })).error, null);
  assert.equal((await sr.from("gtm_story_assets").insert({ id: `${STORY}-copy`, story_id: STORY, title: "Copy", kind: "copy", source: "posts/held/linkedin.md", sha256: sha, body: BODY })).error, null);
  assert.equal((await sr.from("gtm_story_asset_channels").insert({ asset_id: `${STORY}-copy`, channel: "linkedin" })).error, null);
  assert.equal((await sr.from("gtm_content_items").insert({ id: ITEM, week: 41, date: DATE, time: "08:30", pillar: "proof", title: "Held piece", format: "text", channels: ["linkedin"], status: "drafted", story_id: STORY, story_assets: [`${STORY}-copy`], body: BODY, media: [], copy_path: "posts/held/linkedin.md" }, { defaultToNull: false })).error, null);
  const owner = await signedIn("owner");
  const decided = await owner.rpc("gtm_decide_story_asset", { p_asset_id: `${STORY}-copy`, p_channel: "linkedin", p_status: "approved", p_note: "", p_expected_sha256: sha, p_expected_revision: 1 });
  assert.equal(decided.error, null, String(decided.error?.message));
  return owner;
}

test("only the signed-in owner can hold or release a Story through gtm_set_story_hold", async () => {
  await approvedPiece();
  const args = { p_story_id: STORY, p_held: true, p_who: "example_approver / Example Series", p_note: "Waiting on the v4 cut" };
  assert.match((await anon().rpc("gtm_set_story_hold", args)).error?.message ?? "no error", /permission denied/);
  for (const who of ["member", "impostor"] as const) {
    assert.match((await (await signedIn(who)).rpc("gtm_set_story_hold", args)).error?.message ?? "no error", /only the signed-in owner/, who);
  }
  const owner = await signedIn("owner");
  assert.match((await owner.from("gtm_stories").update({ held_at: new Date().toISOString() }).eq("id", STORY).select()).error?.message ?? "no error", /permission denied/);
  const held = await owner.rpc("gtm_set_story_hold", args);
  assert.equal(held.error, null, String(held.error?.message));
  assert.deepEqual((await loadHolds(admin(), STORY)).map((h) => [h.storyId, h.who, h.note]), [[STORY, "example_approver / Example Series", "Waiting on the v4 cut"]]);
  assert.equal((await owner.rpc("gtm_set_story_hold", { ...args, p_held: false })).error, null);
  assert.deepEqual(await loadHolds(admin(), STORY), []);
});

test("an approved piece on hold is skipped by auto-schedule and refused by the publish gate; released, it is scheduled", async () => {
  const owner = await approvedPiece();
  const sr = admin();
  assert.equal((await owner.rpc("gtm_set_story_hold", { p_story_id: STORY, p_held: true, p_who: "example_approver / Example Series", p_note: "" })).error, null);

  const held = await autoSchedule(sr, { storyId: STORY, dryRun: true });
  assert.deepEqual(held.scheduled, []);
  assert.deepEqual(held.failed, []);
  assert.deepEqual(held.skipped, [{ id: ITEM, storyId: STORY, reason: "held: publishing blocked until example_approver / Example Series approves the final" }]);
  assert.deepEqual(held.held.map((h) => h.storyId), [STORY]);
  // The real (non-dry) pass does the same and never touches the row.
  const real = await autoSchedule(sr, { storyId: STORY });
  assert.deepEqual([real.scheduled, real.failed], [[], []]);
  const row = (await sr.from("gtm_content_items").select("status,zernio_post_id").eq("id", ITEM).single()).data!;
  assert.deepEqual([row.status, row.zernio_post_id], ["drafted", null]);
  // A hand-run `gtm schedule` (or the Story page scheduler) hits the publish gate, which refuses it too.
  const cal = await loadCalendarDb(sr);
  await assert.rejects(sendCalendarItem({ ...cal, items: cal.items.map((i) => (i.id === ITEM ? { ...i, status: "approved" as const } : i)) }, ITEM, { mode: "schedule", dry: true, db: sr }), /is on hold, publishing blocked until example_approver \/ Example Series approves the final/);

  // "Third party approved": the CLI path (service role) clears it, and the same pass now slots the piece.
  await setStoryHold(sr, STORY, null);
  const released = await autoSchedule(sr, { storyId: STORY, dryRun: true });
  assert.deepEqual(released.held, []);
  assert.ok(!released.skipped.some((s) => s.reason.startsWith("held")), JSON.stringify(released.skipped));
  // The dry run reaches the publish gate (scheduled), or stops at a Zernio account mapping this stack does not have (failed); never at the hold.
  const reached = [...released.scheduled.map((s) => s.id), ...released.failed.filter((f) => !/on hold/.test(f.error)).map((f) => f.id)];
  assert.deepEqual(reached, [ITEM], JSON.stringify(released));
  if (released.scheduled.length) assert.deepEqual([released.scheduled[0].date, released.scheduled[0].time], [DATE, "08:30"]);
});

test("setStoryHold (CLI) holds with who and note, keeps the first hold time, and refuses an unknown Story", async () => {
  await approvedPiece();
  const sr = admin();
  await setStoryHold(sr, STORY, { who: " example_approver / Example Series ", note: " Waiting on example_approver's approval of the v4 cut " });
  const [first] = await loadHolds(sr, STORY);
  assert.deepEqual([first.who, first.note], ["example_approver / Example Series", "Waiting on example_approver's approval of the v4 cut"]);
  await setStoryHold(sr, STORY, { who: "example_approver", note: "" });
  const [second] = await loadHolds(sr, STORY);
  assert.deepEqual([second.who, second.note, second.heldAt], ["example_approver", "", first.heldAt]);
  await assert.rejects(setStoryHold(sr, "no-such-story", { who: "x" }), /no Story no-such-story/);
  await assert.rejects(setStoryHold(sr, STORY, { who: "x".repeat(201) }), /--who is limited/);
  await setStoryHold(sr, STORY, null);
});
