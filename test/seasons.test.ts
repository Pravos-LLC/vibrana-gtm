import test from "node:test";
import assert from "node:assert/strict";
import type { Item } from "../lib/calendar";
import { analysisOptions, buildSeasonInput, formatSeasonReport, KNOWN_PILLARS, normalizeFormat, parsePillars, partState, validateSeasonFields, type SeasonRaw } from "../lib/seasons";
import { analyzeSeason } from "../lib/season-analysis";
import type { StoryAsset, StoryChannel } from "../lib/story";

const season = { id: "season-1", title: "Season 1", description: "", starts_on: "2026-10-06", ends_on: "2026-12-11", pillars: ["proof", "build"], created_at: "", updated_at: "" };
const asset = (id: string, story: string, kind: StoryAsset["kind"], extra: Partial<StoryAsset> = {}): StoryAsset =>
  ({ id, story_id: story, title: id, kind, source: id, sha256: `sha-${id}`, revision: 1, storage_path: null, body: null, url: null, metadata: {}, ...extra });
const review = (asset_id: string, channel: string, status: StoryChannel["status"], approved = status === "approved"): StoryChannel =>
  ({ asset_id, channel, status, approved_sha256: approved ? `sha-${asset_id}` : null, note: "" });
const item = (id: string, date: string, channel: string, extra: Partial<Item> = {}): Item =>
  ({ id, week: 1, date, time: "09:00", pillar: "build", title: `Title ${id}`, format: "video", channels: [channel], status: "drafted", ...extra });

const raw = (extra: Partial<SeasonRaw> = {}): SeasonRaw => ({ season, stories: [], assets: [], reviews: [], versions: [], feedback: [], items: [], ...extra });

test("pillar slugs are parsed, de-duplicated and validated against the guide", () => {
  assert.deepEqual(KNOWN_PILLARS, ["proof", "perspective", "build", "lists"]);
  assert.deepEqual(parsePillars(" Lists, proof,proof ,"), ["lists", "proof"]);
  assert.deepEqual(parsePillars(["build"]), ["build"]);
  assert.deepEqual(parsePillars(undefined), []);
  const ok = { title: "T", description: "d", starts_on: "2026-10-06", ends_on: "2026-12-11", pillars: ["proof"] };
  assert.deepEqual(validateSeasonFields(ok), []);
  assert.match(validateSeasonFields({ ...ok, title: "  " })[0], /title/);
  assert.match(validateSeasonFields({ ...ok, title: "x".repeat(201) })[0], /200/);
  assert.match(validateSeasonFields({ ...ok, description: "x".repeat(5001) })[0], /5000/);
  assert.match(validateSeasonFields({ ...ok, starts_on: "2026-13-01" })[0], /start date/);
  assert.match(validateSeasonFields({ ...ok, starts_on: "2026-02-30" })[0], /start date/);
  assert.match(validateSeasonFields({ ...ok, ends_on: "Dec 11" })[0], /end date/);
  assert.match(validateSeasonFields({ ...ok, ends_on: "2026-10-05" })[0], /cannot end before/);
  assert.deepEqual(validateSeasonFields({ ...ok, ends_on: "2026-10-06" }), []);
  assert.match(validateSeasonFields({ ...ok, pillars: ["proof", "vibes", "x"] })[0], /Unknown pillars: vibes, x/);
  assert.deepEqual(validateSeasonFields({ ...ok, pillars: [] }), [], "no pillars selected means every pillar");
});

test("calendar formats normalize to video, carousel, text, image", () => {
  assert.deepEqual(["video", "carousel", "document", "text", "post", "image", "ig_story", undefined].map(normalizeFormat), ["video", "carousel", "carousel", "text", "text", "image", "other", "other"]);
});

