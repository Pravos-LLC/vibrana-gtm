// Channel link rules: URL detection, per-channel errors and the YouTube Shorts soft rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkChannelLinks, findUrls, hasUrl, isShort, shapeFromName } from "../lib/channel-rules.ts";
import { parseCopy } from "../lib/calendar.ts";

test("findUrls: https, http, www. and bare domains with a path count as links", () => {
  assert.deepEqual(findUrls("Read it: https://brand.example.com/case-studies/orion?ref=li."), ["https://brand.example.com/case-studies/orion?ref=li"]);
  assert.deepEqual(findUrls("old http://example.com"), ["http://example.com"]);
  assert.deepEqual(findUrls("go to brand.example.com/case-studies/x now"), ["brand.example.com/case-studies/x"]);
  assert.deepEqual(findUrls("visit www.brand.example.com today"), ["www.brand.example.com"]);
  assert.deepEqual(findUrls("brand.example.com is live"), ["brand.example.com"]);
  assert.deepEqual(findUrls("short link lnkd.in/abc and bit.ly/x"), ["lnkd.in/abc", "bit.ly/x"]);
  assert.deepEqual(findUrls("(see https://a.com/b)"), ["https://a.com/b"]);
  assert.deepEqual(findUrls("brand.example.com."), ["brand.example.com"], "sentence punctuation is not part of the link");
});

test("findUrls: email addresses, file names, abbreviations and numbers are not links", () => {
  for (const text of [
    "write to user-f538cb95fc21@example.com",
    "user-ce3dd6e43b4a@example.com",
    "Built with Next.js, see README.md, e.g. this",
    "3.5x faster in the U.S. and the E.U.",
    "Do it.So simple.",
    "#vibrana @john",
    "",
  ]) assert.deepEqual(findUrls(text), [], text);
  assert.equal(hasUrl(null), false);
  assert.equal(hasUrl("user-f538cb95fc21@example.com"), false);
  assert.equal(hasUrl("user-f538cb95fc21@example.com or brand.example.com/contact"), true);
});

const copy = (text: string) => parseCopy(text);

test("instagram: a URL in the caption is an error; a linked first_comment is a warning", () => {
  const r = checkChannelLinks("ig", ["instagram"], copy("---\nfirst_comment: https://brand.example.com/x\n---\nCaption with brand.example.com/x"));
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /^ig: instagram caption contains a link \(brand\.example\.com\/x\)/);
  assert.match(r.warnings.join("\n"), /instagram does not get first_comment/);
  assert.deepEqual(checkChannelLinks("ig", ["instagram"], copy("Plain caption #ai")), { errors: [], warnings: [] });
});

test("instagram: the per-channel override is what is checked", () => {
  const text = "Base with https://brand.example.com\n--- channel: instagram ---\nIG caption, no link";
  assert.deepEqual(checkChannelLinks("x", ["instagram"], copy(text)).errors, []);
  assert.equal(checkChannelLinks("x", ["linkedin"], copy(text)).errors.length, 1, "linkedin gets the base text");
});

test("linkedin: a URL in the body is an error pointing at first_comment; a linked first_comment is fine", () => {
  const bad = checkChannelLinks("li", ["linkedin"], copy("Post body www.brand.example.com"));
  assert.match(bad.errors[0], /linkedin body contains a link \(www\.brand\.example\.com\)\. Move it to first_comment/);
  assert.deepEqual(checkChannelLinks("li", ["linkedin"], copy("---\nfirst_comment: https://brand.example.com/x\n---\nBody, email user-f538cb95fc21@example.com")), { errors: [], warnings: [] });
});

test("youtube: soft rule only, never an error", () => {
  const linked = copy("Description https://brand.example.com/orion");
  const vertical = checkChannelLinks("yt", ["youtube"], linked, { width: 1080, height: 1920, duration: 20 });
  assert.deepEqual(vertical.errors, []);
  assert.match(vertical.warnings[0], /publishes as a Short: description and comment links are NOT clickable/);
  assert.deepEqual(checkChannelLinks("yt", ["youtube"], linked, { width: 1920, height: 1080, duration: 20 }), { errors: [], warnings: [] }, "16:9 is a regular video");
  assert.match(checkChannelLinks("yt", ["youtube"], linked).warnings[0], /only clickable if the upload is a regular video/);
  assert.match(checkChannelLinks("yt", ["youtube"], copy("No link"), { width: 16, height: 9 }).warnings[0], /no link in the description or first_comment/);
});

test("isShort and shapeFromName", () => {
  assert.equal(isShort({ width: 1080, height: 1920, duration: 20 }), true);
  assert.equal(isShort({ width: 1080, height: 1080, duration: 60 }), true, "square counts");
  assert.equal(isShort({ width: 1080, height: 1920, duration: 240 }), false, "over 3 min is a regular video");
  assert.equal(isShort({ width: 1920, height: 1080, duration: 20 }), false, "horizontal is never a Short");
  assert.deepEqual(shapeFromName("../orion-teaser/output/teaser-16x9.mp4"), { width: 16, height: 9 });
  assert.deepEqual(shapeFromName("calendar/x/abc-cut_9x16.mov"), { width: 9, height: 16 });
  assert.equal(shapeFromName("teaser.mp4"), null);
});
