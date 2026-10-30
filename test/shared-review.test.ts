import test from "node:test";
import assert from "node:assert/strict";
import { writeCopy } from "../lib/season";
test("shared caption without optional fields saves without requiring a YAML mapping", () => {
  assert.equal(
    writeCopy("Plain caption", "New caption", {
      youtube_title: "",
      first_comment: "",
    }),
    "New caption\n",
  );
  assert.match(
    writeCopy("Plain caption", "New caption", {
      youtube_title: "My title",
      first_comment: "",
    }),
    /youtube_title: "My title"/,
  );
});
