// Content stages against the LOCAL stack (phase 0, amended by phase 2): a rough cut is approved as a stage, never per
// platform, and never scheduled; the final is approved once for every platform that posts it; a third party (example_approver)
// signs off on the final only, and until they do, nothing publishes. Every path that could reach Zernio is checked.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { admin, seed, signedIn } from "../support/seed.ts";
import { local } from "../support/local-supabase.ts";

const l = local();
Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: l.url, SUPABASE_SECRET_KEY: l.secretKey, GTM_CALENDAR_SOURCE: "db" });
const { autoSchedule, loadHolds } = await import("../../lib/auto-schedule.ts");
const { setStoryHold, storyState } = await import("../../lib/story-ops.ts");
const { sendCalendarItem } = await import("../../lib/publish-item.ts");
const { loadCalendarDb } = await import("../../lib/calendar-db.ts");
before(seed);

const STORY = "stage-fx-piece";
const ITEM = `${STORY}-youtube`;
const BODY = "---\nyoutube_title: Their language\n---\n\nA short a partner signs off on, once it is final.\n";
const ROUGH = Buffer.from("rough cut bytes");
const FINAL = Buffer.from("final cut bytes, B-roll and Motion");
const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const key = (b: Buffer) => `stories/${STORY}/${STORY}-video-${sha(b).slice(0, 16)}.mp4`;
const DATE = "2030-10-08"; // a Tuesday well ahead
type Owner = Awaited<ReturnType<typeof signedIn>>;

async function decide(owner: Owner, asset: string, digest: string, revision: number) {
  return owner.rpc("gtm_decide_story_asset", { p_asset_id: asset, p_channel: "youtube", p_status: "approved", p_note: "", p_expected_sha256: digest, p_expected_revision: revision });
}

/** A short at rough cut, its caption approved, held for example_approver, with a calendar item bound to the video. */
async function roughCut() {
  const sr = admin();
  await sr.from("gtm_stories").delete().eq("id", STORY);
  await sr.from("gtm_content_items").delete().eq("id", ITEM);
  await sr.from("gtm_seasons").upsert({ id: "stage-season", title: "Stage season", description: "", starts_on: "2030-09-02", ends_on: "2030-12-13", pillars: ["proof"] });
  for (const b of [ROUGH, FINAL]) assert.equal((await sr.storage.from("content-review").upload(key(b), b, { contentType: "video/mp4", upsert: true })).error, null);
  assert.equal((await sr.from("gtm_stories").insert({ id: STORY, title: "Rough cut piece", link_url: "https://example.com/rough", pipeline: "short", third_party_who: "example_approver / Example Series" })).error, null);
  assert.equal((await sr.from("gtm_story_assets").insert([
    { id: `${STORY}-copy`, story_id: STORY, title: "YouTube text", kind: "copy", source: "posts/rough/youtube.md", sha256: sha(BODY), body: BODY, metadata: {} },
    { id: `${STORY}-video`, story_id: STORY, title: "Video 9:16", kind: "video", source: "media/rough.mp4", sha256: sha(ROUGH), storage_path: key(ROUGH), stage: "rough-cut", metadata: {} },
  ])).error, null);
  assert.equal((await sr.from("gtm_story_asset_channels").insert([{ asset_id: `${STORY}-copy`, channel: "youtube" }, { asset_id: `${STORY}-video`, channel: "youtube" }])).error, null);
  assert.equal((await sr.from("gtm_story_stages").insert([{ story_id: STORY, stage: "paper-edit", status: "approved" }, { story_id: STORY, stage: "rough-cut", status: "review" }])).error, null);
  assert.equal((await sr.from("gtm_content_items").insert({ id: ITEM, week: 41, date: DATE, time: "17:00", pillar: "proof", title: "Rough cut piece", format: "video", channels: ["youtube"], status: "drafted", story_id: STORY, story_assets: [`${STORY}-copy`, `${STORY}-video`], body: BODY, media: [key(ROUGH)], copy_path: "posts/rough/youtube.md" }, { defaultToNull: false })).error, null);
  const owner = await signedIn("owner");
  assert.equal((await decide(owner, `${STORY}-copy`, sha(BODY), 1)).error, null, "text has its own lane");
  assert.equal((await owner.rpc("gtm_set_story_hold", { p_story_id: STORY, p_held: true, p_who: "example_approver / Example Series", p_note: "" })).error, null);
  return owner;
}

