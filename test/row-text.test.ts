import test from "node:test";
import assert from "node:assert/strict";
import { rowText } from "../lib/row-text";

test("a row's own text wins; an unsent Story row reads its Story's copy; nothing else is guessed", () => {
  const assets = new Map([
    ["s-cover", { id: "s-cover", kind: "image" }],
    ["s-linkedin-copy", { id: "s-linkedin-copy", kind: "copy", body: "The approved text" }],
  ]);
  assert.equal(rowText({ body: "What went out", story_assets: ["s-linkedin-copy"] }, assets), "What went out");
  assert.equal(rowText({ body: null, story_assets: ["s-cover", "s-linkedin-copy"] }, assets), "The approved text");
  assert.equal(rowText({ body: null, story_assets: ["s-cover"] }, assets), null);
  assert.equal(rowText({ body: null, story_assets: null }, assets), null);
});