test("a part is approved only while the staged bytes match the approval", () => {
  const a = asset("a", "s", "copy");
  assert.deepEqual(partState([a], [], "linkedin"), { state: "none", stale: 0 });
  assert.deepEqual(partState([a], [review("a", "linkedin", "pending")], "linkedin"), { state: "needs-approval", stale: 0 });
  assert.deepEqual(partState([a], [review("a", "linkedin", "approved")], "linkedin"), { state: "approved", stale: 0 });
  assert.deepEqual(partState([a], [review("a", "linkedin", "rejected")], "linkedin"), { state: "needs-changes", stale: 0 });
  assert.deepEqual(partState([a], [{ ...review("a", "linkedin", "approved"), approved_sha256: "old" }], "linkedin"), { state: "needs-approval", stale: 1 });
  assert.deepEqual(partState([a], [review("a", "instagram", "approved")], "linkedin"), { state: "none", stale: 0 }, "another channel's row is not this card's");
  const b = asset("b", "s", "image");
  assert.equal(partState([a, b], [review("a", "linkedin", "approved"), review("b", "linkedin", "pending")], "linkedin").state, "needs-approval");
  assert.equal(partState([a, b], [review("a", "linkedin", "approved"), review("b", "linkedin", "rejected")], "linkedin").state, "needs-changes");
});

test("buildSeasonInput: a season Story becomes one piece with a card per platform, its approvals, versions and notes", () => {
  const input = buildSeasonInput(raw({
    stories: [{ id: "s1-01-x", title: "W2 Tue Oct 13 | The X", season_id: "season-1" }],
    items: [
      item("s1-01-x-linkedin", "2026-10-13", "linkedin", { story_id: "s1-01-x", story_assets: ["li-copy", "video-4x5"] }),
      item("s1-01-x-instagram", "2026-10-13", "instagram", { format: "carousel", story_id: "s1-01-x", story_assets: ["ig-copy", "slide-01"] }),
    ],
    assets: [
      asset("li-copy", "s1-01-x", "copy", { body: "LinkedIn text, organise.", revision: 3 }), asset("video-4x5", "s1-01-x", "video"),
      asset("ig-copy", "s1-01-x", "copy", { body: "IG caption #a #b #c" }), asset("slide-01", "s1-01-x", "image"),
    ],
    reviews: [review("li-copy", "linkedin", "approved"), review("video-4x5", "linkedin", "rejected"), review("ig-copy", "instagram", "pending"), review("slide-01", "instagram", "approved")],
    versions: [
      { asset_id: "li-copy", revision: 1, label: "v1" }, { asset_id: "li-copy", revision: 3, label: "v1.2" }, { asset_id: "li-copy", revision: 2, label: "v1.1" },
      { asset_id: "video-4x5", revision: 1, label: "v1" },
    ],
    feedback: [
      { asset_id: "video-4x5", channel: "linkedin", resolved_at: null }, { asset_id: "video-4x5", channel: "linkedin", resolved_at: "2026-10-05" },
      { asset_id: "li-copy", channel: null, resolved_at: null }, { asset_id: "ig-copy", channel: "linkedin", resolved_at: null },
    ],
  }));
  assert.equal(input.pieces.length, 1);
  const p = input.pieces[0];
  assert.deepEqual([p.id, p.title, p.slot, p.date, p.pillar, p.format, p.platforms, p.inSeasonStories], ["s1-01-x", "The X", "W2 Tue Oct 13", "2026-10-13", "build", "video", ["instagram", "linkedin"], true]);
  const li = p.cards.find((c) => c.platform === "linkedin")!;
  assert.deepEqual([li.text, li.asset, li.staged, li.format, li.openNotes, li.itemId], ["approved", "needs-changes", true, "video", 2, "s1-01-x-linkedin"]);
  assert.deepEqual(li.versions.map((v) => [v.assetId, v.label, v.revision, v.versions]), [["li-copy", "v1.2", 3, 3], ["video-4x5", "v1", 1, 1]]);
  assert.match(li.copy!, /organise/);
  const ig = p.cards.find((c) => c.platform === "instagram")!;
  assert.deepEqual([ig.text, ig.asset, ig.format, ig.openNotes], ["needs-approval", "approved", "carousel", 0]);
});