async function stageFinal() {
  const sr = admin();
  assert.equal((await sr.from("gtm_story_assets").update({ sha256: sha(FINAL), storage_path: key(FINAL), stage: "final" }).eq("id", `${STORY}-video`)).error, null);
  assert.equal((await sr.from("gtm_content_items").update({ media: [key(FINAL)] }).eq("id", ITEM)).error, null);
}

/** The item went nowhere: never scheduled, never sent. */
async function untouched() {
  const row = (await admin().from("gtm_content_items").select("status,zernio_post_id").eq("id", ITEM).single()).data!;
  assert.deepEqual([row.status, row.zernio_post_id], ["drafted", null]);
}

test("a rough cut is approved as a stage: never per platform, never scheduled, never released to the third party", async () => {
  const owner = await roughCut();
  const sr = admin();
  assert.match((await decide(owner, `${STORY}-video`, sha(ROUGH), 1)).error?.message ?? "no error", /rough cut \(not the final\); approve the stage/);
  const approved = await owner.rpc("gtm_decide_story_stage", { p_story_id: STORY, p_stage: "rough-cut", p_decision: "approved", p_note: "", p_expected: [{ asset_id: `${STORY}-video`, sha256: sha(ROUGH), revision: 1 }], p_reset_stages: [] });
  assert.equal(approved.error, null, String(approved.error?.message));
  assert.equal((await sr.from("gtm_story_asset_channels").select("status").eq("asset_id", `${STORY}-video`).single()).data!.status, "pending", "a stage approval is not a platform approval");
  assert.equal((await storyState(sr, STORY)).allApproved, false);

  // example_approver sees the final only: the release is refused while the platform media is a rough cut, in the cockpit and the CLI.
  assert.match((await owner.rpc("gtm_set_story_hold", { p_story_id: STORY, p_held: false, p_who: null, p_note: null })).error?.message ?? "no error", /sees the final only/);
  await assert.rejects(setStoryHold(sr, STORY, null), /example_approver \/ Example Series sees the final only, and Video 9:16 is at stage rough-cut/);

  for (const dryRun of [true, false]) {
    const r = await autoSchedule(sr, { storyId: STORY, dryRun });
    assert.deepEqual([r.scheduled, r.failed], [[], []], `dryRun ${dryRun}`);
  }
  await untouched();
  const cal = await loadCalendarDb(sr);
  await assert.rejects(sendCalendarItem({ ...cal, items: cal.items.map((i) => (i.id === ITEM ? { ...i, status: "approved" as const } : i)) }, ITEM, { mode: "schedule", dry: true, db: sr }), /on hold|not final|not approved/);
});

test("the final is approved per platform; until the third party signs off it never publishes; their sign-off binds to the final's bytes", async () => {
  const owner = await roughCut();
  const sr = admin();
  await stageFinal();
  assert.equal((await decide(owner, `${STORY}-video`, sha(FINAL), 2)).error, null, "John approves the final");
  assert.equal((await storyState(sr, STORY)).allApproved, true);

  // Held for example_approver: skipped by auto-schedule, refused by the publish gate.
  const held = await autoSchedule(sr, { storyId: STORY, dryRun: true });
  assert.deepEqual([held.scheduled, held.failed], [[], []]);
  assert.deepEqual(held.skipped, [{ id: ITEM, storyId: STORY, reason: "held: publishing blocked until example_approver / Example Series approves the final" }]);
  const cal = await loadCalendarDb(sr);
  await assert.rejects(sendCalendarItem({ ...cal, items: cal.items.map((i) => (i.id === ITEM ? { ...i, status: "approved" as const } : i)) }, ITEM, { mode: "schedule", dry: true, db: sr }), /publishing blocked until example_approver \/ Example Series approves the final/);

  // Clearing held_at by hand is not enough: the gate reads the decision log, not the hold column.
  assert.equal((await sr.from("gtm_stories").update({ held_at: null, held_by: null, hold_who: null, hold_note: "" }).eq("id", STORY)).error, null);
  assert.deepEqual((await loadHolds(sr, STORY)).map((h) => [h.kind, h.finalStaged]), [["third_party", true]]);
  const stillGated = await autoSchedule(sr, { storyId: STORY, dryRun: true });
  assert.deepEqual(stillGated.scheduled, []);
  await untouched();

  // "example_approver approved the final" (the owner's button): logged against the final's bytes; now it reaches the publish gate.
  assert.equal((await owner.rpc("gtm_set_story_hold", { p_story_id: STORY, p_held: false, p_who: null, p_note: "example_approver signed off by email" })).error, null);
  const decision = (await sr.from("gtm_story_stage_decisions").select("party,who,stage,assets").eq("story_id", STORY).eq("party", "third_party").single()).data!;
  assert.deepEqual(decision, { party: "third_party", who: "example_approver / Example Series", stage: "final", assets: [{ asset_id: `${STORY}-video`, sha256: sha(FINAL), revision: 2 }] });
  assert.deepEqual(await loadHolds(sr, STORY), []);
  const ready = await autoSchedule(sr, { storyId: STORY, dryRun: true });
  const reached = [...ready.scheduled.map((s) => s.id), ...ready.failed.filter((f) => !/not final|held|blocked/.test(f.error)).map((f) => f.id)];
  assert.deepEqual(reached, [ITEM], JSON.stringify(ready));

  // A new final version re-opens the gate: example_approver signed off on other bytes.
  assert.equal((await sr.from("gtm_story_assets").update({ sha256: sha("v2 final"), storage_path: key(Buffer.from("v2 final")) }).eq("id", `${STORY}-video`)).error, null);
  assert.deepEqual((await loadHolds(sr, STORY)).map((h) => h.kind), ["third_party"]);
});

