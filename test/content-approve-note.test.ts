// Approve with note, what /content shows, and findings that link to their piece (John, 2026-10-13).
import test from "node:test";
import assert from "node:assert/strict";
import { coveredByFixNote, encodeFixNote, encodeFormatsNote, FIX_MARKER, FORMATS_MARKER, fixLanded, noteAssets, noteCovers, noteText, parseFixNote, parseFormatsNote, videoBase } from "../lib/approve-note";
import { channelsSentBack, finalStagedAt, hiddenFromContent, partsSentBack, type VisibilityInput } from "../lib/content-visibility";
import { findingHref } from "../lib/finding-link";
import { initialPartState, partReducer } from "../lib/review-state";
import { holdReason, planSlots } from "../lib/auto-schedule";
import type { Item } from "../lib/calendar";

test("an approve-with-note round-trips: marker line, part, platforms, assets, John's words", () => {
  const body = encodeFixNote({ part: "media", channels: ["instagram", "youtube"], assets: ["s1-07-x-video-9x16"] }, "  Lower the music under the voice.\nKeep the end card.  ");
  assert.ok(body.startsWith(FIX_MARKER));
  assert.deepEqual(parseFixNote(body), { part: "media", channels: ["instagram", "youtube"], assets: ["s1-07-x-video-9x16"], note: "Lower the music under the voice.\nKeep the end card." });
  assert.deepEqual(noteText(body), { text: "Lower the music under the voice.\nKeep the end card.", approvedWithNote: true });
});

test("an ordinary note is not an approve-with-note, and a damaged header is not either", () => {
  assert.equal(parseFixNote("The hook is too long."), null);
  assert.equal(parseFixNote(`${FIX_MARKER} part=text\nmissing ids`), null);
  assert.equal(parseFixNote(null), null);
  assert.deepEqual(noteText("The hook is too long."), { text: "The hook is too long.", approvedWithNote: false });
});

test("encodeFixNote refuses an empty note, an oversized one and ids that could break the header", () => {
  assert.throws(() => encodeFixNote({ part: "text", channels: ["linkedin"], assets: ["a"] }, "   "), /Write the note/);
  assert.throws(() => encodeFixNote({ part: "text", channels: ["linkedin"], assets: ["a"] }, "x".repeat(4001)), /under 4000/);
  assert.throws(() => encodeFixNote({ part: "text", channels: ["linked in"], assets: ["a"] }, "ok"), /invalid id/);
  assert.throws(() => encodeFixNote({ part: "text", channels: [], assets: ["a"] }, "ok"), /Nothing to approve/);
});

test("a note covers exactly its assets on its platforms", () => {
  const notes = [{ assets: ["v1", "v2"], channels: ["instagram"] }];
  assert.equal(coveredByFixNote(notes, "v1", "instagram"), true);
  assert.equal(coveredByFixNote(notes, "v1", "linkedin"), false);
  assert.equal(coveredByFixNote(notes, "c1", "instagram"), false);
});

test("the fix has landed only when a version of the part was staged after John's note", () => {
  const note = { assets: ["v1"], createdAt: "2026-10-13T08:00:00.000Z" };
  assert.equal(fixLanded(note, [{ asset_id: "v1", created_at: "2026-10-12T08:00:00.000Z" }]), false);
  assert.equal(fixLanded(note, [{ asset_id: "other", created_at: "2026-10-13T09:00:00.000Z" }]), false);
  assert.equal(fixLanded(note, [{ asset_id: "v1", created_at: "2026-10-13T09:00:00.000Z" }]), true);
});

test("approve with note: the part waits for the fix and keeps the note open for the agent", () => {
  const note = { id: "n1", asset_id: "c", channel: "linkedin", body: encodeFixNote({ part: "text", channels: ["linkedin"], assets: ["c"] }, "color, not colour"), created_at: "2026-10-13T08:00:00Z", resolved_at: null, resolution: "", revision: 1 };
  const next = partReducer(initialPartState({ status: "pending", notes: [] }), { type: "approveWithNote", note });
  assert.equal(next.status, "pending");
  assert.deepEqual(next.notes.map((n) => n.id), ["n1"]);
});

test("auto-schedule skips a piece held for an unapplied note or a reworked final, and says why", () => {
  const item: Item = { id: "s1-07-x-linkedin", week: 41, date: "2030-10-08", time: "08:30", pillar: "proof", title: "x", format: "text", channels: ["linkedin"], status: "approved", story_id: "s1-07-x" } as Item;
  const fix = { storyId: "s1-07-x", who: "", note: "John approved it with a note (n1)", heldAt: null, kind: "fix" as const, finalStaged: true };
  const r = planSlots({ items: [item], ready: [item], now: new Date("2030-10-01T00:00:00Z"), timeZone: "Asia/Makassar", holds: [fix] });
  assert.equal(r.slotted.length, 0);
  assert.match(r.skipped[0].reason, /^held: waiting for the fix: John approved it with a note/);
  assert.match(holdReason({ ...fix, kind: "rework", note: "withdrawn by the agent" }), /^not the final John directed: withdrawn/);
  // Nothing held: the same item takes its planned slot.
  assert.equal(planSlots({ items: [item], ready: [item], now: new Date("2030-10-01T00:00:00Z"), timeZone: "Asia/Makassar", holds: [] }).slotted.length, 1);
});

