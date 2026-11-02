import test from "node:test";
import assert from "node:assert/strict";
import { rowText } from "../lib/row-text";

test("an unsent Story row reads its Story's copy, even over a stale copy; a sent row reads what went out", () => {
  const assets = new Map([
    ["s-cover", { id: "s-cover", kind: "image" }],
    ["s-linkedin-copy", { id: "s-linkedin-copy", kind: "copy", body: "The approved text" }],
  ]);
  const row = { story_id: "s", story_assets: ["s-cover", "s-linkedin-copy"] };
  assert.equal(rowText({ ...row, body: null, status: "drafted" }, assets), "The approved text");
  assert.equal(rowText({ ...row, body: "A stale copy", status: "approved" }, assets), "The approved text");
  assert.equal(rowText({ ...row, body: "What went out", status: "scheduled", zernio_post_id: "z1" }, assets), "What went out");
  assert.equal(rowText({ ...row, body: null, status: "scheduled", zernio_post_id: "z1" }, assets), "The approved text");
  assert.equal(rowText({ story_id: "s", story_assets: ["s-cover"], body: null, status: "drafted" }, assets), null);
  assert.equal(rowText({ story_id: null, story_assets: null, body: "A loose text post", status: "approved" }, assets), "A loose text post");
});
