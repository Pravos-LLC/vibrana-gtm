// The Substack card against the LOCAL stack: John approves a newsletter essay and its header in /content (the owner's own
// decisions through gtm_decide_story_asset), and the auto-schedule pass that every approval and the daily cron run makes
// no calendar item for it, slots nothing and sends nothing to Zernio. The LinkedIn post of the same piece is still
// evaluated as before. He publishes the newsletter by hand.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { admin, seed, signedIn } from "../support/seed.ts";
import { local } from "../support/local-supabase.ts";

const l = local();
Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: l.url, SUPABASE_SECRET_KEY: l.secretKey, GTM_CALENDAR_SOURCE: "db" });
const { autoSchedule } = await import("../../lib/auto-schedule.ts");
before(seed);

const STORY = "nl-fx-essay";
const ESSAY = "---\ntitle: \"Your AI bill is an org chart\"\nchannel: personal-substack\n---\n\n# Your AI bill is an org chart\n\n![Header](assets/hero.jpg)\n\nThe essay.\n";
const POST = "The LinkedIn post.\n";
const HEADER = Buffer.from("newsletter header bytes");
const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const KEY = `stories/${STORY}/${STORY}-header-${sha(HEADER).slice(0, 16)}.jpg`;
const PIECE = { storyId: STORY, title: "Tokenmaxxing", date: "2030-10-09", pillar: "perspective", kind: "text" };

async function essayPiece() {
  const sr = admin();
  await sr.from("gtm_content_items").delete().eq("story_id", STORY);
  await sr.from("gtm_stories").delete().eq("id", STORY);
  await sr.from("gtm_seasons").upsert({ id: "nl-season", title: "Newsletter season", description: "", starts_on: "2030-09-02", ends_on: "2030-12-13", pillars: ["perspective"] });
  assert.equal((await sr.storage.from("content-review").upload(KEY, HEADER, { contentType: "image/jpeg", upsert: true })).error, null);
  assert.equal((await sr.from("gtm_stories").insert({ id: STORY, title: "Tokenmaxxing", link_url: "https://example.com/tokenmaxxing", season_id: "nl-season" })).error, null);
  assert.equal((await sr.from("gtm_story_assets").insert([
    { id: `${STORY}-substack`, story_id: STORY, title: "Substack essay", kind: "copy", source: "story/substack.md", sha256: sha(ESSAY), body: ESSAY, metadata: {} },
    { id: `${STORY}-header`, story_id: STORY, title: "Header", kind: "image", source: "story/assets/hero.jpg", sha256: sha(HEADER), storage_path: KEY, stage: "final", metadata: {} },
    { id: `${STORY}-linkedin`, story_id: STORY, title: "LinkedIn post", kind: "copy", source: "story/linkedin.md", sha256: sha(POST), body: POST, metadata: {} },
  ])).error, null);
  assert.equal((await sr.from("gtm_story_asset_channels").insert([
    { asset_id: `${STORY}-substack`, channel: "newsletter" }, { asset_id: `${STORY}-header`, channel: "newsletter" }, { asset_id: `${STORY}-linkedin`, channel: "linkedin" },
  ])).error, null);
}

async function approve(asset: string, channel: string, digest: string) {
  const owner = await signedIn("owner");
  const r = await owner.rpc("gtm_decide_story_asset", { p_asset_id: asset, p_channel: channel, p_status: "approved", p_note: "", p_expected_sha256: digest, p_expected_revision: 1 });
  assert.equal(r.error, null, r.error?.message ?? "");
}

test("an approved newsletter essay and header make no calendar item and nothing goes to Zernio; the approved LinkedIn post is still evaluated", async () => {
  await essayPiece();
  await approve(`${STORY}-substack`, "newsletter", sha(ESSAY));
  await approve(`${STORY}-header`, "newsletter", sha(HEADER));
  const sr = admin();
  const rows = (await sr.from("gtm_story_asset_channels").select("asset_id,status").eq("channel", "newsletter").in("asset_id", [`${STORY}-substack`, `${STORY}-header`])).data ?? [];
  assert.deepEqual(rows.map((r) => r.status), ["approved", "approved"], "the newsletter really is approved");

  const dry = await autoSchedule(sr, { storyId: STORY, dryRun: true, pieces: [PIECE] });
  assert.deepEqual([dry.created ?? [], dry.scheduled, dry.failed], [[], [], []]);
  const real = await autoSchedule(sr, { storyId: STORY, pieces: [PIECE] });
  assert.deepEqual([real.created ?? [], real.scheduled, real.failed], [[], [], []]);
  assert.deepEqual((await sr.from("gtm_content_items").select("id").eq("story_id", STORY)).data, [], "no calendar item for the newsletter");

  assert.deepEqual(real.skipped.map((s) => [s.id, s.reason]), [[`${STORY}-newsletter`, "newsletter is published by hand"]], "reported, not dropped");

  // Control: the same pass does put the approved LinkedIn post of this piece on the calendar, as a text post (no media),
  // while the newsletter never becomes a calendar item.
  await approve(`${STORY}-linkedin`, "linkedin", sha(POST));
  const withPost = await autoSchedule(sr, { storyId: STORY, dryRun: true, pieces: [PIECE] });
  assert.deepEqual(withPost.created, [`${STORY}-linkedin`], JSON.stringify(withPost.skipped));
  assert.deepEqual(withPost.scheduled.map((s) => [s.id, s.date, s.time]), [[`${STORY}-linkedin`, "2030-10-09", "08:30"]]);
  assert.deepEqual([withPost.failed, withPost.skipped.map((s) => s.id)], [[], [`${STORY}-newsletter`]]);
});

test("a newsletter calendar item approved by hand is skipped as published by hand, never sent", async () => {
  await essayPiece();
  await approve(`${STORY}-substack`, "newsletter", sha(ESSAY));
  await approve(`${STORY}-header`, "newsletter", sha(HEADER));
  const sr = admin();
  const id = `${STORY}-newsletter`;
  assert.equal((await sr.from("gtm_content_items").insert({ id, week: 41, date: "2030-10-08", time: "09:00", pillar: "perspective", title: "Essay", format: "text", channels: ["newsletter"], status: "approved", story_id: STORY, story_assets: [`${STORY}-substack`, `${STORY}-header`], body: ESSAY, media: [KEY], copy_path: "story/substack.md", publication: "sample_author" }, { defaultToNull: false })).error, null);
  const r = await autoSchedule(sr, { storyId: STORY, pieces: [PIECE] });
  assert.deepEqual([r.scheduled, r.failed], [[], []]);
  assert.deepEqual(r.skipped.filter((s) => s.id === id).map((s) => s.reason), ["newsletter is published by hand"]);
  const row = (await sr.from("gtm_content_items").select("status,zernio_post_id").eq("id", id).single()).data!;
  assert.equal(row.zernio_post_id, null);
});
