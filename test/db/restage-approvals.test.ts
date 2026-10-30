// Restaging against the LOCAL stack: an approval follows the bytes, not the storage key. On 2026-10-13 a restage moved
// s1-14's and s1-16's storage keys on identical bytes and silently reset John's approvals. Identical bytes (and
// identical text) now keep the approval under the new key and revision, calendar rows follow the key, and the publish
// gate still passes; changed bytes or text reset it as before.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admin, seed, signedIn } from "../support/seed.ts";
import { local } from "../support/local-supabase.ts";
import { mp4 } from "../support/mp4.ts";

const l = local();
Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: l.url, SUPABASE_SECRET_KEY: l.secretKey, GTM_CALENDAR_SOURCE: "db" });
const { stageStory, checkStoryApprovalDb } = await import("../../lib/story.ts");
const { loadCalendarDb } = await import("../../lib/calendar-db.ts");
before(seed);

const STORY = "restage-fx-piece";
const VIDEO = `${STORY}-video`;
const CAPTION = `${STORY}-instagram`;
const ITEM = `${STORY}-instagram`;
const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const keyOf = (b: Buffer) => `stories/${STORY}/${VIDEO}-${sha(b).slice(0, 16)}.mp4`;
const LEGACY = `stories/${STORY}/${VIDEO}-legacy-name.mp4`;
const CUT = mp4({ payload: "the approved cut" });
const TEXT = "The caption John approved.\n";

const dir = mkdtempSync(join(tmpdir(), "gtm-restage-"));
const previous = process.env.GTM_WORKSPACE;
process.env.GTM_WORKSPACE = dir;
after(() => {
  if (previous === undefined) delete process.env.GTM_WORKSPACE;
  else process.env.GTM_WORKSPACE = previous;
  rmSync(dir, { recursive: true, force: true });
});
const cal = { path: join(dir, "calendar.yaml"), timezone: "Europe/Berlin", accounts: {}, manual: [], items: [] };
const manifest = join(dir, "story.yaml");

function write(video: Buffer, caption: string, captionTitle = "Instagram caption") {
  writeFileSync(join(dir, "video.mp4"), video);
  writeFileSync(join(dir, "instagram.md"), caption);
  writeFileSync(manifest, [
    `id: ${STORY}`, "title: Restage piece", "link: https://example.com/restage", "assets:",
    `  - { id: ${VIDEO}, title: "Video 9:16", kind: video, source: video.mp4, channels: [instagram, linkedin] }`,
    `  - { id: ${CAPTION}, title: "${captionTitle}", kind: copy, source: instagram.md, channels: [instagram] }`, "",
  ].join("\n"));
}

const approvals = async () => Object.fromEntries(((await admin().from("gtm_story_asset_channels").select("asset_id,channel,status,approved_sha256").in("asset_id", [VIDEO, CAPTION]).order("asset_id").order("channel")).data ?? [])
  .map((r) => [`${r.asset_id === VIDEO ? "video" : "caption"}:${r.channel}`, r.status === "approved" ? r.approved_sha256 : r.status]));
const asset = async (id: string) => (await admin().from("gtm_story_assets").select("sha256,revision,storage_path").eq("id", id).single()).data!;

