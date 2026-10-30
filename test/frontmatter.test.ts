import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCopy } from "../lib/calendar.ts";
import { frontmatterMeta, splitFrontmatter } from "../lib/frontmatter.ts";
import { readFields } from "../lib/season.ts";

const copy = (fm: string, body = "Post body.") => parseCopy(`---\n${fm}\n---\n${body}`);

test("parseCopy: literal block scalar |- keeps every line and drops the final newline", () => {
  const c = copy("first_comment: |-\n  Line one\n\n  https://x.y\ntitle: Next key");
  assert.equal(c.meta.first_comment, "Line one\n\nhttps://x.y");
  assert.equal(c.meta.title, "Next key");
  assert.equal(c.base, "Post body.");
});

test("parseCopy: literal block scalar | keeps the trailing newline", () => {
  assert.equal(copy("first_comment: |\n  Read it here:\n  https://brand.example.com/a").meta.first_comment, "Read it here:\nhttps://brand.example.com/a\n");
});

test("parseCopy: folded block scalar > joins lines with spaces", () => {
  assert.equal(copy("first_comment: >-\n  One sentence that\n  wraps in the file.").meta.first_comment, "One sentence that wraps in the file.");
  assert.equal(copy("youtube_title: >\n  Folded\n  title").meta.youtube_title, "Folded title\n");
});

test("parseCopy: quoted values keep colons, plain URL values stay whole", () => {
  const c = copy(`youtube_title: "Power vs purpose: the real question"\ntitle: 'It''s: fine'\nfirst_comment: https://brand.example.com/x?a=1&b=2#c`);
  assert.equal(c.meta.youtube_title, "Power vs purpose: the real question");
  assert.equal(c.meta.title, "It's: fine");
  assert.equal(c.meta.first_comment, "https://brand.example.com/x?a=1&b=2#c");
});

test("parseCopy: multi-paragraph first_comment with a link, and per-channel overrides still split", () => {
  const c = parseCopy("---\nfirst_comment: |-\n  The full essay is on Substack.\n\n  It covers the three loops.\n\n  https://sample_author.substack.com/p/loops\nyoutube_tags: [ai, ops]\nyoutube_category_id: 28\n---\nBase.\n--- channel: instagram ---\nIG text");
  assert.equal(c.meta.first_comment, "The full essay is on Substack.\n\nIt covers the three loops.\n\nhttps://sample_author.substack.com/p/loops");
  assert.equal(c.meta.youtube_tags, "ai, ops");
  assert.equal(c.meta.youtube_category_id, "28");
  assert.equal(c.base, "Base.");
  assert.deepEqual(c.perChannel, { instagram: "IG text" });
});

test("frontmatterMeta: hand-written lines that are not strict YAML keep their raw value, block scalars still parse", () => {
  // `Full case study: https://...` is a plain scalar with ": " in it; YAML rejects the whole block.
  const fm = "status: drafted\ndrivers: builder-identity, shared-weight-relief\nfirst_comment: Full case study: https://brand.example.com/case-studies/sample-extra-38\nyoutube_title: |-\n  Two\n  lines";
  assert.deepEqual(frontmatterMeta(fm), {
    status: "drafted", drivers: "builder-identity, shared-weight-relief",
    first_comment: "Full case study: https://brand.example.com/case-studies/sample-extra-38", youtube_title: "Two\nlines",
  });
  assert.equal(frontmatterMeta(`title: "Quoted: a: b`).title, `"Quoted: a: b`);
});

test("frontmatterMeta: non-mapping and nested values degrade safely", () => {
  assert.deepEqual(frontmatterMeta("- a\n- b"), {});
  assert.deepEqual(frontmatterMeta("nested:\n  a: 1\nempty:\nok: yes"), { empty: "", ok: "yes" });
});

test("splitFrontmatter and readFields agree with parseCopy on block scalars", () => {
  const text = "---\nfirst_comment: |-\n  Line one\n\n  https://x.y\n---\n\nProse.";
  const { frontmatter, prose } = splitFrontmatter(text);
  assert.equal(prose, "Prose.");
  assert.deepEqual(readFields(frontmatter), { first_comment: "Line one\n\nhttps://x.y" });
});
