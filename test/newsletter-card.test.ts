// The Substack card in /content: which essay shows which images, what "Copy for Substack" pastes when the public bucket is
// not configured, how the card is filtered and counted, and that an approved newsletter is never sent to Zernio.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newsletterExport, newsletterParts, publishedUrl, withoutAlternatives, withoutPublished } from "../lib/newsletter-card.ts";
import { substackEditorUrl } from "../lib/publications.ts";
import { buildGroups, cardSlot, filterPieces, parseFilters, pieceParts, summarize, type CardData, type PieceAsset, type PieceData } from "../lib/season-review.ts";
import { partKey } from "../lib/review-state.ts";
import { planSlots } from "../lib/auto-schedule.ts";
import { allHandPublished, isHandPublished } from "../lib/hand-published.ts";
import { sendCalendarItem } from "../lib/publish-item.ts";
import type { Calendar, Item } from "../lib/calendar.ts";

const asset = (id: string, kind: string, source: string, body: string | null = null) => ({ id, kind, source, body });

test("one essay shows its header; two essays each show the images they name, and an image neither names shows on both", () => {
  const kb = [
    asset("kb-substack", "copy", "story/substack.md", "# Your AI bill\n\n![Header](assets/hero.jpg)\n"),
    asset("kb-linkedin", "copy", "story/linkedin.md", "post"),
    asset("kb-header", "image", "story/assets/hero.jpg"),
  ];
  const kbRows = [{ asset_id: "kb-substack", channel: "newsletter" }, { asset_id: "kb-header", channel: "newsletter" }, { asset_id: "kb-linkedin", channel: "linkedin" }];
  assert.deepEqual(newsletterParts(kb, kbRows).map((p) => [p.copy.id, p.media.map((m) => m.id)]), [["kb-substack", ["kb-header"]]]);

  const orion = [
    asset("o-personal", "copy", "p.md", "![Portrait](assets/personal-header.jpg)"),
    asset("o-regenera", "copy", "r.md", "![a](assets/regenera-01.jpg)\n![b](assets/regenera-02.jpg)"),
    asset("o-personal-header", "image", "assets/personal-header.jpg"),
    asset("o-regenera-01", "image", "assets/regenera-01.jpg"),
    asset("o-regenera-02", "image", "assets/regenera-02.jpg"),
    asset("o-loose", "image", "assets/spare.jpg"),
    asset("o-site-only", "image", "assets/site.jpg"),
  ];
  const rows = [...orion.filter((a) => a.id !== "o-site-only").map((a) => ({ asset_id: a.id, channel: "newsletter" })), { asset_id: "o-site-only", channel: "website" }];
  assert.deepEqual(newsletterParts(orion, rows).map((p) => [p.copy.id, p.media.map((m) => m.id)]), [
    ["o-personal", ["o-loose", "o-personal-header"]],
    ["o-regenera", ["o-loose", "o-regenera-01", "o-regenera-02"]],
  ]);
  assert.deepEqual(newsletterParts(kb, kbRows.filter((r) => r.channel !== "newsletter")), [], "no newsletter row, no card");
});

const DRAFT = `---
title: "Your AI bill is an org chart"
channel: personal-substack
previewText: "Agents waste tokens the way companies waste people."
---

# Your AI bill is an org chart

![Header](assets/hero.jpg)

The body.
`;

test("Copy for Substack falls back to the signed URL when the image has no public URL, and says it expires", () => {
  const signed = "https://x.supabase.co/storage/v1/object/sign/content-review/stories/kb/kb-header.jpg?token=t";
  const out = newsletterExport(DRAFT, [{ source: "story/assets/hero.jpg", signedUrl: signed, publicUrl: null, alt: "Header" }]);
  assert.equal(out.data.title, "Your AI bill is an org chart");
  assert.equal(out.data.subtitle, "Agents waste tokens the way companies waste people.");
  assert.match(out.data.html, /<img src="https:\/\/x\.supabase\.co\/storage\/v1\/object\/sign\/[^"]+" alt="Header">/);
  assert.match(out.data.text, /The body\./);
  assert.deepEqual(out.data.missing, []);
  assert.deepEqual(out.data.expiring, ["hero.jpg"]);
  assert.deepEqual(out.images.map((i) => [i.file, i.permanent, i.copyUrl]), [["hero.jpg", false, signed]]);
  assert.equal(out.editorUrl, "https://sample_author.substack.com/publish/post?type=newsletter");

  const pub = "https://pub.example/stories/kb/kb-header.jpg";
  const permanent = newsletterExport(DRAFT, [{ source: "story/assets/hero.jpg", signedUrl: signed, publicUrl: pub, alt: "Header" }]);
  assert.match(permanent.data.html, new RegExp(`<img src="${pub}"`));
  assert.deepEqual(permanent.data.expiring, []);
  assert.equal(permanent.images[0].copyUrl, signed, "Copy image reads the bytes through the signed URL");

  const unsigned = newsletterExport(DRAFT, [{ source: "story/assets/hero.jpg", signedUrl: null, publicUrl: null, alt: "Header" }]);
  assert.deepEqual(unsigned.data.missing, ["hero.jpg"], "an image that could not be signed is named, not pasted broken");
  assert.equal(newsletterExport(DRAFT.replace("personal-substack", "regenera-substack"), []).editorUrl, "https://iamregenera.substack.com/publish/post?type=newsletter");
  assert.equal(newsletterExport("No frontmatter.", []).editorUrl, null);
  assert.equal(substackEditorUrl("sample_author"), "https://sample_author.substack.com/publish/post?type=newsletter");
});

