import test from "node:test";
import assert from "node:assert/strict";
import { diffWords, hasChanges } from "../lib/text-diff";

const render = (parts: ReturnType<typeof diffWords>) => parts.map((p) => (p.type === "same" ? p.text : p.type === "add" ? `[+${p.text}]` : `[-${p.text}]`)).join("");

test("a word-level diff marks what was added and removed, and keeps the rest", () => {
  assert.equal(render(diffWords("The widgets are part of the set.", "So the widgets are just part of the set.")), "[-The][+So] [+the ]widgets are [+just ]part of the set.");
  assert.equal(render(diffWords("Bxoes of the Example Team", "Boxes of the Example Team")), "[-Bxoes][+Boxes] of the Example Team");
});

test("identical text is one unchanged part; empty sides are a pure add or delete; whitespace alone is no change", () => {
  assert.deepEqual(diffWords("same", "same"), [{ type: "same", text: "same" }]);
  assert.deepEqual(diffWords("", ""), []);
  assert.deepEqual(diffWords("", "new text"), [{ type: "add", text: "new text" }]);
  assert.deepEqual(diffWords("old", ""), [{ type: "del", text: "old" }]);
  assert.equal(hasChanges(diffWords("a b", "a  b")), false);
  assert.equal(hasChanges(diffWords("a b", "a c")), true);
});

test("the diff round-trips: the kept and added parts rebuild the new text, the kept and deleted parts the old", () => {
  const before = "Line one.\n\nLine two has a hook.\n#tags #here";
  const after = "A new hook.\n\nLine two has a better hook.\n#tags";
  const parts = diffWords(before, after);
  assert.equal(parts.filter((p) => p.type !== "del").map((p) => p.text).join(""), after);
  assert.equal(parts.filter((p) => p.type !== "add").map((p) => p.text).join(""), before);
});
