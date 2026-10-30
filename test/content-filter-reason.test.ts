// Why a piece is listed under a /content status filter (John, 2026-10-17, kb-tokenmaxxing): the badge names the parts it
// waits on and who has them, the matching card is the one opened, and newsletter header options the essay does not use
// are shown but never decided, so they cannot keep a piece under "Needs approval".
import { test } from "node:test";
import assert from "node:assert/strict";
import { newsletterParts, withoutAlternatives } from "../lib/newsletter-card.ts";
import { decidedMedia, filterPieces, openParts, parseFilters, pieceParts, pieceView, type CardData, type PieceAsset, type PieceData } from "../lib/season-review.ts";
import { encodeFixNote } from "../lib/approve-note.ts";
import { finalState, pipelineView, waitingOn } from "../lib/pipeline-state.ts";
import { PIPELINES } from "../lib/pipelines.ts";
import { partStatus } from "../lib/season.ts";

const asset = (id: string, kind: string, source: string, body: string | null = null) => ({ id, kind, source, body, stage: null, sha256: id });
const ESSAY = "# Tokenmaxxing\n\n![Header](assets/header.jpg)\n\nThe body.\n";
const own = [
  asset("kb-linkedin", "copy", "kb/linkedin.md", "post"),
  asset("kb-substack", "copy", "kb/substack.md", ESSAY),
  asset("kb-header", "image", "kb/assets/header.jpg"),
  asset("kb-header-v2-2", "image", "kb/assets/header-v2-2.jpg"),
  asset("kb-header-v2-3", "image", "kb/assets/header-v2-3.jpg"),
];
const row = (asset_id: string, channel: string, status = "pending") => ({ asset_id, channel, status, approved_sha256: status === "approved" ? asset_id : null });

test("header images the essay does not name are alternatives: shown on the card, never part of its decision", () => {
  const rows = [row("kb-linkedin", "linkedin", "approved"), ...["kb-substack", "kb-header", "kb-header-v2-2", "kb-header-v2-3"].map((id) => row(id, "newsletter"))];
  const [part] = newsletterParts(own, rows);
  assert.deepEqual(part.media.map((m) => m.id), ["kb-header", "kb-header-v2-2", "kb-header-v2-3"], "every option stays visible");
  assert.deepEqual(part.named.map((m) => m.id), ["kb-header"]);
  assert.deepEqual(part.alternatives.map((m) => m.id), ["kb-header-v2-2", "kb-header-v2-3"]);

  // Approving the essay and the header it names approves the card; the two options stay pending and gate nothing.
  const decided = rows.map((r) => (r.asset_id === "kb-substack" || r.asset_id === "kb-header" ? { ...r, status: "approved", approved_sha256: r.asset_id } : r));
  assert.equal(partStatus(decided, part.named.map((m) => m.id), "newsletter"), "approved");
  assert.equal(partStatus(decided, part.media.map((m) => m.id), "newsletter"), "pending", "the old rule: options kept it pending");
  // The piece's final reads the same way once the options are left out.
  assert.equal(finalState(own, decided).approved, false);
  assert.equal(finalState(own, withoutAlternatives(own, decided)).approved, true);
  assert.deepEqual(withoutAlternatives(own, decided).map((r) => r.asset_id), ["kb-linkedin", "kb-substack", "kb-header"]);
  // Naming an option in the essay makes it part of the decision.
  const renamed = own.map((a) => (a.id === "kb-substack" ? { ...a, body: ESSAY.replace("header.jpg", "header-v2-3.jpg") } : a));
  assert.deepEqual(newsletterParts(renamed, rows)[0].named.map((m) => m.id), ["kb-header-v2-3"]);
});

