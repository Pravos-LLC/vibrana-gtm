import test from "node:test";
import assert from "node:assert/strict";
import { bySlot, groupPiece, hasBannedDash, hasPlaceholder, partStatus, ratioOf, parsePieceTitle, pieceStatus, readFields, writeCopy } from "../lib/season";
import type { StoryAsset, StoryChannel } from "../lib/story";

const asset = (id: string, kind: StoryAsset["kind"]): StoryAsset =>
  ({ id, story_id: "s1-02-sample-piece-02", title: id, kind, source: id, sha256: "x", revision: 1, storage_path: null, body: null, url: null, metadata: {} });
const review = (asset_id: string, channel: string, status: StoryChannel["status"]): StoryChannel =>
  ({ asset_id, channel, status, approved_sha256: null, note: "" });

test("piece titles split into slot and name, and pieces sort by id", () => {
  assert.deepEqual(parsePieceTitle("W2 Thu Oct 15 | The Wave"), { slot: "W2 Thu Oct 15", name: "The Wave" });
  assert.deepEqual(parsePieceTitle("No slot"), { slot: "", name: "No slot" });
  assert.deepEqual(bySlot([{ id: "s1-10-x" }, { id: "s1-02-y" }, { id: "s1-01-z" }]).map((s) => s.id), ["s1-01-z", "s1-02-y", "s1-10-x"]);
});

test("editing keeps every frontmatter key it does not own and the prose is replaced", () => {
  const body = `---\nstatus: approved-text\nfirst_comment: |\n  Old comment\nyoutube_visibility: public\n---\n\nOld prose\n`;
  assert.equal(readFields("first_comment: hello\nstatus: x").first_comment, "hello");
  const next = writeCopy(body, "New prose", { first_comment: "New comment: https://a.b/?x=1&y=2" });
  assert.match(next, /status: approved-text/);
  assert.match(next, /youtube_visibility: public/);
  assert.equal(readFields(next.match(/^---\n([\s\S]*?)\n---/)![1]).first_comment, "New comment: https://a.b/?x=1&y=2");
  assert.ok(next.endsWith("\n\nNew prose\n"));
  assert.ok(!/first_comment/.test(writeCopy(body, "p", { first_comment: "  " })));
  assert.equal(writeCopy("Plain body", "Changed", {}), "Changed\n");
});

test("assets are grouped by channel and media is separated", () => {
  const assets = [asset("a-linkedin", "copy"), asset("a-instagram", "copy"), asset("a-youtube", "copy"), asset("a-video-9x16", "video"), asset("a-video-4x5", "video"), asset("a-link", "link")];
  const rows = [review("a-linkedin", "linkedin", "pending"), review("a-instagram", "instagram", "pending"), review("a-youtube", "youtube", "pending")];
  const piece = groupPiece(assets, rows);
  assert.equal(piece.copy.linkedin?.id, "a-linkedin");
  assert.equal(piece.copy.youtube?.id, "a-youtube");
  assert.deepEqual(piece.media.map((m) => m.id), ["a-video-4x5", "a-video-9x16"]);
});

test("a piece is approved only when every channel row is approved; any rejection shows as changes", () => {
  assert.equal(pieceStatus([]), "pending");
  assert.equal(pieceStatus([review("a", "linkedin", "approved"), review("b", "youtube", "approved")]), "approved");
  assert.equal(pieceStatus([review("a", "linkedin", "approved"), review("b", "youtube", "pending")]), "pending");
  assert.equal(pieceStatus([review("a", "linkedin", "approved"), review("b", "youtube", "rejected")]), "changes");
});

test("em and en dashes are caught", () => {
  assert.ok(hasBannedDash("a — b"));
  assert.ok(hasBannedDash("1–2"));
  assert.ok(!hasBannedDash("a - b"));
});

test("placeholders and broken frontmatter are caught", () => {
  assert.ok(hasPlaceholder("see [JOHN: public URL]"));
  assert.ok(!hasPlaceholder("John said so"));
});

