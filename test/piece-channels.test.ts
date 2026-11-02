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

test("YouTube needs the copy's YouTube title; a copy that has one is preferred", () => {
  const two = piece({
    assets: [asset("p-li", "copy"), { ...asset("p-yt", "copy"), body: "---\nyoutube_title: A title\n---\nText" }, asset("p-video", "video")],
    bindings: [{ asset_id: "p-li", channel: "linkedin", status: "pending" }, { asset_id: "p-yt", channel: "instagram", status: "pending" }, ...["linkedin", "instagram"].map((c) => ({ asset_id: "p-video", channel: c, status: "pending" }))],
  });
  assert.deepEqual(filesFor(two, "youtube", ["linkedin", "instagram"]).map((a) => a.id), ["p-yt", "p-video"]);
  assert.deepEqual(planChannels(two, ["linkedin", "instagram", "youtube"]).errors, []);
  const none = piece({ bindings: ["p-copy", "p-video"].map((a) => ({ asset_id: a, channel: "linkedin", status: "pending" })) });
  assert.match(planChannels(none, ["linkedin", "youtube"]).errors.join(" "), /YouTube needs a title/);
});

test("the text is checked before anything changes: an open note to John or LinkedIn over 4,000 characters refuses", () => {
  const noted = piece({ assets: [{ ...asset("p-copy", "copy"), body: "Hello [JOHN: add the number]" }, asset("p-video", "video"), asset("p-cover", "image")] });
  assert.match(planChannels(noted, ["linkedin", "youtube"]).errors.join(" "), /note to John/);
  const long = piece({ assets: [{ ...asset("p-copy", "copy"), body: "x".repeat(4100) }, asset("p-video", "video"), asset("p-cover", "image")] });
  assert.ok(planChannels(long, ["linkedin", "youtube"]).errors.some((e) => /4,000|too long/i.test(e)));
});

test("a pillar kept only in the copy's front matter still blocks Instagram", () => {
  RHYTHM.blocked = [{ channel: "instagram", pillars: ["build"] }];
  try {
    const s = piece({ assets: [{ ...asset("p-copy", "copy"), body: "---\npillar: build\n---\nText" }, asset("p-video", "video"), asset("p-cover", "image")] });
    assert.match(planChannels(s, ["linkedin", "instagram"]).errors.join(" "), /never takes build/);
  } finally { delete RHYTHM.blocked; }
});
