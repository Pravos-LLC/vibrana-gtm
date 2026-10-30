// LinkedIn requires a title on document (PDF carousel) posts. Without one Zernio fell back to the
// file name (`<id>.pdf`), so every carousel went out titled after its calendar id.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Calendar, Item } from "../lib/calendar.ts";
import { documentTitle, isDocumentPost, sendCalendarItem } from "../lib/publish-item.ts";

const item = (over: Partial<Item> = {}): Item => ({
  id: "carousel-x-linkedin", week: 41, date: "2030-10-07", time: "09:00", pillar: "build", title: "Calendar title",
  format: "carousel", channels: ["linkedin"], copy: "carousel-x/linkedin.md", media: ["carousel-x/out/carousel.pdf"], status: "approved", ...over,
});

function workspace(copy: string, slides?: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "gtm-doctitle-"));
  mkdirSync(join(dir, "carousel-x/out"), { recursive: true });
  writeFileSync(join(dir, "carousel-x/linkedin.md"), copy);
  writeFileSync(join(dir, "carousel-x/out/carousel.pdf"), "%PDF-1.4\n");
  if (slides) writeFileSync(join(dir, "carousel-x/slides.json"), JSON.stringify(slides));
  const cal: Calendar = { path: join(dir, "calendar.yaml"), timezone: "Europe/Berlin", accounts: { linkedin: "li", instagram: "ig" }, manual: [], items: [] };
  return { dir, cal };
}

test("documentTitle: copy frontmatter title, then slides.json cover title, then the calendar title", () => {
  const slides = { slides: [{ type: "cover", title: "6 weeks inside an AI-native change" }, { type: "point", title: "Week 1" }] };
  const a = workspace("---\ntitle: From the frontmatter\n---\nBody", slides);
  const b = workspace("Body", slides);
  const c = workspace("Body", { title: "Top-level title", slides: [{ type: "cover", title: "Cover" }] });
  const d = workspace("Body");
  try {
    assert.equal(documentTitle(a.cal, item(), { title: "From the frontmatter" }), "From the frontmatter");
    assert.equal(documentTitle(b.cal, item(), {}), "6 weeks inside an AI-native change");
    assert.equal(documentTitle(c.cal, item(), {}), "Top-level title");
    assert.equal(documentTitle(d.cal, item(), {}), "Calendar title");
  } finally { for (const w of [a, b, c, d]) rmSync(w.dir, { recursive: true, force: true }); }
});

test("isDocumentPost: page-image documents and ready-made PDFs, nothing else", () => {
  assert.equal(isDocumentPost(item()), true);
  assert.equal(isDocumentPost(item({ format: "document", media: ["s/01.png", "s/02.png"] })), true);
  assert.equal(isDocumentPost(item({ format: "carousel", media: ["s/01.png"] })), false);
  assert.equal(isDocumentPost(item({ format: "video", media: ["v.mp4"] })), false);
});

test("a LinkedIn document post sends platformSpecificData.documentTitle; Instagram does not", async () => {
  const { dir, cal } = workspace("---\ntitle: The carousel title\n---\nBody without links.");
  try {
    const li = item();
    const ig = item({ id: "carousel-x-instagram", channels: ["instagram"] });
    cal.items = [li, ig];
    const r = await sendCalendarItem(cal, li.id, { dry: true });
    assert.ok("dryRun" in r);
    const body = r.body as { platforms: { platform: string; platformSpecificData?: Record<string, unknown> }[]; mediaItems: { type: string }[] };
    assert.deepEqual(body.mediaItems.map((m) => m.type), ["document"]);
    assert.equal(body.platforms[0].platformSpecificData?.documentTitle, "The carousel title");
    const r2 = await sendCalendarItem(cal, ig.id, { dry: true });
    assert.ok("dryRun" in r2);
    assert.equal((r2.body as { platforms: { platformSpecificData?: Record<string, unknown> }[] }).platforms[0].platformSpecificData?.documentTitle, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