const piece = (over: Partial<PieceAsset> & { id: string; kind: PieceAsset["kind"] }): PieceAsset => ({
  title: over.id, revision: 1, source: `${over.id}.md`, src: null, poster: null, ratio: 0.8, prose: "", fields: {}, status: "pending", feedback: [], versions: [], ...over,
});
const card = (channel: CardData["channel"], copy: PieceAsset, media: PieceAsset[] = [], status: CardData["textStatus"] = "pending"): CardData =>
  ({ channel, copy, media, textStatus: status, assetStatus: media.length ? status : "none" });

test("a newsletter card is its own part: filtered as Substack, waiting under Needs approval, counted once per essay, never platform media", () => {
  const li = card("linkedin", piece({ id: "kb-linkedin", kind: "copy", prose: "LinkedIn text" }), [], "approved");
  const essay = card("newsletter", piece({ id: "kb-substack", kind: "copy", prose: "The essay" }), [piece({ id: "kb-header", kind: "image" })]);
  const second = card("newsletter", piece({ id: "kb-substack-2", kind: "copy", prose: "Second essay" }), [], "approved");
  const p: PieceData = { storyId: "kb", slot: "", name: "Tokenmaxxing", pillar: null, date: null, cards: [li, essay, second] };
  assert.deepEqual(buildGroups(p.cards), [], "newsletter images are decided on the newsletter card, never grouped with platform media");
  assert.deepEqual([cardSlot(li), cardSlot(essay), cardSlot(second)], ["linkedin", "newsletter:kb-substack", "newsletter:kb-substack-2"]);

  const { initial, summary } = pieceParts([p]);
  assert.equal(initial[partKey("text", "kb", "newsletter:kb-substack")]?.status, "pending");
  assert.equal(initial[partKey("media", "kb", "newsletter:kb-substack")]?.status, "pending");
  assert.equal(initial[partKey("media", "kb", "newsletter:kb-substack-2")], undefined, "no images, no media part");
  assert.deepEqual(summary.map((s) => s.key), ["kb:linkedin", "kb:newsletter:kb-substack", "kb:newsletter:kb-substack-2"]);
  const overview = summarize(summary);
  assert.deepEqual([overview.cards, overview.textTotal, overview.textApproved, overview.assetTotal], [3, 3, 2, 1]);

  const f = parseFilters({ platform: "newsletter", status: "needs-approval" });
  assert.deepEqual([f.platform, f.status], ["newsletter", "needs-approval"]);
  assert.equal(filterPieces([p], f).length, 1, "the pending essay shows under Substack + Needs approval");
  assert.equal(filterPieces([{ ...p, cards: [li, second] }], f).length, 0, "an approved essay does not");
  assert.equal(filterPieces([{ ...p, cards: [li] }], parseFilters({ platform: "newsletter" })).length, 0);
  assert.equal(filterPieces([p], parseFilters({ status: "needs-approval" })).length, 1, "Needs approval alone picks the essay up");
  assert.equal(filterPieces([{ ...p, cards: [li] }], parseFilters({ status: "needs-approval" })).length, 0);
  assert.equal(parseFilters({ platform: "website" }).platform, "", "only channels with a card are a filter");
});

const TZ = "Europe/Berlin";
const NOW = new Date("2026-10-12T01:15:00Z");
const item = (id: string, channel: string, extra: Partial<Item> = {}): Item => ({
  id, week: 0, date: "2026-10-14", time: "09:00", pillar: "perspective", title: id, format: "text", channels: [channel], status: "approved", ...extra,
});

