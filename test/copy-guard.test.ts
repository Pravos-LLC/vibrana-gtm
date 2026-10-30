import test from "node:test";
import assert from "node:assert/strict";
import { assertNoAgentNotes, findAgentNotes, findBritishSpellings } from "../lib/copy-guard";

test("agent notes to John are found, in the body or a link line", () => {
  assert.deepEqual(findAgentNotes("Intro [JOHN: add a scene, where and when] more"), ["[JOHN: add a scene, where and when]"]);
  assert.equal(findAgentNotes("see https://x.dev/a?utm=1 [JOHN: public URL]?utm_source=linkedin").length, 1);
  assert.equal(findAgentNotes("[TODO fix] and [note: x]").length, 2);
  assert.deepEqual(findAgentNotes("John said [sic] and used an array [1, 2]"), []);
});

test("assertNoAgentNotes throws with the note and the item named", () => {
  assert.throws(() => assertNoAgentNotes("post-x-linkedin", "Hello [JOHN: fill]"), /post-x-linkedin: unresolved note/);
  assert.doesNotThrow(() => assertNoAgentNotes("post-x", "Clean text."));
  assert.doesNotThrow(() => assertNoAgentNotes("post-x", undefined));
});

test("British spellings are flagged as warnings", () => {
  assert.deepEqual(findBritishSpellings("I realise the colour and the centre are off; a 3 metre set"), ["realise", "colour", "centre", "metre"]);
  assert.deepEqual(findBritishSpellings("I realize the color and the center are off"), []);
});
