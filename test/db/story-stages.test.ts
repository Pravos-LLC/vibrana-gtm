// Content stages, phase 1, against the LOCAL stack: the owner reads stage progress and the decision log but cannot write
// them; agents (service role) report progress through `gtm story progress`; there are no production gates to approve,
// and a cockpit gate is never approved from the terminal. Whatever the stage rows say, a piece whose
// media is short of final never reaches Zernio.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { admin, seed, signedIn } from "../support/seed.ts";
import { local } from "../support/local-supabase.ts";

const l = local();
Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: l.url, SUPABASE_SECRET_KEY: l.secretKey, GTM_CALENDAR_SOURCE: "db" });
const { recordProgress, loadPipeline } = await import("../../lib/stage-progress.ts");
const { autoSchedule } = await import("../../lib/auto-schedule.ts");
before(seed);

const STORY = "stages-fx-short";
const ITEM = `${STORY}-youtube`;
const BODY = "---\nyoutube_title: Their language\n---\n\nA short in its pipeline.\n";
const VIDEO = Buffer.from("rough cut v4");
const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const KEY = `stories/${STORY}/${STORY}-video-${sha(VIDEO).slice(0, 16)}.mp4`;

async function shortPiece() {
  const sr = admin();
  await sr.from("gtm_stories").delete().eq("id", STORY);
  await sr.from("gtm_content_items").delete().eq("id", ITEM);
  await sr.from("gtm_seasons").upsert({ id: "stages-season", title: "Stages season", description: "", starts_on: "2030-09-02", ends_on: "2030-12-13", pillars: ["proof"] });
  assert.equal((await sr.storage.from("content-review").upload(KEY, VIDEO, { contentType: "video/mp4", upsert: true })).error, null);
  assert.equal((await sr.from("gtm_stories").insert({ id: STORY, title: "Short", link_url: "https://example.com/short", pipeline: "short", series: "stages-series", third_party_who: "example_approver / Example Series" })).error, null);
  assert.equal((await sr.from("gtm_story_assets").insert([
    { id: `${STORY}-copy`, story_id: STORY, title: "YouTube text", kind: "copy", source: "posts/short/youtube.md", sha256: sha(BODY), body: BODY, metadata: {} },
    { id: `${STORY}-video`, story_id: STORY, title: "Video 9:16", kind: "video", source: "media/short.mp4", sha256: sha(VIDEO), storage_path: KEY, stage: "rough-cut", metadata: { label: "v4" } },
  ])).error, null);
  assert.equal((await sr.from("gtm_story_asset_channels").insert([{ asset_id: `${STORY}-copy`, channel: "youtube" }, { asset_id: `${STORY}-video`, channel: "youtube" }])).error, null);
  assert.equal((await sr.from("gtm_content_items").insert({ id: ITEM, week: 41, date: "2030-10-08", time: "17:00", pillar: "proof", title: "Short", format: "video", channels: ["youtube"], status: "drafted", story_id: STORY, story_assets: [`${STORY}-copy`, `${STORY}-video`], body: BODY, media: [KEY], copy_path: "posts/short/youtube.md" }, { defaultToNull: false })).error, null);
  assert.equal((await sr.from("gtm_story_stages").insert({ story_id: STORY, stage: "rough-cut", status: "review", actor: "stage" })).error, null);
}

test("the owner reads progress and decisions; only the service role writes them", async () => {
  await shortPiece();
  const owner = await signedIn("owner");
  assert.deepEqual((await owner.from("gtm_story_stages").select("stage,status").eq("story_id", STORY)).data, [{ stage: "rough-cut", status: "review" }]);
  assert.match((await owner.from("gtm_story_stages").insert({ story_id: STORY, stage: "broll", status: "done" })).error?.message ?? "no error", /permission denied/);
  assert.match((await owner.from("gtm_story_stage_decisions").insert({ story_id: STORY, stage: "rough-cut", party: "john", decision: "approved" })).error?.message ?? "no error", /permission denied/);
  const member = await signedIn("member");
  assert.deepEqual((await member.from("gtm_story_stages").select("stage").eq("story_id", STORY)).data, []);
});

test("gtm story progress: agent stages report progress and are never approved; a /content gate is never approved from the terminal", async () => {
  await shortPiece();
  const sr = admin();
  // The paper edit is agent work now (no storyboard or plan gates, John 2026-10-28): it is reported, never approved.
  await assert.rejects(recordProgress(sr, STORY, "paper-edit", "approved"), /agent work with no gate/);
  const view = await recordProgress(sr, STORY, "paper-edit", "done", "cut from keep.json");
  assert.equal(view.current?.stage.key, "rough-cut");
  assert.deepEqual((await sr.from("gtm_story_stage_decisions").select("stage").eq("story_id", STORY)).data, [], "an agent report is not a John decision");
  await assert.rejects(recordProgress(sr, STORY, "rough-cut", "approved", "looks good"), /John's gate in \/content; only he approves it there/);
  await assert.rejects(recordProgress(sr, STORY, "enhance-plan", "approved", "x"), /not in the short pipeline/);
  await assert.rejects(recordProgress(sr, STORY, "final", "done"), /approved per platform/);
  await assert.rejects(recordProgress(sr, STORY, "broll", "approved"), /agent work with no gate/);
  await assert.rejects(recordProgress(sr, STORY, "colour", "done"), /not in the short pipeline/);
  const working = await recordProgress(sr, STORY, "broll", "working", "7 inserts placed");
  assert.equal(working.stages.find((s) => s.stage.key === "broll")?.note, "7 inserts placed");
  const loaded = await loadPipeline(sr, STORY);
  assert.deepEqual([loaded.story.series, loaded.story.third_party_who, loaded.view.current?.stage.key], ["stages-series", "example_approver / Example Series", "rough-cut"]);
});

test("regression: a rough cut never reaches Zernio, even with every platform approved and every stage row approved", async () => {
  await shortPiece();
  const sr = admin();
  const owner = await signedIn("owner");
  for (const [asset, digest] of [[`${STORY}-copy`, sha(BODY)], [`${STORY}-video`, sha(VIDEO)]] as const) {
    const r = await owner.rpc("gtm_decide_story_asset", { p_asset_id: asset, p_channel: "youtube", p_status: "approved", p_note: "", p_expected_sha256: digest, p_expected_revision: 1 });
    // Phase 0 lets a rough cut be approved per platform; from phase 2 the database refuses it. Either way it must not schedule.
    if (r.error) assert.match(r.error.message, /approve the stage/);
  }
  for (const stage of ["paper-edit", "rough-cut", "enhance-plan"]) await sr.from("gtm_story_stages").upsert({ story_id: STORY, stage, status: "approved", actor: "test" });
  const result = await autoSchedule(sr, { storyId: STORY, dryRun: true });
  assert.deepEqual([result.scheduled, result.failed], [[], []]);
  // Phase 2 refuses the per-platform approval outright, so the rough cut is not even "ready"; earlier it was skipped.
  assert.ok(result.skipped.every((s) => /not final|held|publishing blocked/.test(s.reason)), JSON.stringify(result.skipped));
  const real = await autoSchedule(sr, { storyId: STORY });
  assert.deepEqual([real.scheduled, real.failed], [[], []]);
  const row = (await sr.from("gtm_content_items").select("status,zernio_post_id").eq("id", ITEM).single()).data!;
  assert.deepEqual([row.status, row.zernio_post_id], ["drafted", null]);
});