const piece = (over: Partial<PieceAsset> & { id: string; kind: PieceAsset["kind"] }): PieceAsset => ({
  title: over.id, revision: 1, source: `${over.id}.md`, src: null, poster: null, ratio: 0.8, prose: "", fields: {}, status: "pending", feedback: [], versions: [], ...over,
});
const kb = (essayStatus: CardData["textStatus"], headerStatus: CardData["assetStatus"]): PieceData => {
  const li: CardData = { channel: "linkedin", copy: piece({ id: "kb-linkedin", kind: "copy" }), media: [], textStatus: "approved", assetStatus: "none" };
  const letter: CardData = {
    channel: "newsletter", copy: piece({ id: "kb-substack", kind: "copy" }),
    media: [piece({ id: "kb-header", kind: "image" }), piece({ id: "kb-header-v2-2", kind: "image" }), piece({ id: "kb-header-v2-3", kind: "image" })],
    textStatus: essayStatus, assetStatus: headerStatus, alternatives: ["kb-header-v2-2", "kb-header-v2-3"],
  };
  return { storyId: "kb-tokenmaxxing", slot: "", name: "Tokenmaxxing", pillar: null, date: null, cards: [li, letter],
    pipeline: { format: "text", series: null, rows: [], staged: ["final"], final: { staged: true, approved: false, changes: false }, label: null, thirdParty: null } };
};

test("under Needs approval the piece names its waiting parts and the Substack card is the match, not the approved LinkedIn tab", () => {
  const p = kb("pending", "pending");
  const [shown] = filterPieces([p], parseFilters({ status: "needs-approval" }));
  assert.deepEqual(shown.matched, ["newsletter:kb-substack"], "the card that explains the listing");
  assert.equal(filterPieces([p], parseFilters({ piece: "kb-tokenmaxxing" }))[0].matched, undefined, "no status filter, nothing to explain");
  const { initial } = pieceParts([p]);
  const parts = openParts(p, initial);
  assert.deepEqual(parts, { john: ["Substack essay", "Substack image"], fixing: [], changes: [] });
  const view = pieceView(p)!;
  assert.deepEqual(waitingOn(view, null, parts), { who: "john", label: "John", where: "cockpit", parts: ["Substack essay", "Substack image"] });
  assert.equal(decidedMedia(p.cards[1]).length, 1);

  // Essay and named header approved: nothing is waiting on John, and the options do not hold it under Needs approval.
  const done = kb("approved", "approved");
  assert.equal(filterPieces([done], parseFilters({ status: "needs-approval" })).length, 0);
  assert.equal(filterPieces([done], parseFilters({ status: "approved" })).length, 1);
  const summary = pieceParts([done]).summary.find((s) => s.key.includes("newsletter"))!;
  assert.equal(summary.assetStatus, "approved");
  assert.deepEqual(openParts(done, pieceParts([done]).initial).john, []);

  // Only options on the card (the essay names no image): there is no image part at all.
  const onlyOptions: PieceData = { ...p, cards: [p.cards[0], { ...p.cards[1], assetStatus: "none", alternatives: p.cards[1].media.map((m) => m.id) }] };
  assert.equal(pieceParts([onlyOptions]).summary.find((s) => s.key.includes("newsletter"))!.assetStatus, "none");
  assert.deepEqual(openParts(onlyOptions, pieceParts([onlyOptions]).initial).john, ["Substack essay"]);
});

test("a final whose only open part is an accepted-with-note fix waits on the agent, never on John (review #143 N2)", () => {
  const note = { id: "n", asset_id: "v", channel: null, revision: 1, created_at: "2030-01-01", resolved_at: null, resolution: "",
    body: encodeFixNote({ part: "media", assets: ["v"], channels: ["youtube"] }, "Shorten the opening") };
  const p: PieceData = {
    storyId: "s1-50", slot: "", name: "Short", pillar: null, date: null,
    cards: [{ channel: "youtube", copy: piece({ id: "t", kind: "copy" }), media: [piece({ id: "v", kind: "video", feedback: [note] })], textStatus: "approved", assetStatus: "pending" }],
    pipeline: { format: "short", series: null, rows: PIPELINES.short.stages.filter((st) => !st.final).map((st) => ({ stage: st.key, status: st.gate === "john" ? "approved" as const : "done" as const })),
      staged: ["final"], final: { staged: true, approved: false, changes: false }, label: null, thirdParty: null },
  };
  const view = pieceView(p)!;
  assert.equal(view.current?.stage.final, true);
  assert.equal(view.current?.status, "review");
  assert.deepEqual(waitingOn(view, null)?.who, "john", "without the parts the final reads as John's turn");
  const parts = openParts(p, pieceParts([p]).initial);
  assert.deepEqual(parts, { john: [], fixing: ["YouTube video"], changes: [] });
  assert.deepEqual(waitingOn(view, null, parts), { who: "agent", label: "the agent (fix)", parts: ["YouTube video"] });
  // Nothing open at the final (approved on the page since load): nothing waiting, and a third party still shows.
  assert.equal(waitingOn(view, null, { john: [], fixing: [], changes: [] }), null);
  assert.deepEqual(waitingOn(view, { who: "example_approver", open: true }, { john: [], fixing: [], changes: [] })?.who, "third_party");
  // Before the final the parts do not apply: a rough cut waiting on John still says John.
  const rough = pipelineView(PIPELINES.short, [{ stage: "paper-edit", status: "approved" }, { stage: "rough-cut", status: "review" }]);
  assert.deepEqual(waitingOn(rough, null, parts)?.who, "john");
});

