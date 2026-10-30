import { test } from "node:test";
import assert from "node:assert/strict";
import { CONTENT_REMEMBERED, filterCookie, rememberedQuery, restoredHref } from "../lib/filter-memory";

test("only the remembered filters that are set are kept, in a stable order", () => {
  const form: [string, string][] = [["q", "carousel"], ["status", "pending"], ["platform", ""], ["piece", "s1-07"], ["platform", "linkedin"]];
  assert.equal(rememberedQuery(form, CONTENT_REMEMBERED), "platform=linkedin&status=pending");
  assert.equal(rememberedQuery([], CONTENT_REMEMBERED), "");
});

test("a bare visit goes to the remembered view; any query, an empty memory or unknown keys leave it alone", () => {
  assert.equal(restoredHref("/content", {}, "status=pending", CONTENT_REMEMBERED), "/content?status=pending");
  assert.equal(restoredHref("/content", { piece: "s1-07", channel: "linkedin" }, "status=pending", CONTENT_REMEMBERED), null, "a finding's link is never changed");
  assert.equal(restoredHref("/content", {}, "", CONTENT_REMEMBERED), null);
  assert.equal(restoredHref("/content", {}, undefined, CONTENT_REMEMBERED), null);
  assert.equal(restoredHref("/content", {}, "piece=x&evil=1", CONTENT_REMEMBERED), null);
});

test("each view has its own cookie", () => {
  assert.notEqual(filterCookie("/content"), filterCookie("/studio"));
  assert.match(filterCookie("/content"), /^[A-Za-z0-9_]+$/);
});