// A Meridian-shaped piece: three final cuts staged on Oct 12, three captions.
const base = (): VisibilityInput => ({
  storyId: "s1-20-sample-piece-20",
  finalStaged: true,
  assets: [
    { id: "v45", kind: "video", stage: "final", revision: 1 }, { id: "v916", kind: "video", stage: "final", revision: 2 },
    { id: "li", kind: "copy", stage: null, revision: 1 }, { id: "ig", kind: "copy", stage: null, revision: 1 },
  ],
  rows: [
    { asset_id: "v45", channel: "linkedin", status: "pending" }, { asset_id: "li", channel: "linkedin", status: "pending" },
    { asset_id: "v916", channel: "instagram", status: "pending" }, { asset_id: "ig", channel: "instagram", status: "pending" },
  ],
  versions: [
    { asset_id: "v45", revision: 1, created_at: "2026-10-12T11:42:03Z" },
    { asset_id: "v916", revision: 1, created_at: "2026-10-12T11:42:11Z" }, { asset_id: "v916", revision: 2, created_at: "2026-10-12T11:56:37Z" },
    { asset_id: "li", revision: 1, created_at: "2026-10-13T09:00:00Z" }, { asset_id: "ig", revision: 1, created_at: "2026-10-12T11:42:19Z" },
  ],
  stages: [],
  decisions: [{ stage: "storyboard", party: "john", decision: "changes", decided_at: "2026-10-13T04:55:56Z" }],
});

test("the final's staging time is its newest current media version (text only when there is no media)", () => {
  assert.equal(finalStagedAt(base()), "2026-10-12T11:56:37Z");
  const textOnly = { ...base(), assets: base().assets.filter((a) => a.kind === "copy"), rows: base().rows.filter((r) => r.asset_id === "li" || r.asset_id === "ig") };
  assert.equal(finalStagedAt(textOnly), "2026-10-13T09:00:00Z");
});

test("a final staged before John's later storyboard approval is stale and hidden, until a final made after it lands", () => {
  const input = base();
  assert.equal(hiddenFromContent(input, ["linkedin", "instagram"]), null, "a storyboard sent back is not an approval");
  input.decisions.push({ stage: "storyboard", party: "john", decision: "approved", decided_at: "2026-10-13T06:53:08Z" });
  const h = hiddenFromContent(input, ["linkedin", "instagram"]);
  assert.equal(h?.reason, "stale");
  assert.match(h!.detail, /before you approved the storyboard/);
  // The new final lands: the 9:16 is restaged after the approval.
  input.assets[1].revision = 3;
  input.versions.push({ asset_id: "v916", revision: 3, created_at: "2026-10-13T10:00:00Z" });
  assert.equal(hiddenFromContent(input, ["linkedin", "instagram"]), null);
});

test("a rough-cut approval bound to an older revision of the final's own file is behind it, whatever the clock says", () => {
  const input = base();
  input.decisions.push({ stage: "rough-cut", party: "john", decision: "approved", decided_at: "2026-10-13T06:53:08Z", assets: [{ asset_id: "v916", sha256: "x", revision: 1 }] });
  assert.equal(hiddenFromContent(input, ["linkedin"]), null);
  input.decisions.push({ stage: "rough-cut", party: "john", decision: "approved", decided_at: "2026-10-13T07:00:00Z", assets: [{ asset_id: "v916", sha256: "y", revision: 2 }] });
  assert.equal(hiddenFromContent(input, ["linkedin"])?.reason, "stale", "an approval of the very bytes staged as final, after them, is not behind it");
});

test("a third party's or an agent's approval never makes a final stale; only John's do", () => {
  const input = base();
  input.decisions.push({ stage: "storyboard", party: "third_party", decision: "approved", decided_at: "2026-10-13T06:53:08Z" });
  assert.equal(hiddenFromContent(input, ["linkedin"]), null);
});

test("a withdrawn final is hidden until a newer final is staged", () => {
  const input = base();
  input.stages.push({ stage: "final", status: "working", note: "new final rendering", updated_at: "2026-10-13T08:00:00Z" });
  assert.equal(hiddenFromContent(input, ["linkedin"])?.reason, "withdrawn");
  input.versions.push({ asset_id: "v45", revision: 2, created_at: "2026-10-13T12:00:00Z" });
  input.assets[0].revision = 2;
  assert.equal(hiddenFromContent(input, ["linkedin"]), null);
});

