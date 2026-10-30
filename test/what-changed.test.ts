import test from "node:test";
import assert from "node:assert/strict";
import { clock, whatChanged } from "../lib/what-changed";
import type { AssetVersion, FeedbackItem, PieceAsset } from "../lib/season-review";

const v = (revision: number, label: string, over: Partial<AssetVersion> = {}): AssetVersion => ({ revision, label, createdAt: "", src: `v${revision}.mp4`, poster: null, prose: "", fields: {}, ...over });
const video = (versions: AssetVersion[]): PieceAsset => ({ id: "vid", title: "Video", kind: "video", revision: versions.at(-1)!.revision, source: "v.mp4", src: null, poster: null, ratio: 9 / 16, prose: "", fields: {}, status: "pending", feedback: [], versions });
const note = (revision: number, resolution = ""): FeedbackItem => ({ id: `n${revision}`, asset_id: "vid", channel: null, body: "Trim the open", created_at: "", resolved_at: resolution ? "x" : null, resolution, revision });
const roughApproved = [{ stage: "rough-cut", decision: "approved", assets: [{ asset_id: "vid", sha256: "a", revision: 4 }], decided_at: "2026-10-12" }];
const inputs = (keep: string, dialogue: string, broll?: string) => ({ keep: keep.repeat(64), dialogue: dialogue.repeat(64), ...(broll ? { broll: broll.repeat(64) } : {}) });

test("the final after a rough-cut approval: the agent's summary, the provably unchanged edit, and the jump points", () => {
  const asset = video([
    v(4, "v1.3", { stage: "rough-cut", changes: "Raw-track audio", meta: { inputs: inputs("a", "b") } }),
    v(5, "v1.4", { stage: "final", changes: "B-roll B1 to B7, six Motion beats", meta: { inputs: inputs("a", "b", "c"), review_points: [{ t: 9, label: "B4 GPU rack" }] } }),
  ]);
  const w = whatChanged(asset, roughApproved, []);
  assert.deepEqual(w.since, { label: "v1.3", revision: 4, why: "your rough cut approval" });
  assert.deepEqual(w.summary, [{ label: "v1.4", text: "B-roll B1 to B7, six Motion beats" }]);
  assert.deepEqual(w.unchanged, ["Edit (keep.json)", "Dialogue audio"]);
  assert.deepEqual(w.points, [{ t: 9, label: "B4 GPU rack" }]);
});

test("'unchanged' is never claimed when a hash is missing or differs", () => {
  const missing = video([v(4, "v1.3", { meta: {} }), v(5, "v1.4", { meta: { inputs: inputs("a", "b") } })]);
  assert.deepEqual(whatChanged(missing, roughApproved, []).unchanged, [], "the decided version recorded no hashes");
  const recut = video([v(4, "v1.3", { meta: { inputs: inputs("a", "b") } }), v(5, "v1.4", { meta: { inputs: inputs("x", "b") } })]);
  assert.deepEqual(whatChanged(recut, roughApproved, []).unchanged, ["Dialogue audio"]);
});

test("without a decision, the base is the last version John left a note on; answered notes are listed", () => {
  const asset = video([v(1, "v1"), v(2, "v1.1", { changes: "Trimmed 2.1s" })]);
  const w = whatChanged(asset, [], [note(1, "Trimmed 2.1s from the start.")]);
  assert.deepEqual([w.since?.label, w.since?.why], ["v1", "your last note"]);
  assert.deepEqual(w.addressed, [{ body: "Trim the open", resolution: "Trimmed 2.1s from the start." }]);
});

test("nothing newer than the decided version: no panel, but the jump points stay", () => {
  const asset = video([v(4, "v1.3", { meta: { review_points: [{ t: 1, label: "Hook" }] } })]);
  const w = whatChanged(asset, roughApproved, []);
  assert.equal(w.since, null);
  assert.deepEqual(w.points, [{ t: 1, label: "Hook" }]);
  assert.equal(clock(69.5), "1:09");
});
