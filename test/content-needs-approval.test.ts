import test from "node:test";
import assert from "node:assert/strict";
import { matchesStatus } from "../lib/season-review";
import { onSeasonBoard } from "../lib/season-id";

test("Needs approval takes every part waiting on John, a new version included", () => {
  assert.equal(matchesStatus({ text: "approved", asset: "new" }, "needs-approval"), true);
  assert.equal(matchesStatus({ text: "pending", asset: "approved" }, "needs-approval"), true);
  assert.equal(matchesStatus({ text: "approved", asset: "approved" }, "needs-approval"), false);
  assert.equal(matchesStatus({ text: "changes", asset: "approved" }, "needs-approval"), false);
});

test("New version still means only the parts showing one", () => {
  assert.equal(matchesStatus({ text: "approved", asset: "new" }, "new-version"), true);
  assert.equal(matchesStatus({ text: "pending", asset: "approved" }, "new-version"), false);
});

test("the season board takes s<N>- pieces and any Story a season claims", () => {
  assert.equal(onSeasonBoard({ id: "s1-01-sample-piece-01" }), true);
  assert.equal(onSeasonBoard({ id: "sample-extra-38", season_id: "season-1" }), true);
  assert.equal(onSeasonBoard({ id: "sample-extra-38", season_id: null }), false);
  assert.equal(onSeasonBoard({ id: "kb-tokenmaxxing" }), false);
});

test("at load the live filter keeps exactly the pieces the server filter listed, and an approval drops a piece", async () => {
  const { buildFixture } = await import("../app/dev-fixtures/content/fixture-data");
  const { STATUS_FILTERS, filterPieces, NO_FILTERS, pieceParts, buildGroups, stillMatchesFilter, cardSlot } = await import("../lib/season-review");
  const { partKey } = await import("../lib/review-state");
  const pieces = buildFixture({ image: "i", poster: "p", video: "v" }).pieces;
  const { initial } = pieceParts(pieces);
  for (const status of STATUS_FILTERS) {
    const listed = filterPieces(pieces, { ...NO_FILTERS, status }).map((p) => p.storyId);
    const live = pieces.filter((p) => stillMatchesFilter(p, p.groups ?? buildGroups(p.cards), initial, initial, status, "")).map((p) => p.storyId);
    assert.deepEqual(live.sort(), listed.sort(), status);
  }
  // Approving every part of a piece listed under Needs approval takes it out of that list.
  const piece = filterPieces(pieces, { ...NO_FILTERS, status: "needs-approval" }).find((p) => pieceParts([p]).summary.length);
  assert.ok(piece);
  const states = { ...initial };
  const groups = piece.groups ?? buildGroups(piece.cards);
  for (const c of piece.cards) { const k = partKey("text", piece.storyId, cardSlot(c)); states[k] = { ...states[k], status: "approved" }; }
  for (const k of Object.keys(states)) if (k.includes("media") && k.includes(piece.storyId)) states[k] = { ...states[k], status: "approved" };
  assert.equal(stillMatchesFilter(piece, groups, states, initial, "needs-approval", ""), false);
});
