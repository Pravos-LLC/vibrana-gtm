// Approve with note and withdraw, against the LOCAL stack: John approves with a note, the piece is held from scheduling,
// `gtm story resolve` is refused until the fix is restaged, then records his approval on the fixed bytes and the piece
// schedules without coming back to him. A withdrawn final is hidden from /content and held until a new final lands.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { admin, seed, signedIn } from "../support/seed.ts";
import { local } from "../support/local-supabase.ts";

const l = local();
Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: l.url, SUPABASE_SECRET_KEY: l.secretKey, GTM_CALENDAR_SOURCE: "db" });
const { autoSchedule } = await import("../../lib/auto-schedule.ts");
const { encodeFixNote } = await import("../../lib/approve-note.ts");
const { loadFixNotes, resolveFixNote, supersedeFixNotes } = await import("../../lib/approve-note-db.ts");
const { contentVisibility, withdrawFinal } = await import("../../lib/content-visibility-db.ts");
before(seed);

const STORY = "s9-01-awn-fx";
const COPY = `${STORY}-linkedin`;
const ITEM = `${STORY}-linkedin`;
const BODY = "A post with one British colour in it.";
const FIXED = "A post with one American color in it.";
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const DATE = "2030-10-08"; // a Tuesday well ahead, inside the season below

async function stagedPiece() {
  const sr = admin();
  await sr.from("gtm_stories").delete().eq("id", STORY);
  await sr.from("gtm_content_items").delete().eq("id", ITEM);
  await sr.from("gtm_seasons").upsert({ id: "awn-season", title: "AWN season", description: "", starts_on: "2030-09-02", ends_on: "2030-12-13", pillars: ["proof"] });
  assert.equal((await sr.from("gtm_stories").insert({ id: STORY, title: "W1 Tue Oct 8 | Approve with note", link_url: "https://example.com/awn" })).error, null);
  assert.equal((await sr.from("gtm_story_assets").insert({ id: COPY, story_id: STORY, title: "LinkedIn", kind: "copy", source: "posts/awn/linkedin.md", sha256: digest(BODY), body: BODY })).error, null);
  assert.equal((await sr.from("gtm_story_asset_channels").insert({ asset_id: COPY, channel: "linkedin" })).error, null);
  assert.equal((await sr.from("gtm_content_items").insert({ id: ITEM, week: 41, date: DATE, time: "08:30", pillar: "proof", title: "Approve with note", format: "text", channels: ["linkedin"], status: "drafted", story_id: STORY, story_assets: [COPY], body: BODY, media: [], copy_path: "posts/awn/linkedin.md" }, { defaultToNull: false })).error, null);
}

/** What the "Approve with note" server action does, through the owner's own session: the note first, then the approval. */
async function approveWithNote(note: string) {
  const owner = await signedIn("owner");
  const added = await owner.rpc("gtm_add_story_feedback", { p_asset_id: COPY, p_channel: "linkedin", p_body: encodeFixNote({ part: "text", channels: ["linkedin"], assets: [COPY] }, note) });
  assert.equal(added.error, null, String(added.error?.message));
  const decided = await owner.rpc("gtm_decide_story_asset", { p_asset_id: COPY, p_channel: "linkedin", p_status: "approved", p_note: `approved with note: ${note}`, p_expected_sha256: digest(BODY), p_expected_revision: 1 });
  assert.equal(decided.error, null, String(decided.error?.message));
  return added.data as string;
}

const dryRunSchedule = async (db: Parameters<typeof autoSchedule>[0], storyId: string) => autoSchedule(db, { storyId, dryRun: true });

