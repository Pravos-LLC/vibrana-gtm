// Shared pieces under the /content filters (review #147 B3): the same words as the legacy cards.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sharedMatches, sharedStageKey, sharedStatuses } from "../lib/shared-filter.ts";
import { parseFilters } from "../lib/season-review.ts";
import type { PieceReviewSnapshot, SharedDecision } from "../lib/piece-review.ts";

const snap = (text: SharedDecision, video: SharedDecision, extra: Partial<PieceReviewSnapshot> = {}): PieceReviewSnapshot => ({
  storyId: "s1-70-reel", channels: ["linkedin", "youtube"],
  text: { asset: { id: "t", body: "The river caption" } as never, fingerprint: "ft", status: text, decidedAt: null },
  video: { asset: { id: "v", stage: null } as never, fingerprint: "fv", status: video, decidedAt: null },
  fixes: [], legacyFixes: [], blockers: [], ready: false, dispatchEnabled: true, ...extra,
});
const facts = { title: "River reel", series: "sun-nation", pillar: "proof", notes: ["Trim the intro"] };
const under = (s: PieceReviewSnapshot, q: Record<string, string>) => sharedMatches(s, parseFilters(q), facts);

test("an approved shared piece is never under Needs approval; each state lands under its own filter", () => {
  const approved = snap("approved", "approved");
  assert.deepEqual(sharedStatuses(approved), ["approved"]);
  assert.equal(under(approved, { status: "needs-approval" }), false);
  assert.equal(under(approved, { status: "approved" }), true);
  assert.deepEqual(sharedStatuses(snap("pending", "approved")), ["needs-approval"]);
  assert.deepEqual(sharedStatuses(snap("approved", "changes")), ["needs-changes"]);
  assert.deepEqual(sharedStatuses(snap("fixing", "approved", { fixes: [{ id: "f" } as never] })), ["waiting-fix"]);
  assert.deepEqual(sharedStatuses(snap("approved", "approved", { legacyFixes: [{ id: "n", asset_id: "t", body: "", revision: 1 }] })), ["waiting-fix"], "an accepted note still to assign is not approved");
  assert.equal(under(snap("pending", "pending"), { status: "new-version" }), false);
});

test("platform, series, pillar, stage, piece and search filters apply to shared pieces too", () => {
  const s = snap("pending", "approved");
  assert.equal(under(s, { platform: "youtube" }), true);
  assert.equal(under(s, { platform: "instagram" }), false);
  assert.equal(under(s, { platform: "newsletter" }), false);
  assert.equal(under(s, { series: "sun-nation" }), true);
  assert.equal(under(s, { series: "coherence" }), false);
  assert.equal(under(s, { pillar: "proof" }), true);
  assert.equal(under(s, { pillar: "perspective" }), false);
  assert.equal(under(s, { stage: "final" }), true);
  assert.equal(sharedStageKey(snap("approved", "approved")), "approved");
  assert.equal(sharedStageKey({ ...s, video: { ...s.video, asset: { stage: "rough-cut" } as never } }), "rough-cut");
  assert.equal(under(s, { piece: "s1-70-reel" }), true);
  assert.equal(under(s, { piece: "other" }), false);
  assert.equal(under(s, { q: "river trim" }), true, "title, caption and notes are searched");
  assert.equal(under(s, { q: "ocean" }), false);
});

test("shared text/video approval never hides a cover still awaiting a decision", () => {
  const approved = snap("approved", "approved");
  assert.equal(sharedMatches(approved, parseFilters({ status: "needs-approval" }), { ...facts, coverStatuses: ["pending"] }), true);
  assert.equal(sharedMatches(approved, parseFilters({ status: "approved" }), { ...facts, coverStatuses: ["pending"] }), false);
  assert.equal(sharedMatches(approved, parseFilters({ status: "needs-changes" }), { ...facts, coverStatuses: ["rejected"] }), true);
  assert.equal(sharedMatches(approved, parseFilters({ status: "approved" }), { ...facts, coverStatuses: ["approved"] }), true);
});
