import test from "node:test";
import assert from "node:assert/strict";
import { boundChannels, filesFor, planChannels, type PieceChannelState } from "../lib/piece-channels";
import { RHYTHM } from "../lib/rhythm";

const asset = (id: string, kind: string, stage: string | null = null) => ({ id, kind, sha256: "x".repeat(64), revision: 1, body: kind === "copy" ? "Text" : null, stage });
const piece = (over: Partial<PieceChannelState> = {}): PieceChannelState => ({
  storyId: "p",
  assets: [asset("p-copy", "copy"), asset("p-video", "video"), asset("p-cover", "image")],
  bindings: ["linkedin", "youtube"].flatMap((c) => ["p-copy", "p-video", "p-cover"].map((a) => ({ asset_id: a, channel: c, status: "pending" }))),
  rows: [],
  ...over,
});

test("ticks become adds and removes; a new channel gets the piece's one text and its media", () => {
  const s = piece();
  assert.deepEqual(boundChannels(s), ["linkedin", "youtube"]);
  assert.deepEqual(planChannels(s, ["linkedin", "instagram"]), { on: ["linkedin", "instagram"], add: ["instagram"], off: ["youtube"], errors: [] });
  assert.deepEqual(filesFor(s, "instagram", ["linkedin"]).map((a) => a.id), ["p-copy", "p-video", "p-cover"]);
  assert.deepEqual(planChannels(s, ["linkedin", "youtube"]), { on: ["linkedin", "youtube"], add: [], off: [], errors: [] });
});

test("refusals: no channel, a channel the media cannot feed, a blocked pillar, a channel that already went out, a rough cut", () => {
  assert.match(planChannels(piece(), []).errors.join(" "), /Tick at least one channel/);
  const textOnly = piece({ assets: [asset("p-copy", "copy")], bindings: [{ asset_id: "p-copy", channel: "linkedin", status: "pending" }] });
  assert.match(planChannels(textOnly, ["linkedin", "youtube"]).errors.join(" "), /YouTube needs a video/);
  assert.match(planChannels(textOnly, ["linkedin", "instagram"]).errors.join(" "), /Instagram needs an image or a video/);
  RHYTHM.blocked = [{ channel: "instagram", pillars: ["proof"] }];
  try {
    const proof = piece({ rows: [{ id: "p-linkedin", status: "drafted", channels: ["linkedin"], pillar: "proof", zernio_post_id: null }] });
    assert.match(planChannels(proof, ["linkedin", "instagram"]).errors.join(" "), /never takes proof/);
  } finally { delete RHYTHM.blocked; }
  const sent = piece({ rows: [{ id: "p-youtube", status: "published", channels: ["youtube"], pillar: "perspective", zernio_post_id: "z1" }] });
  assert.match(planChannels(sent, ["linkedin"]).errors.join(" "), /already went out on youtube/);
  const rough = piece({ assets: [asset("p-copy", "copy"), asset("p-video", "video", "rough-cut"), asset("p-cover", "image")] });
  assert.match(planChannels(rough, ["linkedin", "youtube"]).errors.join(" "), /rough cut/);
});
