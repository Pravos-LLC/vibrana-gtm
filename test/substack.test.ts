import { test } from "node:test";
import assert from "node:assert/strict";
import { publicationOf, substackExport } from "../lib/substack.ts";

const DRAFT = `---
title: "I set out to build products. I ended up helping a company become AI-Native"
status: "draft"
channel: "personal-substack"
subject: "I set out to build products. Then a CEO called."
previewText: "A return to writing."
---

# I set out to build products. I ended up helping a company become AI-Native

A two-week product sprint led to six weeks of company-wide AI work.

![Sample Author in a white shirt.](assets/personal-header.jpg)

## Finding my way back

It's been a while. I [wrote about that sprint](https://sample_author.substack.com/p/two-week).

John

*Adapted from [the original essay](https://www.sample-author.com/blog/x?utm_source=personal-substack&utm_medium=email).*

*Sample Person is the fictional name used in our published case study.*
`;
const PUBLIC = "https://pub-test.r2.dev/stories/sample-extra-38/orion-perspectives-personal-header-a2650e1dd0e909cd.jpg";

test("strips frontmatter, the H1 and the italic footer; images point at the permanent URL", () => {
  const out = substackExport(DRAFT, [{ file: "personal-header.jpg", url: PUBLIC, permanent: true }]);
  assert.equal(out.publication, "sample_author");
  assert.equal(out.title, "I set out to build products. I ended up helping a company become AI-Native");
  assert.equal(out.subtitle, "A return to writing.");
  assert.equal(out.subject, "I set out to build products. Then a CEO called.");
  assert.equal(out.html, [
    "<p>A two-week product sprint led to six weeks of company-wide AI work.</p>",
    `<figure><img src="${PUBLIC}" alt="Sample Author in a white shirt."></figure>`,
    "<h2>Finding my way back</h2>",
    "<p>It's been a while. I <a href=\"https://sample_author.substack.com/p/two-week\">wrote about that sprint</a>.</p>",
    "<p>John</p>",
  ].join("\n"));
  assert.doesNotMatch(out.html, /<h1|status:|Sample Person is the fictional|Adapted from|footer/);
  assert.match(out.footer, /^\*Adapted from[\s\S]*\*Sample Person is the fictional name used in our published case study\.\*$/);
  assert.deepEqual(out.images, [{ file: "personal-header.jpg", url: PUBLIC, permanent: true, alt: "Sample Author in a white shirt." }]);
  assert.deepEqual(out.missing, []);
  assert.deepEqual(out.expiring, []);
  assert.equal(out.text, "A two-week product sprint led to six weeks of company-wide AI work.\n\nFinding my way back\n\nIt's been a while. I wrote about that sprint (https://sample_author.substack.com/p/two-week).\n\nJohn");
});

test("flags expiring and missing images instead of shipping broken links", () => {
  const md = "# T\n\n![a](assets/one.jpg)\n\n![b](assets/two.png)\n\nBody.";
  const out = substackExport(md, [{ file: "one.jpg", url: "https://x.supabase.co/storage/v1/object/sign/a?token=t", permanent: false }]);
  assert.deepEqual(out.expiring, ["one.jpg"]);
  assert.deepEqual(out.missing, ["two.png"]);
  assert.doesNotMatch(out.html, /two\.png|assets\//);
  assert.equal(out.title, "T", "falls back to the H1 when frontmatter has no title");
  assert.equal(out.publication, null);
});

test("an explicit footer marker wins and raw <footer> HTML is always removed", () => {
  const md = "---\npublication: regenera\nsubtitle: Sub\n---\n# H\n\nKeep *this italic* line.\n\n<footer>Local review preview.</footer>\n\n<!-- footer -->\n\nThanks for reading. Subscribe.";
  const out = substackExport(md, []);
  assert.equal(out.publication, "regenera");
  assert.equal(out.subtitle, "Sub");
  assert.equal(out.html, "<p>Keep <em>this italic</em> line.</p>");
  assert.equal(out.footer, "Thanks for reading. Subscribe.");
});

test("never removes the whole body even when every paragraph is italic", () => {
  const out = substackExport("*Only line.*", []);
  assert.equal(out.html, "<p><em>Only line.</em></p>");
  assert.equal(out.footer, "");
});

test("unsafe markup is neutralised (commonmark safe mode)", () => {
  const out = substackExport("[x](javascript:alert(1))\n\n<script>alert(1)</script>", []);
  assert.doesNotMatch(out.html, /javascript:|<script/);
});

test("publicationOf maps both draft channels and rejects unknown values", () => {
  assert.equal(publicationOf({ channel: "personal-substack" }), "sample_author");
  assert.equal(publicationOf({ channel: "regenera-substack" }), "regenera");
  assert.equal(publicationOf({ publication: "regenera", channel: "personal-substack" }), "regenera");
  assert.equal(publicationOf({ publication: "medium" }), null);
});