test("a platform sent back is left out on its own; the piece goes only when every card was sent back", () => {
  const input = base();
  input.rows[0].status = "rejected";
  input.rows[1].status = "rejected";
  assert.deepEqual([...channelsSentBack(input)], ["linkedin"]);
  assert.equal(hiddenFromContent(input, ["linkedin", "instagram"]), null);
  input.rows[2].status = "rejected";
  input.rows[3].status = "rejected";
  assert.equal(hiddenFromContent(input, ["linkedin", "instagram"])?.reason, "changes");
});

test("media sent back leaves on its own; its platforms' text stays to review and edit", () => {
  const input = base();
  input.rows[0].status = "rejected";
  input.rows[2].status = "rejected";
  assert.deepEqual([...partsSentBack(input)].sort(), ["v45|linkedin", "v916|instagram"]);
  assert.equal(channelsSentBack(input).size, 0, "the text is still waiting, so no card is left out");
  assert.equal(hiddenFromContent(input, ["linkedin", "instagram"]), null);
});

test("a rough cut under review is never hidden by these rules", () => {
  const input = { ...base(), finalStaged: false };
  input.rows[1].status = "rejected";
  input.decisions.push({ stage: "storyboard", party: "john", decision: "approved", decided_at: "2026-10-13T06:53:08Z" });
  assert.equal(hiddenFromContent(input, ["linkedin"]), null);
  assert.equal(channelsSentBack(input).size, 0);
  assert.equal(partsSentBack(input).size, 0);
});

test("a finding opens its piece on the platform tab it is about", () => {
  assert.equal(findingHref({ storyId: "s1-07-ai-tools", platform: "linkedin" }), "/content?piece=s1-07-ai-tools&channel=linkedin#s1-07-ai-tools-platforms");
  assert.equal(findingHref({ storyId: "s1-07-ai-tools" }), "/content?piece=s1-07-ai-tools#s1-07-ai-tools");
  assert.equal(findingHref({ platform: "linkedin" }), null, "a season-wide finding has nowhere to go");
  assert.equal(findingHref({ storyId: "s1-07", platform: "youtube" }, "/dev-fixtures/content"), "/dev-fixtures/content?piece=s1-07&channel=youtube#s1-07-platforms");
});

test("a note for all formats of a video is stored once, names every format, and reads as John's words", () => {
  const ids = ["s1-20-sample-piece-20-video-9x16-youtube", "s1-20-sample-piece-20-video-4x5", "s1-20-sample-piece-20-video-9x16"];
  const body = encodeFormatsNote(ids, "  Center the overnight line.\nNew background for the next scene. ");
  assert.ok(body.startsWith(FORMATS_MARKER));
  assert.deepEqual(parseFormatsNote(body), { assets: ids.slice().sort(), note: "Center the overnight line.\nNew background for the next scene." });
  assert.deepEqual(noteText(body), { text: "Center the overnight line.\nNew background for the next scene.", approvedWithNote: false });
  const row = { asset_id: "s1-20-sample-piece-20-video-4x5", body };
  assert.deepEqual(noteAssets(row), ["s1-20-sample-piece-20-video-4x5", "s1-20-sample-piece-20-video-9x16", "s1-20-sample-piece-20-video-9x16-youtube"]);
  for (const id of ids) assert.ok(noteCovers(row, id), `shows on ${id}`);
  assert.ok(!noteCovers(row, "s1-20-sample-piece-20-linkedin"), "never on the text");
  // "Only this format", or a single file: the plain note, as before.
  assert.equal(encodeFormatsNote(["s1-20-sample-piece-20-video-4x5"], "Only the 4:5 crop is off."), "Only the 4:5 crop is off.");
  assert.deepEqual(noteAssets({ asset_id: "x", body: "plain" }), ["x"]);
  // An approve-with-note covers the files its header names too.
  assert.ok(noteCovers({ asset_id: "a-video-4x5", body: encodeFixNote({ part: "media", channels: ["linkedin", "youtube"], assets: ["a-video-4x5", "a-video-9x16"] }, "fix") }, "a-video-9x16"));
  assert.throws(() => encodeFormatsNote(ids, "x".repeat(4001)), /under 4000/);
  assert.equal(parseFormatsNote("[note for all formats] nothing\nx"), null);
});

test("videoBase: the formats of a video share a base; images and other names stand alone", () => {
  const v = (id: string) => videoBase({ id, kind: "video" });
  assert.equal(v("s1-20-sample-piece-20-video-4x5"), "s1-20-sample-piece-20");
  assert.equal(v("s1-20-sample-piece-20-video-9x16-youtube"), "s1-20-sample-piece-20");
  assert.equal(v("sample-extra-114-video-clean-open"), "sample-extra-114");
  assert.equal(v("sample-extra-39-video"), "sample-extra-39");
  assert.equal(v("orion-video-16x9"), "orion");
  assert.equal(v("a-teaser"), null);
  assert.equal(videoBase({ id: "s1-20-sample-piece-20-video-4x5", kind: "image" }), null);
});