test("a save never fails on loose hand-written frontmatter: the block is rebuilt from what the screen showed", () => {
  // 2026-10-16: `first_comment: Full case study: https://...` is not strict YAML, the save threw, and John lost his edit.
  const body = "---\nstatus: drafted\nfirst_comment: Full case study: https://brand.example.com/case-studies/sample-extra-38\n---\nOld\n";
  const kept = writeCopy(body, "New", {});
  assert.equal(readFields(kept.split("---")[1]).first_comment, "Full case study: https://brand.example.com/case-studies/sample-extra-38");
  assert.match(kept, /status: drafted/);
  assert.match(kept, /\n\nNew\n$/);
  const edited = writeCopy(body, "New", { first_comment: "See: https://a.b" });
  assert.equal(readFields(edited.split("---")[1]).first_comment, "See: https://a.b");
});

test("edited fields that look like numbers or booleans survive a save and a reload", () => {
  for (const title of ["2026", "007", "true", "null", "1e3"]) {
    const out = writeCopy("---\nyoutube_title: Old\n---\nx\n", "x", { youtube_title: title });
    assert.equal(readFields(out.split("---")[1]).youtube_title, title);
  }
});

test("the loose-value repair keeps every other key, comment and value as written", () => {
  const body = "---\nslot: 07\nfirst_comment: Full case study: https://x.y/z\n# keep this comment\ntags:\n  - a\n  - b\nnote: |\n  line one: two\n---\nOld\n";
  const out = writeCopy(body, "New", {});
  assert.match(out, /slot: 07/);
  assert.match(out, /# keep this comment/);
  assert.match(out, /tags:\n  - a\n  - b/);
  assert.match(out, /line one: two/);
  assert.equal(readFields(out.split("---")[1]).first_comment, "Full case study: https://x.y/z");
  // Still refused when a value is broken some other way; the screen keeps John's edit.
  assert.throws(() => writeCopy('---\nfirst_comment: "a "b" c"\n---\n\nx\n', "x", { first_comment: "y" }), /not valid YAML/);
});

test("media ratio comes from the file name and text/asset approval are judged per platform", () => {
  assert.equal(ratioOf("x/loop-9x16-post.mp4"), 9 / 16);
  assert.equal(ratioOf("x/loop-4x5-post.mp4"), 4 / 5);
  assert.equal(ratioOf("x/slide-01.png"), 4 / 5);
  const rows = [
    { asset_id: "copy", channel: "linkedin", status: "approved" },
    { asset_id: "video", channel: "linkedin", status: "pending" },
    { asset_id: "video", channel: "youtube", status: "approved" },
  ];
  assert.equal(partStatus(rows, ["copy"], "linkedin"), "approved");
  assert.equal(partStatus(rows, ["video"], "linkedin"), "pending");
  assert.equal(partStatus(rows, ["video"], "youtube"), "approved");
  assert.equal(partStatus(rows, ["video"], "instagram"), "none");
});

test("a rejected row makes the part 'rejected', not pending", () => {
  const rows = [{ asset_id: "v", channel: "linkedin", status: "rejected" }, { asset_id: "w", channel: "linkedin", status: "approved" }];
  assert.equal(partStatus(rows, ["v", "w"], "linkedin"), "rejected");
});

import {
  activeFilterCount, assetVersions, buildGroups, cardKey, familyTarget, mediaFamily, combineStatus, pieceParts, reviewMode, pieceView, dateRange, filterPieces, filtersToQuery, labelForRevision, nextLabel, openNotes,
  parseFilters, partUi, partVersions, resolvedNotes, summarize, versionAt, type CardData, type FeedbackItem, type PieceAsset, type PieceData,
} from "../lib/season-review";
import { initialPartState, partKey, partReducer, runBatch } from "../lib/review-state";

const ver = (revision: number, label: string, prose = "") => ({ revision, label, createdAt: "", src: null, poster: null, prose, fields: {} });
const pa = (id: string, kind: PieceAsset["kind"], over: Partial<PieceAsset> = {}): PieceAsset =>
  ({ id, title: id, kind, revision: 1, source: id, src: null, poster: null, ratio: 0.8, prose: "", fields: {}, status: "pending", feedback: [], versions: [], ...over });
const fb = (id: string, over: Partial<FeedbackItem> = {}): FeedbackItem =>
  ({ id, asset_id: "a", channel: "linkedin", body: "note", created_at: "2026-10-06", resolved_at: null, resolution: "", revision: 1, ...over });

test("versions: latest wins, older are addressable, an asset without rows reads as v1", () => {
  const a = pa("a", "image", { revision: 3, versions: [ver(3, "v1.2"), ver(1, "v1"), ver(2, "v1.1")] });
  assert.deepEqual(assetVersions(a).map((v) => v.label), ["v1", "v1.1", "v1.2"]);
  assert.equal(versionAt(a, 2).label, "v1.1");
  assert.equal(versionAt(a, 99).label, "v1.2");
  assert.equal(assetVersions(pa("b", "image")).length, 1);
  const slides = [a, pa("c", "image", { revision: 2, versions: [ver(1, "v1"), ver(2, "v1.1")] })];
  assert.deepEqual(partVersions(slides).map((v) => v.revision), [1, 2, 3]);
  assert.equal(nextLabel([]), "v1");
  assert.equal(nextLabel([{ label: "v1" }, { label: "v1.1" }]), "v1.2");
  assert.equal(labelForRevision(partVersions(slides), 2), "v1.1");
  assert.equal(labelForRevision(partVersions(slides), null), null);
});

test("part state: approved, changes, a new version after a resolved note, and plain pending", () => {
  const v2 = { revision: 2, label: "v1.1", createdAt: "" };
  const resolved = fb("r", { resolved_at: "x", revision: 1 });
  assert.equal(partUi("none", v2, []), "none");
  assert.equal(partUi("approved", v2, [resolved]), "approved");
  assert.equal(partUi("rejected", v2, [fb("o")]), "changes");
  assert.equal(partUi("pending", v2, [resolved]), "new");
  assert.equal(partUi("pending", { ...v2, revision: 1 }, [resolved]), "pending");
  assert.equal(partUi("pending", v2, []), "pending");
  assert.deepEqual([openNotes([resolved, fb("o")]).length, resolvedNotes([resolved, fb("o")]).length], [1, 1]);
});

const card = (channel: CardData["channel"], textStatus: CardData["textStatus"], assetStatus: CardData["assetStatus"], prose = "", notes: FeedbackItem[] = []): CardData => ({
  channel, textStatus, assetStatus, copy: pa(`c-${channel}`, "copy", { prose, feedback: notes }), media: [pa(`m-${channel}`, "image")],
});
const pieces: PieceData[] = [
  { storyId: "s1-01", slot: "W2 Tue Oct 13", name: "Maturity Model", pillar: "build", date: "2026-10-13", cards: [card("linkedin", "approved", "approved", "agents do the work"), card("youtube", "pending", "rejected")] },
  { storyId: "s1-02", slot: "W2 Thu Oct 15", name: "The Wave", pillar: "perspective", date: "2026-12-03", cards: [card("linkedin", "pending", "pending", "a bad habit", [fb("n", { body: "soften the opener" })])] },
];

test("filters parse from the query string, drop unknown values and round-trip", () => {
  const f = parseFilters({ q: " wave ", platform: "linkedin", status: "bogus", pillar: "build" });
  assert.deepEqual(f, { q: "wave", platform: "linkedin", status: "", pillar: "build", piece: "", series: "", stage: "", focus: false });
  assert.equal(filtersToQuery(f), "?q=wave&platform=linkedin&pillar=build");
  assert.equal(filtersToQuery(parseFilters({})), "");
  assert.equal(activeFilterCount(f), 2);
  assert.equal(parseFilters({ platform: ["youtube", "x"] }).platform, "youtube");
});

test("filterPieces: platform, status, pillar, piece and search combine with and; a matching piece keeps every platform (one text)", () => {
  const ids = (f: Record<string, string>) => filterPieces(pieces, parseFilters(f)).map((p) => `${p.storyId}:${p.cards.map((c) => c.channel).join("+")}`);
  assert.deepEqual(ids({}), ["s1-01:linkedin+youtube", "s1-02:linkedin"]);
  assert.deepEqual(ids({ platform: "youtube" }), ["s1-01:linkedin+youtube"]);
  assert.deepEqual(ids({ status: "approved" }), ["s1-01:linkedin+youtube"]);
  assert.deepEqual(ids({ status: "needs-changes" }), ["s1-01:linkedin+youtube"]);
  assert.deepEqual(ids({ status: "needs-approval" }), ["s1-01:linkedin+youtube", "s1-02:linkedin"]);
  assert.deepEqual(ids({ pillar: "perspective" }), ["s1-02:linkedin"]);
  assert.deepEqual(ids({ piece: "s1-01", platform: "linkedin" }), ["s1-01:linkedin+youtube"]);
  assert.deepEqual(ids({ q: "SOFTEN opener" }), ["s1-02:linkedin"]);
  assert.deepEqual(ids({ q: "wave habit" }), ["s1-02:linkedin"]);
  assert.deepEqual(ids({ q: "nothing like this" }), []);
});

test("overview counts parts, open notes and needs-changes, and the date range", () => {
  const o = summarize([
    { key: "a", storyId: "s1", textStatus: "approved", assetStatus: "approved", openNotes: 0 },
    { key: "b", storyId: "s1", textStatus: "pending", assetStatus: "rejected", openNotes: 2 },
    { key: "c", storyId: "s2", textStatus: "approved", assetStatus: "none", openNotes: 1 },
  ]);
  assert.deepEqual(o, { pieces: 2, cards: 3, textApproved: 2, textTotal: 3, assetApproved: 1, assetTotal: 2, openNotes: 3, needsChanges: 1, percent: 60, byStage: [] });
  assert.equal(summarize([]).percent, 0);
  assert.equal(dateRange(["2026-10-13", null, "2026-12-03"]), "Oct 13 to Dec 3");
  assert.equal(dateRange(["2026-12-20", "2027-01-05"]), "Dec 20, 2026 to Jan 5, 2027");
  assert.equal(dateRange(["2026-10-13"]), "Oct 13");
  assert.equal(dateRange([null]), null);
  assert.equal(cardKey("s1", "linkedin"), "s1:linkedin");
});

test("part reducer: approve, unapprove, request changes with its note, and saved text resets approval", () => {
  const s0 = initialPartState({ status: "approved", notes: [], revision: 1 });
  assert.equal(partReducer(s0, { type: "approve" }), s0, "no change keeps identity");
  assert.equal(partReducer(s0, { type: "unapprove" }).status, "pending");
  const asked = partReducer(s0, { type: "request", note: fb("p", { body: "darker" }) });
  assert.equal(asked.status, "rejected");
  assert.equal(asked.notes.length, 1);
  const saved = partReducer(s0, { type: "saved", version: ver(2, "v1.1", "new") });
  assert.deepEqual([saved.status, saved.revision, saved.reset, saved.addedVersions.length], ["pending", 2, true, 1]);
  assert.equal(partReducer(initialPartState({ status: "none", notes: [] }), { type: "saved", version: ver(2, "v1.1") }).status, "none");
  assert.equal(partKey("media", "s1", "instagram+youtube"), "media|s1|instagram+youtube");
});

test("one file on several platforms is one media group, approved once; a platform-only file is its own group", () => {
  const video = (status: PieceAsset["status"]) => pa("v", "video", { status, feedback: [fb("n1", { asset_id: "v" })] });
  const thumb = pa("thumb", "image", { status: "pending" });
  const cards: CardData[] = [
    { channel: "instagram", copy: pa("ig", "copy"), media: [video("approved")], textStatus: "pending", assetStatus: "approved" },
    { channel: "youtube", copy: pa("yt", "copy"), media: [video("pending"), thumb], textStatus: "pending", assetStatus: "pending" },
  ];
  const groups = buildGroups(cards);
  assert.deepEqual(groups.map((g) => [g.key, g.assets.map((a) => a.id), g.status]), [["instagram+youtube", ["v"], "pending"], ["youtube", ["thumb"], "pending"]]);
  assert.equal(groups[0].assets[0].feedback.length, 1, "a note shared by both platforms shows once");
  assert.equal(combineStatus(["approved", "rejected"]), "rejected");
  assert.equal(combineStatus(["approved", "none"]), "approved");
});

test("the formats of one video are one review: 4:5 for LinkedIn and both 9:16 cuts form a family; covers and other videos do not", () => {
  const v = (id: string) => pa(id, "video", { sha256: id.padEnd(64, "0").slice(0, 64), revision: 2 });
  const cards: CardData[] = [
    { channel: "linkedin", copy: pa("r-linkedin", "copy"), media: [v("s1-20-sample-piece-20-video-4x5")], textStatus: "pending", assetStatus: "pending" },
    { channel: "instagram", copy: pa("r-instagram", "copy"), media: [v("s1-20-sample-piece-20-video-9x16")], textStatus: "pending", assetStatus: "pending" },
    { channel: "youtube", copy: pa("r-youtube", "copy"), media: [v("s1-20-sample-piece-20-video-9x16-youtube"), pa("s1-20-sample-piece-20-youtube-thumbnail", "image")], textStatus: "pending", assetStatus: "pending" },
  ];
  const groups = buildGroups(cards);
  const linkedin = groups.find((g) => g.key === "linkedin")!;
  const family = mediaFamily(groups, linkedin);
  assert.deepEqual(family.map((g) => g.key), ["linkedin", "instagram", "youtube"], "itself first, then every other format");
  const target = familyTarget(family);
  assert.deepEqual(target.channels, ["linkedin", "instagram", "youtube"]);
  assert.deepEqual(target.assetIds.sort(), ["s1-20-sample-piece-20-video-4x5", "s1-20-sample-piece-20-video-9x16", "s1-20-sample-piece-20-video-9x16-youtube", "s1-20-sample-piece-20-youtube-thumbnail"]);
  assert.deepEqual(target.expected.find((e) => e.asset_id === "s1-20-sample-piece-20-video-9x16")?.revision, 2, "each file is bound to the bytes on screen");

  // One file shared by every platform (s1-18-sample-piece-18) is already one group: nothing to join.
  const shared = buildGroups([
    { channel: "linkedin", copy: pa("p-li", "copy"), media: [v("s1-18-sample-piece-18-video-9x16")], textStatus: "pending", assetStatus: "pending" },
    { channel: "youtube", copy: pa("p-yt", "copy"), media: [v("s1-18-sample-piece-18-video-9x16")], textStatus: "pending", assetStatus: "pending" },
  ]);
  assert.deepEqual(mediaFamily(shared, shared[0]).map((g) => g.key), ["linkedin+youtube"]);

  // Two different videos in one Story stay apart; an image alone stands alone.
  const two = buildGroups([
    { channel: "linkedin", copy: pa("c-li", "copy"), media: [v("sample-extra-39-video")], textStatus: "pending", assetStatus: "pending" },
    { channel: "youtube", copy: pa("c-yt", "copy"), media: [v("sample-extra-41-video")], textStatus: "pending", assetStatus: "pending" },
    { channel: "instagram", copy: pa("c-ig", "copy"), media: [pa("cover", "image")], textStatus: "pending", assetStatus: "pending" },
  ]);
  for (const g of two) assert.deepEqual(mediaFamily(two, g).map((x) => x.key), [g.key]);
});

test("before the final, a piece's media is reviewed as a stage and never counts as approved; a paper edit is not in /content", () => {
  const rough: PieceData = {
    storyId: "s1-18", slot: "", name: "Their language", pillar: null, date: null,
    cards: [{ channel: "youtube", copy: pa("yt", "copy"), media: [pa("v", "video", { status: "approved", stage: "rough-cut" })], textStatus: "approved", assetStatus: "approved" }],
    stageAssets: [pa("v", "video", { stage: "rough-cut", sha256: "a".repeat(64) })],
    pipeline: { format: "short", series: null, label: "v4", staged: ["rough-cut"], final: { staged: false, approved: false, changes: false }, thirdParty: null,
      rows: [{ stage: "paper-edit", status: "approved" }, { stage: "rough-cut", status: "review" }] },
  };
  assert.equal(reviewMode(pieceView(rough), rough.stageAssets).kind, "stage");
  const parts = pieceParts([rough]);
  assert.deepEqual(Object.keys(parts.initial).sort(), ["stage|s1-18|rough-cut", "text|s1-18|youtube"], "no media part before the final");
  assert.equal(parts.summary[0].assetStatus, "pending", "a rough cut approved per platform before phase 2 is not progress");
  assert.deepEqual(parts.stages.map((s) => [s.label, s.status]), [["Rough cut", "pending"]]);
  assert.deepEqual(summarize(parts.summary, parts.stages).byStage, [{ label: "Rough cut", n: 1 }]);
  // Rows written before the gates were removed: a paper edit still marked "review" must not hide a staged rough cut.
  const legacy1: PieceData = { ...rough, pipeline: { ...rough.pipeline!, rows: [{ stage: "paper-edit", status: "review" }, { stage: "rough-cut", status: "review" }] } };
  assert.equal(reviewMode(pieceView(legacy1), legacy1.stageAssets).kind, "stage", "a leftover paper-edit review row is read as done, not as a gate in front of the rough cut");
  const noPaperRow: PieceData = { ...rough, pipeline: { ...rough.pipeline!, rows: [{ stage: "rough-cut", status: "review" }] } };
  assert.equal(reviewMode(pieceView(noPaperRow), noPaperRow.stageAssets).kind, "stage", "no paper-edit row at all is fine");
  const legacy: PieceData = { ...rough, pipeline: null, stageAssets: [] };
  assert.equal(reviewMode(pieceView(legacy)).kind, "final");
});

test("series, stage and focus filters parse, round-trip, and narrow the pieces; stale values are dropped", () => {
  const f = parseFilters({ series: "example-shorts", stage: "rough-cut", focus: "1", piece: "" });
  assert.deepEqual([f.series, f.stage, f.focus], ["example-shorts", "rough-cut", true]);
  assert.equal(filtersToQuery(f), "?series=example-shorts&stage=rough-cut&focus=1");
  assert.deepEqual(parseFilters({ series: "Bad Series!", stage: "Rough Cut", focus: "yes" }), { ...parseFilters({}), series: "", stage: "", focus: false });
  const piece = (id: string, series: string | null, rows: Array<{ stage: string; status: "approved" | "review" | "working" }>, staged: string[] = ["rough-cut"]): PieceData => ({
    storyId: id, slot: "", name: id, pillar: null, date: null, cards: [{ channel: "youtube", copy: pa(`${id}-yt`, "copy"), media: [], textStatus: "pending", assetStatus: "none" }],
    pipeline: { format: "short", series, rows, staged, final: { staged: false, approved: false, changes: false }, label: null, thirdParty: null },
  });
  const pieces = [piece("a", "sn", [{ stage: "paper-edit", status: "approved" }, { stage: "rough-cut", status: "review" }]), piece("b", "sn", [{ stage: "paper-edit", status: "working" }], []), piece("c", null, [], [])];
  assert.deepEqual(filterPieces(pieces, { ...parseFilters({}), series: "sn" }).map((p) => p.storyId), ["a", "b"]);
  assert.deepEqual(filterPieces(pieces, { ...parseFilters({}), stage: "rough-cut" }).map((p) => p.storyId), ["a"]);
  assert.deepEqual(filterPieces(pieces, { ...parseFilters({}), stage: "paper-edit" }).map((p) => p.storyId), ["b", "c"]);
});

test("a batch runs every call, lists what failed and why, and never stops early", async () => {
  const r = await runBatch(["a", "b", "c"], (x) => x, async (x) => (x === "b" ? { ok: false as const, error: "Story asset changed; refresh" } : x === "c" ? Promise.reject(new Error("network")) : { ok: true as const }));
  assert.deepEqual(r, { done: ["a"], failed: [{ id: "b", error: "Story asset changed; refresh" }, { id: "c", error: "network" }] });
});