test("Send back to rough cut from the final withdraws the final's platform approvals, so nothing goes out meanwhile", async () => {
  const owner = await roughCut();
  const sr = admin();
  await stageFinal();
  assert.equal((await decide(owner, `${STORY}-video`, sha(FINAL), 2)).error, null);
  const back = await owner.rpc("gtm_decide_story_stage", { p_story_id: STORY, p_stage: "rough-cut", p_decision: "reopened", p_note: "Cut the heck yeah", p_expected: [{ asset_id: `${STORY}-video`, sha256: sha(FINAL), revision: 2 }], p_reset_stages: ["enhance-plan", "broll", "motion", "finish"] });
  assert.equal(back.error, null, String(back.error?.message));
  assert.equal((await sr.from("gtm_story_asset_channels").select("status").eq("asset_id", `${STORY}-video`).single()).data!.status, "pending");
  assert.equal((await sr.from("gtm_story_stages").select("status").eq("story_id", STORY).eq("stage", "rough-cut").single()).data!.status, "changes");
  assert.equal((await storyState(sr, STORY)).allApproved, false);
  await setStoryHold(sr, STORY, null, { note: "test" });
  const r = await autoSchedule(sr, { storyId: STORY, dryRun: true });
  assert.deepEqual([r.scheduled, r.failed], [[], []]);
  await untouched();
});

test("gtm story remove-asset removes a production asset and nothing else; an approved post is refused", async () => {
  const owner = await roughCut();
  const sr = admin();
  assert.equal((await sr.from("gtm_story_assets").insert({ id: `${STORY}-enhance-plan`, story_id: STORY, title: "B-roll + Motion plan", kind: "image", source: "plan.png", sha256: "f".repeat(64), storage_path: `stories/${STORY}/plan.png`, metadata: {} })).error, null);
  assert.equal((await sr.from("gtm_story_asset_channels").insert({ asset_id: `${STORY}-enhance-plan`, channel: "plan" })).error, null);
  const { removeStoryAsset } = await import("../../lib/story-ops.ts");
  const before = (await sr.from("gtm_story_asset_channels").select("asset_id,channel,status").like("asset_id", `${STORY}%`).neq("channel", "plan").order("asset_id")).data;
  assert.equal((await removeStoryAsset(sr, `${STORY}-enhance-plan`, { dryRun: true })).dryRun, true);
  assert.ok((await sr.from("gtm_story_assets").select("id").eq("id", `${STORY}-enhance-plan`).maybeSingle()).data, "a dry run removes nothing");
  await removeStoryAsset(sr, `${STORY}-enhance-plan`);
  assert.equal((await sr.from("gtm_story_assets").select("id").eq("id", `${STORY}-enhance-plan`).maybeSingle()).data, null);
  assert.deepEqual((await sr.from("gtm_story_asset_channels").select("asset_id,channel,status").like("asset_id", `${STORY}%`).order("asset_id")).data, before, "every other approval is untouched");
  await assert.rejects(removeStoryAsset(sr, `${STORY}-copy`), /approved for youtube; it is a post/);
  void owner;
});