test("Request changes on a part waiting for its fix takes effect: sent back wins over the open fix note (review #143 F3)", async () => {
  const { partUi, matchesStatus } = await import("../lib/season-review.ts");
  const { displayReviews } = await import("../lib/review-display.ts");
  const fix = { id: "n", asset_id: "t", channel: "linkedin", revision: 1, created_at: "2030-01-01", resolved_at: null, resolution: "",
    body: encodeFixNote({ part: "text", assets: ["t"], channels: ["linkedin"] }, "colour to color") };
  const rejected = [{ asset_id: "t", channel: "linkedin", status: "rejected" as const, approved_sha256: null, note: "Rewrite it" }];
  assert.equal(displayReviews([{ id: "t", sha256: "s" }], rejected, [fix])[0].status, "rejected", "a fix note never hides John's change request");
  assert.equal(partUi("rejected", undefined, [fix]), "changes");
  assert.equal(matchesStatus({ text: "changes", asset: "none" }, "needs-changes"), true);
  assert.equal(matchesStatus({ text: "changes", asset: "none" }, "waiting-fix"), false);
  assert.equal(partUi("pending", undefined, [fix]), "fixing", "without a change request it still waits for the fix");
});

test("the card gates exactly the images the paste uses: percent-encoded names match, an unstaged one is a named blocker (review #143 F1, F2)", async () => {
  const { newsletterExport } = await import("../lib/newsletter-card.ts");
  const encoded = [asset("e-copy", "copy", "e/substack.md", "# Essay\n\n![Header](assets/my%20header.jpg?v=2)\n\nBody.\n"), asset("e-img", "image", "e/assets/my header.jpg"), asset("e-alt", "image", "e/assets/other.jpg")];
  const rows = encoded.map((a) => row(a.id, "newsletter"));
  const [part] = newsletterParts(encoded, rows);
  assert.deepEqual(part.named.map((m) => m.id), ["e-img"], "the image the paste uses is the one John approves");
  assert.deepEqual(part.alternatives.map((m) => m.id), ["e-alt"]);
  assert.deepEqual(newsletterExport(encoded[0].body!, [{ source: "e/assets/my header.jpg", signedUrl: "https://s/x", publicUrl: null, alt: "h" }]).data.images.map((i) => i.file), ["my header.jpg"]);
  // kb-tokenmaxxing's shape: the essay names hero.jpg, the staged headers are hero-v2-*: all options, and the gap is named.
  const sub = newsletterExport("# T\n\n![Header](assets/hero.jpg)\n", [{ source: "kb/assets/hero-v2-1.jpg", signedUrl: "https://s/1", publicUrl: null, alt: "1" }]);
  assert.deepEqual(sub.data.missing, ["hero.jpg"]);
  const p: PieceData = { storyId: "kb", slot: "", name: "kb", pillar: null, date: null, cards: [{ channel: "newsletter", copy: piece({ id: "kb-substack", kind: "copy" }),
    media: [piece({ id: "kb-h1", kind: "image" })], textStatus: "approved", assetStatus: "none", alternatives: ["kb-h1"], substack: sub }] };
  assert.deepEqual(openParts(p, pieceParts([p]).initial).changes, ["Substack image hero.jpg (not staged)"]);
});
