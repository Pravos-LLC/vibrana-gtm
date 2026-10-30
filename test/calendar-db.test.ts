import { test } from "node:test";
import assert from "node:assert/strict";
import { contentHash, rowToItem, siblingSource, validateRow, type ContentRow } from "../lib/calendar-db.ts";
import { fetchPreview, platformOf, validateInspiration } from "../lib/inspiration.ts";

test("contentHash covers exactly the text and the media list", () => {
  const a = contentHash({ body: "x", media: ["m1"] });
  assert.equal(a, contentHash({ body: "x", media: ["m1"] }));
  assert.notEqual(a, contentHash({ body: "x ", media: ["m1"] }));
  assert.notEqual(a, contentHash({ body: "x", media: ["m1", "m2"] }));
  assert.equal(contentHash({}), contentHash({ body: null, media: null }));
});

test("validateRow mirrors the database checks", () => {
  assert.deepEqual(validateRow({ id: "ok-1", date: "2026-10-05", time: "15:00", pillar: "lists", status: "idea", publication: "regenera" }), []);
  const bad = validateRow({ id: "Bad id", date: "2026/10/05", time: "\"15:00\"", pillar: "craft", status: "posted" as never, publication: "medium" });
  assert.equal(bad.length, 6, bad.join("\n"));
});

test("rowToItem maps a database row to a calendar item", () => {
  const row: ContentRow = {
    id: "x", week: 41, date: "2026-10-05", time: null, pillar: "proof", title: "t", format: "text", channels: ["linkedin"], status: "drafted",
    link: null, cta: null, zernio_post_id: null, published_at: null, urls: {}, story_id: null, story_assets: [], publication: null,
    body: "b", media: [], approved_hash: null, copy_path: null,
  };
  const item = rowToItem(row);
  assert.equal(item.time, undefined);
  assert.equal(item.body, "b");
  assert.equal(item.copy, undefined);
  assert.equal(siblingSource("../story/youtube.md", "../thumb/a.jpg"), "../thumb/a.jpg");
  assert.equal(siblingSource("a/b/youtube.md", "c.jpg"), "a/b/c.jpg");
});

test("inspiration helpers: platform detection, validation, preview fallbacks", async () => {
  assert.equal(platformOf("https://youtu.be/x"), "youtube");
  assert.equal(platformOf("https://www.linkedin.com/posts/x"), "linkedin");
  assert.equal(platformOf("https://iamregenera.substack.com/p/x"), "substack");
  assert.equal(platformOf("https://example.org/a"), "example.org");
  assert.deepEqual(validateInspiration({ url: "https://a.b", kind: "video", tags: ["ok-tag"] }), []);
  assert.equal(validateInspiration({ url: "javascript:alert(1)", kind: "reel" as never, pillar: "x", tags: ["Bad Tag"] }).length, 4);
  const failing = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
  assert.deepEqual(await fetchPreview("https://example.org", failing), {});
  const relative = (async () => new Response('<title>Plain</title><meta property="og:image" content="/rel.png">')) as unknown as typeof fetch;
  assert.deepEqual(await fetchPreview("https://example.org", relative), { title: "Plain", thumbnail: undefined });
});
