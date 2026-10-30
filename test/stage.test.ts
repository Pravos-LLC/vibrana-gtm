import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { holdHeadline, isFinalStage, nonFinal, notFinalReason, pieceStage, stageBadge, STAGE_PATTERN } from "../lib/stage";

test("only a stageless (legacy) or final asset is final", () => {
  assert.equal(isFinalStage(null), true);
  assert.equal(isFinalStage(undefined), true);
  assert.equal(isFinalStage("final"), true);
  assert.equal(isFinalStage("rough-cut"), false);
  assert.equal(STAGE_PATTERN.test("rough-cut"), true);
  assert.equal(STAGE_PATTERN.test("Rough Cut"), false);
});

test("text has its own lane: only media is ever short of final", () => {
  const assets = [{ id: "v", kind: "video", stage: "rough-cut" }, { id: "c", kind: "copy", stage: "rough-cut" }, { id: "i", kind: "image", stage: null }];
  assert.deepEqual(nonFinal(assets).map((a) => a.id), ["v"]);
});

test("the badge for a short at rough cut is exactly 'Rough cut · no B-roll · no Motion'; final has none", () => {
  assert.equal(stageBadge("rough-cut"), "Rough cut · no B-roll · no Motion");
  assert.equal(stageBadge("final"), null);
  assert.equal(stageBadge(null), null);
  assert.equal(stageBadge("color-grade"), "Color grade");
});

test("a piece is at the earliest non-final stage of its media", () => {
  assert.equal(pieceStage([{ kind: "video", stage: "final" }, { kind: "copy" }]), null);
  assert.equal(pieceStage([{ kind: "video", stage: "b-roll" }, { kind: "image", stage: "rough-cut" }]), "rough-cut");
  assert.match(notFinalReason([{ title: "Video 9:16", stage: "rough-cut" }]), /^not final: Video 9:16 is at stage rough-cut; only a final cut is scheduled$/);
});

test("a hold blocks publishing, not a version", () => {
  assert.equal(holdHeadline("example_approver / Example Series"), "Publishing blocked until example_approver / Example Series approves the final");
  assert.equal(holdHeadline(""), "Publishing blocked until a third party approves the final");
});

test("the stage migration marks exactly the Example Series videos (pieces 18 to 22) as rough cuts and rewords their holds", () => {
  const sql = readFileSync(new URL("../supabase/migrations/20261012210000_gtm_story_asset_stage.sql", import.meta.url), "utf8");
  const pattern = new RegExp(sql.match(/where story_id ~ '([^']+)' and kind = 'video' and stage is null/)![1]);
  for (const id of ["s1-18-example-record-19", "s1-19-example-record-20", "s1-20-example-record-21", "s1-21-example-record-22", "s1-22-example-record-23"]) assert.ok(pattern.test(id), id);
  for (const id of ["s1-07-example-record-8", "sample-extra-117", "s1-23-sn-later"]) assert.ok(!pattern.test(id), id);
  assert.match(sql, /set stage = 'rough-cut'/);
  assert.match(sql, /hold_note = 'example_approver only ever sees final versions, never rough cuts'/);
  // Deliberate: no refusal in the decision RPC; approving a rough cut is allowed and means "the edit is good".
  assert.doesNotMatch(sql, /gtm_decide_story_asset/);
});