test("an approved newsletter is never slotted, even when the calendar's manual list leaves it out", () => {
  const letter = item("kb-tokenmaxxing-newsletter", "newsletter", { story_id: "kb-tokenmaxxing" });
  const site = item("orion-website", "website");
  const li = item("kb-tokenmaxxing-linkedin", "linkedin", { story_id: "kb-tokenmaxxing" });
  const { slotted, skipped } = planSlots({ items: [letter, site, li], ready: [letter, site, li], now: NOW, timeZone: TZ, manual: [] });
  assert.deepEqual(slotted.map((s) => s.id), [li.id]);
  assert.deepEqual(skipped.map((s) => [s.id, s.reason]), [[letter.id, "newsletter is published by hand"], [site.id, "website is published by hand"]]);
  assert.equal(isHandPublished("newsletter") && isHandPublished("website") && !isHandPublished("linkedin"), true);
  assert.equal(allHandPublished(["newsletter"]), true);
  assert.equal(allHandPublished(["newsletter", "linkedin"]), false);
  assert.equal(allHandPublished([]), false);
});

test("an approved newsletter item is refused before any Zernio call, even with an empty manual list and a mapped account", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gtm-newsletter-"));
  try {
    mkdirSync(join(dir, "essay"), { recursive: true });
    writeFileSync(join(dir, "essay/substack.md"), "---\ntitle: Essay\n---\n\nThe essay.\n");
    const letter = item("essay-newsletter", "newsletter", { copy: "essay/substack.md", date: "2030-10-08" });
    const cal: Calendar = { path: join(dir, "calendar.yaml"), timezone: TZ, accounts: { newsletter: "would-be-zernio-id" }, manual: [], items: [letter] };
    const calls: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => { calls.push(String(url)); throw new Error("no network in this test"); }) as typeof fetch;
    try {
      await assert.rejects(sendCalendarItem(cal, letter.id, { dry: true }), /only targets manual channels/);
      await assert.rejects(sendCalendarItem(cal, letter.id), /only targets manual channels/);
    } finally { globalThis.fetch = real; }
    assert.deepEqual(calls, [], "nothing reached Zernio");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an essay with a recorded Substack URL is published; anything else is not", () => {
  assert.equal(publishedUrl({ metadata: { published_url: "https://sample_author.substack.com/p/x" } }), "https://sample_author.substack.com/p/x");
  assert.equal(publishedUrl({ metadata: {} }), null);
  assert.equal(publishedUrl({ metadata: null }), null);
  assert.equal(publishedUrl({ metadata: { published_url: "javascript:alert(1)" } }), null);
});

test("a published essay and the images it names stop counting toward the piece's state; its LinkedIn row stays", () => {
  const own = [
    { id: "kb-substack", kind: "copy", source: "substack.md", body: "![](header.png)", metadata: { published_url: "https://sample_author.substack.com/p/x" } },
    { id: "kb-header", kind: "image", source: "stories/kb/header.png" },
    { id: "kb-linkedin", kind: "copy", source: "linkedin.md" },
  ];
  const rows = [
    { asset_id: "kb-substack", channel: "newsletter" },
    { asset_id: "kb-header", channel: "newsletter" },
    { asset_id: "kb-linkedin", channel: "linkedin" },
  ];
  assert.deepEqual(withoutAlternatives(own, rows).map((r) => r.asset_id), ["kb-linkedin"]);
  assert.equal(withoutAlternatives([{ ...own[0], metadata: {} }, own[1], own[2]], rows).length, 3, "unpublished: all rows still decide");
});

test("an image a published essay shares with an unpublished one still decides the piece", () => {
  const own = [
    { id: "a", kind: "copy", source: "a.md", body: "![](header.png)", metadata: { published_url: "https://sample_author.substack.com/p/a" } },
    { id: "b", kind: "copy", source: "b.md", body: "![](header.png)" },
    { id: "img", kind: "image", source: "stories/x/header.png" },
  ];
  const rows = own.map((a) => ({ asset_id: a.id, channel: "newsletter" }));
  assert.deepEqual(withoutAlternatives(own, rows).map((r) => r.asset_id), ["b", "img"]);
});

test("a sent-back row on a published essay no longer counts", () => {
  const own = [
    { id: "a", kind: "copy", source: "a.md", body: "", metadata: { published_url: "https://sample_author.substack.com/p/a" } },
    { id: "li", kind: "copy", source: "li.md" },
  ];
  const rows = [{ asset_id: "a", channel: "newsletter", status: "rejected" }, { asset_id: "li", channel: "linkedin", status: "approved" }];
  assert.deepEqual(withoutPublished(own, rows).map((r) => r.asset_id), ["li"]);
  assert.equal(withoutPublished([{ ...own[0], metadata: {} }, own[1]], rows).length, 2);
});