test("buildSeasonInput: items inside the dates that are not season Stories become pieces, grouped by base id and slot date", () => {
  const input = buildSeasonInput(raw({
    stories: [],
    items: [
      item("sample-extra-38-linkedin", "2026-10-20", "linkedin", { pillar: "proof", story_id: "sample-extra-38", story_assets: ["o-copy", "o-link"] }),
      item("sample-extra-38-youtube", "2026-10-20", "youtube", { pillar: "proof", story_id: "sample-extra-38", story_assets: ["o-copy", "o-link"] }),
      item("carousel-x-instagram", "2026-11-18", "instagram", { format: "carousel", pillar: "proof" }),
      item("old-linkedin", "2026-09-30", "linkedin"),
      item("skipped-linkedin", "2026-10-21", "linkedin", { status: "skipped" }),
      item("future-linkedin", "2027-01-05", "linkedin"),
    ],
    assets: [asset("o-copy", "sample-extra-38", "copy", { body: "Stars as of early Oct 2026" }), asset("o-link", "sample-extra-38", "link")],
    reviews: [review("o-copy", "linkedin", "approved"), review("o-link", "linkedin", "approved")],
  }));
  assert.deepEqual(input.pieces.map((p) => p.id), ["sample-extra-38", "carousel-x"]);
  const orion = input.pieces[0];
  assert.deepEqual(orion.platforms, ["linkedin", "youtube"]);
  assert.equal(orion.cards[0].text, "approved");
  assert.equal(orion.cards[1].staged, false, "youtube has no approval rows, so it is not staged");
  assert.equal(orion.inSeasonStories, false);
  const bare = input.pieces[1];
  assert.deepEqual([bare.cards[0].staged, bare.cards[0].text, bare.format], [false, "none", "carousel"]);
});

test("buildSeasonInput: a season Story's items count even when dated outside the season, so the analysis can flag them", () => {
  const input = buildSeasonInput(raw({
    stories: [{ id: "s1-09-late", title: "W12 Thu Dec 31 | Late", season_id: "season-1" }],
    items: [item("s1-09-late-linkedin", "2026-12-31", "linkedin", { story_id: "s1-09-late", story_assets: [] })],
  }));
  assert.equal(input.pieces.length, 1);
  const a = analyzeSeason(input, analysisOptions("2026-10-05"));
  assert.deepEqual(a.dateRange.outsideRange, ["s1-09-late"]);
});

test("buildSeasonInput: as-of dates and star mentions come from the copy of lists pieces only", () => {
  const lists = buildSeasonInput(raw({
    items: [item("l-linkedin", "2026-11-26", "linkedin", { pillar: "lists", story_id: "l", story_assets: ["l-copy"] })],
    assets: [asset("l-copy", "l", "copy", { body: "Top 10, as of early Oct 2026. 391k stars." })], reviews: [review("l-copy", "linkedin", "pending")],
  }));
  assert.deepEqual([lists.pieces[0].factsAsOf, lists.pieces[0].mentionsStars], ["2026-10-05", true]);
  const perspective = buildSeasonInput(raw({
    items: [item("p-linkedin", "2026-11-26", "linkedin", { pillar: "perspective", story_id: "p", story_assets: ["p-copy"] })],
    assets: [asset("p-copy", "p", "copy", { body: "I gave it five stars." })], reviews: [review("p-copy", "linkedin", "pending")],
  }));
  assert.equal(perspective.pieces[0].mentionsStars, false);
});

test("the report prints the overview, every section and the findings", () => {
  const input = buildSeasonInput(raw({
    stories: [{ id: "s1-01-x", title: "W2 Tue Oct 13 | The X", season_id: "season-1" }],
    items: [item("s1-01-x-linkedin", "2026-10-13", "linkedin", { story_id: "s1-01-x", story_assets: ["c"] })],
    assets: [asset("c", "s1-01-x", "copy", { body: "[JOHN: x]" })], reviews: [review("c", "linkedin", "pending")],
  }));
  const text = formatSeasonReport(input, analyzeSeason(input, analysisOptions("2026-10-12")));
  for (const part of ["Season 1  (season-1)", "now week 2", "PIPELINE", "1 pieces, 1 platform cards", "LEFT TO DO (1", "CADENCE", "1 of 30 slots planned", "PILLAR MIX", "FINDINGS: 1 block", "[block] placeholder s1-01-x (linkedin)"]) {
    assert.ok(text.includes(part), part);
  }
  assert.ok(!/[—–]/.test(text), "no dashes in the report");
});
