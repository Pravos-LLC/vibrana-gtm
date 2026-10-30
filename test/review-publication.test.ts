import test from "node:test";
import assert from "node:assert/strict";
import { withoutPublishedDecisions } from "../lib/review-publication";

test("published pending/rejected parts leave pipeline gates, while an image shared with an unpublished essay remains", () => {
  const assets = [
    { id: "done", story_id: "s", kind: "copy", source: "done.md", body: "![](shared.png) ![](old.png)" },
    { id: "open", story_id: "s", kind: "copy", source: "open.md", body: "![](shared.png)" },
    { id: "shared", story_id: "s", kind: "image", source: "shared.png" },
    { id: "old", story_id: "s", kind: "image", source: "old.png" },
    { id: "li", story_id: "s", kind: "copy", source: "li.md" },
  ];
  const rows = assets.map((a) => ({ asset_id: a.id, channel: a.id === "li" ? "linkedin" : "newsletter", status: "rejected" }));
  const published = [{ story_id: "s", channels: ["newsletter"], story_assets: ["done", "shared", "old"] }];
  assert.deepEqual(withoutPublishedDecisions(assets, rows, published).map((r) => r.asset_id), ["open", "shared", "li"]);
  published.push({ story_id: "s", channels: ["newsletter"], story_assets: ["open", "shared"] });
  assert.deepEqual(withoutPublishedDecisions(assets, rows, published).map((r) => r.asset_id), ["li"]);
});