test("drop-channel takes a Story off one platform: its rows and its own caption go, every other platform is untouched", async () => {
  const owner = await roughCut();
  const sr = admin();
  const story = `${STORY}-drop`;
  await sr.from("gtm_stories").delete().eq("id", story);
  assert.equal((await sr.from("gtm_stories").insert({ id: story, title: "Two-platform deck", link_url: "https://example.com/deck" })).error, null);
  assert.equal((await sr.from("gtm_story_assets").insert([
    { id: `${story}-slide-01`, story_id: story, title: "Slide 1", kind: "image", source: "s1.png", sha256: "a".repeat(64), storage_path: `stories/${story}/s1.png`, metadata: {} },
    { id: `${story}-instagram`, story_id: story, title: "IG caption", kind: "copy", source: "ig.md", sha256: "b".repeat(64), body: "caption", metadata: {} },
    { id: `${story}-linkedin`, story_id: story, title: "LI post", kind: "copy", source: "li.md", sha256: "c".repeat(64), body: "post", metadata: {} },
  ])).error, null);
  assert.equal((await sr.from("gtm_story_asset_channels").insert([
    { asset_id: `${story}-slide-01`, channel: "linkedin" }, { asset_id: `${story}-slide-01`, channel: "instagram" },
    { asset_id: `${story}-instagram`, channel: "instagram" }, { asset_id: `${story}-linkedin`, channel: "linkedin" },
  ])).error, null);
  const { dropStoryChannel } = await import("../../lib/story-ops.ts");
  const li = async () => (await sr.from("gtm_story_asset_channels").select("asset_id,channel,status").like("asset_id", `${story}%`).eq("channel", "linkedin").order("asset_id")).data;
  const liBefore = await li();
  const dry = await dropStoryChannel(sr, story, "instagram", { dryRun: true });
  assert.deepEqual([dry.rows.sort(), dry.removedAssets], [[`${story}-instagram`, `${story}-slide-01`], [`${story}-instagram`]]);
  assert.equal((await sr.from("gtm_story_asset_channels").select("asset_id").like("asset_id", `${story}%`).eq("channel", "instagram")).data!.length, 2, "a dry run removes nothing");
  await dropStoryChannel(sr, story, "instagram");
  assert.equal((await sr.from("gtm_story_asset_channels").select("asset_id").like("asset_id", `${story}%`).eq("channel", "instagram")).data!.length, 0);
  assert.equal((await sr.from("gtm_story_assets").select("id").eq("id", `${story}-instagram`).maybeSingle()).data, null, "the IG-only caption goes");
  assert.ok((await sr.from("gtm_story_assets").select("id").eq("id", `${story}-slide-01`).maybeSingle()).data, "shared slides stay");
  assert.deepEqual(await li(), liBefore, "LinkedIn rows are untouched");
  await assert.rejects(dropStoryChannel(sr, story, "instagram"), /nothing on instagram/);
  // An approval is John's to undo, and a calendar item still posting there must be unscheduled first.
  await assert.rejects(dropStoryChannel(sr, STORY, "youtube"), /approved for youtube|posts stage-fx-piece on youtube/);
  await sr.from("gtm_stories").delete().eq("id", story);
  void owner;
});

test("regression (phase 3): a version's description (changes, jump points, input hashes) never makes a rough cut schedulable or resets a final", async () => {
  const owner = await roughCut();
  const sr = admin();
  const meta = { changes: "B-roll", review_points: [{ t: 9, label: "B4" }], inputs: { keep: "a".repeat(64) } };
  assert.equal((await sr.from("gtm_story_assets").update({ metadata: meta }).eq("id", `${STORY}-video`)).error, null);
  const version = (await sr.from("gtm_story_asset_versions").select("changes,metadata").eq("asset_id", `${STORY}-video`).eq("revision", 1).single()).data!;
  assert.deepEqual(version, { changes: "B-roll", metadata: { review_points: [{ t: 9, label: "B4" }], inputs: { keep: "a".repeat(64) } } });
  const rough = await autoSchedule(sr, { storyId: STORY, dryRun: true });
  assert.deepEqual([rough.scheduled, rough.failed], [[], []]);
  await stageFinal();
  assert.equal((await decide(owner, `${STORY}-video`, sha(FINAL), 2)).error, null);
  assert.equal((await sr.from("gtm_story_assets").update({ metadata: { ...meta, changes: "B-roll, Motion" } }).eq("id", `${STORY}-video`)).error, null);
  assert.equal((await sr.from("gtm_story_asset_channels").select("status").eq("asset_id", `${STORY}-video`).single()).data!.status, "approved", "a description is not new bytes");
  const held = await autoSchedule(sr, { storyId: STORY, dryRun: true });
  assert.deepEqual(held.scheduled, [], "still held for example_approver");
  await untouched();
});