/** Staged, then the video's key rewritten under another name (as on s1-14), John's approvals given, a drafted item on the old key. */
async function approvedUnderLegacyKey() {
  const sr = admin();
  await sr.from("gtm_content_items").delete().eq("id", ITEM);
  await sr.from("gtm_stories").delete().eq("id", STORY);
  write(CUT, TEXT);
  await stageStory(sr, manifest, cal);
  assert.equal((await sr.storage.from("content-review").upload(LEGACY, CUT, { contentType: "video/mp4", upsert: true })).error, null);
  assert.equal((await sr.from("gtm_story_assets").update({ storage_path: LEGACY }).eq("id", VIDEO)).error, null);
  assert.equal((await sr.from("gtm_content_items").insert({ id: ITEM, week: 41, date: "2030-10-08", time: "17:00", pillar: "proof", title: "Restage piece", format: "video", channels: ["instagram"], status: "drafted", story_id: STORY, story_assets: [CAPTION, VIDEO], body: TEXT, media: [LEGACY], copy_path: "instagram.md" }, { defaultToNull: false })).error, null);
  const owner = await signedIn("owner");
  const v = await asset(VIDEO);
  const c = await asset(CAPTION);
  for (const [id, channel, a] of [[VIDEO, "instagram", v], [VIDEO, "linkedin", v], [CAPTION, "instagram", c]] as const) {
    const r = await owner.rpc("gtm_decide_story_asset", { p_asset_id: id, p_channel: channel, p_status: "approved", p_note: "", p_expected_sha256: a.sha256, p_expected_revision: a.revision });
    assert.equal(r.error, null, String(r.error?.message));
  }
  assert.deepEqual(await approvals(), { "caption:instagram": sha(TEXT), "video:instagram": sha(CUT), "video:linkedin": sha(CUT) });
  return v.revision;
}

test("a restage with identical bytes moves the key and keeps John's approvals; the calendar row and the publish gate follow", async () => {
  const revision = await approvedUnderLegacyKey();
  const sr = admin();
  write(CUT, TEXT, "Instagram caption, renamed"); // same bytes, same text; only the caption's display title changes
  const r = await stageStory(sr, manifest, cal) as Record<string, unknown>;

  const v = await asset(VIDEO);
  assert.equal(v.storage_path, keyOf(CUT), "the key moved to the content-addressed one");
  assert.equal(v.revision, revision + 1, "a moved key is a new revision");
  assert.deepEqual(await approvals(), { "caption:instagram": sha(TEXT), "video:instagram": sha(CUT), "video:linkedin": sha(CUT) },
    "identical bytes and identical text keep every approval");
  assert.deepEqual(r.moved_keys, [{ asset: VIDEO, from: LEGACY, to: keyOf(CUT) }]);
  assert.deepEqual((r.approvals_kept as string[]).sort(), [`${VIDEO}:instagram`, `${VIDEO}:linkedin`]);
  assert.deepEqual(r.rebound_items, [ITEM]);

  const row = (await sr.from("gtm_content_items").select("media,status").eq("id", ITEM).single()).data!;
  assert.deepEqual(row, { media: [keyOf(CUT)], status: "drafted" }, "the calendar row points at the new key");
  // The old key is never deleted, so anything already holding it (a Zernio upload, a scheduled row) stays valid.
  assert.equal((await sr.storage.from("content-review").download(LEGACY)).error, null);
  const item = (await loadCalendarDb(sr)).items.find((i) => i.id === ITEM)!;
  const gate = await checkStoryApprovalDb(sr, item);
  assert.equal(gate.copyText, TEXT);
  assert.deepEqual([...gate.bytes.keys()], [keyOf(CUT)], "the publish gate passes on the new key");
});

test("a restage with changed bytes or changed text resets the approval, as before", async () => {
  await approvedUnderLegacyKey();
  const sr = admin();
  const recut = mp4({ payload: "a different cut" });
  write(recut, "The caption, edited.\n");
  const r = await stageStory(sr, manifest, cal) as Record<string, unknown>;
  assert.equal((await asset(VIDEO)).storage_path, keyOf(recut));
  assert.deepEqual(await approvals(), { "caption:instagram": "pending", "video:instagram": "pending", "video:linkedin": "pending" });
  assert.equal(r.moved_keys, undefined, "new bytes are not a key move");
  assert.deepEqual((await sr.from("gtm_content_items").select("media").eq("id", ITEM).single()).data!.media, [keyOf(recut)]);
  const item = (await loadCalendarDb(sr)).items.find((i) => i.id === ITEM)!;
  await assert.rejects(checkStoryApprovalDb(sr, item), /not approved for instagram/);
});