test("approved with note: held until the fix lands, resolve refused before the restage, then approved on the fixed bytes and scheduled", async () => {
  await stagedPiece();
  const sr = admin();
  const noteId = await approveWithNote("colour should be color");

  const notes = await loadFixNotes(sr, STORY);
  assert.deepEqual(notes.map((n) => [n.id, n.storyId, n.part, n.channels, n.note]), [[noteId, STORY, "text", ["linkedin"], "colour should be color"]]);
  // Approved for the current bytes, but held: auto-schedule never queues it while the note is open.
  const held = await autoSchedule(sr, { storyId: STORY, dryRun: true });
  assert.deepEqual(held.scheduled, []);
  assert.equal(held.skipped.length, 1);
  assert.match(held.skipped[0].reason, /^held: waiting for the fix \(linkedin\): John approved it with a note/);

  // Resolving before the fix is restaged is refused, and leaves the note open and the hold in force.
  await assert.rejects(resolveFixNote(sr, noteId, "done", { owner: () => signedIn("owner"), schedule: dryRunSchedule }), /no new version .* since John's note/);
  assert.equal((await sr.from("gtm_story_feedback").select("resolved_at").eq("id", noteId).single()).data!.resolved_at, null);

  // The agent restages the fix: the database resets the approval (new bytes) and records a new version.
  assert.equal((await sr.from("gtm_story_assets").update({ body: FIXED, sha256: digest(FIXED) }).eq("id", COPY)).error, null);
  const reset = (await sr.from("gtm_story_asset_channels").select("status").eq("asset_id", COPY).single()).data!;
  assert.equal(reset.status, "pending");

  const r = await resolveFixNote(sr, noteId, "Swapped colour for color.", { owner: () => signedIn("owner"), schedule: dryRunSchedule });
  assert.deepEqual(r.reapproved, [`${COPY}:linkedin`]);
  const row = (await sr.from("gtm_story_asset_channels").select("status,approved_sha256,note").eq("asset_id", COPY).single()).data!;
  assert.deepEqual([row.status, row.approved_sha256], ["approved", digest(FIXED)]);
  assert.match(row.note, /approved with note by John; fix applied: Swapped colour for color\./);
  const fb = (await sr.from("gtm_story_feedback").select("resolved_at,resolution").eq("id", noteId).single()).data!;
  assert.ok(fb.resolved_at);
  assert.equal(fb.resolution, "Swapped colour for color.");
  // The hold is gone; the dry run reaches the publish gate (scheduled) or a Zernio account this stack lacks, never a hold.
  const reached = [...r.scheduled, ...r.failed.filter((f) => !/hold|waiting for the fix/.test(f.error)).map((f) => f.id)];
  assert.deepEqual(reached, [ITEM], JSON.stringify(r));
  assert.ok(!r.skipped.some((s) => s.reason.startsWith("held")), JSON.stringify(r.skipped));
  // A second resolve is refused.
  await assert.rejects(resolveFixNote(sr, noteId, "again", { owner: () => signedIn("owner"), schedule: dryRunSchedule }), /already resolved/);
});

test("withdraw hides a staged final from /content and holds it, until a newer final is staged", async () => {
  await stagedPiece();
  const sr = admin();
  assert.deepEqual((await contentVisibility(sr, STORY)).shown, [STORY]);
  await assert.rejects(withdrawFinal(sr, STORY, "  "), /needs --note/);
  const dry = await withdrawFinal(sr, STORY, "new final rendering", { dryRun: true });
  assert.deepEqual(dry.visibility.shown, [STORY], "a dry run changes nothing");

  // Let the version timestamp settle strictly before the withdrawal.
  await new Promise((r) => setTimeout(r, 20));
  const w = await withdrawFinal(sr, STORY, "new final rendering");
  assert.deepEqual(w.visibility.hidden.map((h) => [h.storyId, h.reason]), [[STORY, "withdrawn"]]);
  // Approved or not, a withdrawn final is never scheduled.
  const owner = await signedIn("owner");
  assert.equal((await owner.rpc("gtm_decide_story_asset", { p_asset_id: COPY, p_channel: "linkedin", p_status: "approved", p_note: "", p_expected_sha256: digest(BODY), p_expected_revision: 1 })).error, null);
  const held = await autoSchedule(sr, { storyId: STORY, dryRun: true });
  assert.deepEqual(held.scheduled, []);
  assert.match(held.skipped[0]?.reason ?? "", /^held: not the final John directed: withdrawn by the agent: new final rendering/);

  // A new final is staged: it shows again.
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await sr.from("gtm_story_assets").update({ body: FIXED, sha256: digest(FIXED) }).eq("id", COPY)).error, null);
  assert.deepEqual((await contentVisibility(sr, STORY)).shown, [STORY]);
});

test("Request changes after approving with a note wins: the fix note is superseded, so it never re-approves the part (review #143 F3)", async () => {
  await stagedPiece();
  const sr = admin();
  const noteId = await approveWithNote("colour should be color");
  // John changes his mind: "Request changes instead" writes a plain note, sends the row back and supersedes the fix.
  const owner = await signedIn("owner");
  assert.equal((await owner.rpc("gtm_add_story_feedback", { p_asset_id: COPY, p_channel: "linkedin", p_body: "Actually rewrite the opening" })).error, null);
  assert.equal((await owner.rpc("gtm_decide_story_asset", { p_asset_id: COPY, p_channel: "linkedin", p_status: "rejected", p_note: "Actually rewrite the opening", p_expected_sha256: digest(BODY), p_expected_revision: 1 })).error, null);
  assert.deepEqual(await supersedeFixNotes(sr, STORY, [COPY], ["linkedin"], "Actually rewrite the opening"), [noteId]);
  // The agent restages the original fix and tries to resolve: refused, the part waits for John's review.
  assert.equal((await sr.from("gtm_story_assets").update({ body: FIXED, sha256: digest(FIXED) }).eq("id", COPY)).error, null);
  await assert.rejects(resolveFixNote(sr, noteId, "Swapped colour for color.", { owner: () => signedIn("owner"), schedule: dryRunSchedule }), /already resolved/);
  assert.notEqual((await sr.from("gtm_story_asset_channels").select("status").eq("asset_id", COPY).single()).data!.status, "approved");
  // Held no more by the fix, but nothing is approved, so nothing schedules.
  assert.deepEqual((await dryRunSchedule(sr, STORY)).scheduled, []);
});

test("a series note after an approve-with-note is not a change request: the fix still lands and re-approves (review #151 N1)", async () => {
  await stagedPiece();
  const sr = admin();
  const noteId = await approveWithNote("colour should be color");
  // addSeriesNote writes a plain, channel-less note on the piece's first asset; it rejects nothing.
  const owner = await signedIn("owner");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await owner.rpc("gtm_add_story_feedback", { p_asset_id: COPY, p_channel: null, p_body: "Series: keep the hooks short" })).error, null);
  assert.equal((await sr.from("gtm_story_assets").update({ body: FIXED, sha256: digest(FIXED) }).eq("id", COPY)).error, null);
  const r = await resolveFixNote(sr, noteId, "Swapped colour for color.", { owner: () => signedIn("owner"), schedule: dryRunSchedule });
  assert.deepEqual(r.reapproved, [`${COPY}:linkedin`]);
});
