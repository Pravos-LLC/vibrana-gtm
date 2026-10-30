import test from "node:test";
import assert from "node:assert/strict";
import { assertWebPlayable, webPlayableProblems } from "../lib/video-playable";
import { mp4 } from "./support/mp4";

test("a faststart H.264 High MP4 passes", () => {
  assert.deepEqual(webPlayableProblems(mp4()), []);
  assert.deepEqual(webPlayableProblems(mp4({ profile: 77 })), []);
});

test("High 4:4:4 (the clip 02-05 failure) is rejected", () => {
  assert.match(webPlayableProblems(mp4({ profile: 244 })).join(), /High 4:4:4 Predictive/);
  assert.match(webPlayableProblems(mp4({ profile: 110 })).join(), /High 10/);
});

test("moov after the media data is rejected", () => {
  assert.match(webPlayableProblems(mp4({ faststart: false })).join(), /not faststart/);
});

test("non-H.264 video and non-MP4 bytes are rejected", () => {
  assert.match(webPlayableProblems(mp4({ codec: "hvc1" })).join(), /hvc1, not H.264/);
  assert.match(webPlayableProblems(Buffer.from("not a video")).join(), /no moov/);
});

test("the error names the file and carries the re-encode command", () => {
  assert.throws(() => assertWebPlayable(mp4({ profile: 244, faststart: false }), "clip02.mp4"), /clip02\.mp4 will not play[\s\S]*not faststart[\s\S]*-pix_fmt yuv420p/);
});
