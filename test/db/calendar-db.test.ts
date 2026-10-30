// Calendar in the database: YAML import/export round trip, dashboard-edit protection, the approval
// trigger, DB-mode scheduling and the inspiration library, all against the LOCAL stack.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admin, seed } from "../support/seed.ts";
import { local } from "../support/local-supabase.ts";
import { png } from "../support/image";

const l = local();
Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: l.url, SUPABASE_SECRET_KEY: l.secretKey });
const { contentHash, exportCalendar, importCalendar, loadCalendarDb } = await import("../../lib/calendar-db.ts");
const { sendCalendarItem } = await import("../../lib/publish-item.ts");
const { addInspiration, listInspiration, importInspiration } = await import("../../lib/inspiration.ts");
before(seed);

const yaml = (time = "15:00", status = "approved") => `timezone: Europe/Berlin
items:
  - id: rt-post
    week: 41
    date: '2030-10-07'
    time: "${time}"
    pillar: perspective
    title: Round trip
    format: image
    channels: [linkedin]
    copy: posts/rt.md
    media: [img/card.png]
    status: ${status}
  - id: rt-letter
    week: 41
    date: '2030-10-08'
    pillar: proof
    title: Letter
    format: text
    channels: [newsletter]
    copy: posts/letter.md
    status: drafted
`;
function workspace(text = yaml()) {
  const dir = mkdtempSync(join(tmpdir(), "gtm-caldb-"));
  mkdirSync(join(dir, "posts")); mkdirSync(join(dir, "img"));
  writeFileSync(join(dir, "calendar.yaml"), text);
  writeFileSync(join(dir, "posts/rt.md"), "Round trip body.");
  writeFileSync(join(dir, "posts/letter.md"), "---\nchannel: regenera-substack\n---\n# Letter\n\nHello.");
  writeFileSync(join(dir, "img/card.png"), png({ note: "rt-post card" }));
  return dir;
}

test("import is an idempotent upsert: body, storage media, publication, approval hash", async () => {
  const db = admin();
  const dir = workspace();
  try {
    const first = await importCalendar(db, join(dir, "calendar.yaml"));
    assert.deepEqual([first.inserted.sort(), first.uploads.length], [["rt-letter", "rt-post"], 1]);
    const row = (await db.from("gtm_content_items").select("*").eq("id", "rt-post").single()).data!;
    assert.equal(row.body, "Round trip body.");
    assert.match(row.media[0], /^calendar\/rt-post\/[a-f0-9]{16}-card\.png$/);
    assert.equal(row.approved_hash, contentHash(row));
    assert.equal(row.time, "15:00");
    const stored = await db.storage.from("content-review").download(row.media[0]);
    assert.equal(stored.error, null);
    assert.equal((await db.from("gtm_content_items").select("publication").eq("id", "rt-letter").single()).data!.publication, "regenera");
    const again = await importCalendar(db, join(dir, "calendar.yaml"));
    assert.deepEqual([again.inserted, again.updated, again.uploads, again.unchanged.sort()], [[], [], [], ["rt-letter", "rt-post"]]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("export then import round-trips the database unchanged", async () => {
  const db = admin();
  const dir = mkdtempSync(join(tmpdir(), "gtm-export-"));
  try {
    const before = (await loadCalendarDb(db)).items;
    writeFileSync(join(dir, "calendar.yaml"), await exportCalendar(db));
    const r = await importCalendar(db, join(dir, "calendar.yaml"));
    assert.deepEqual([r.inserted, r.updated, r.conflicts, r.uploads], [[], [], [], []]);
    assert.deepEqual((await loadCalendarDb(db)).items, before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a dashboard body edit resets approval and survives a re-import unless --force", async () => {
  const db = admin();
  const dir = workspace();
  try {
    await importCalendar(db, join(dir, "calendar.yaml"));
    await db.from("gtm_content_items").update({ body: "Edited in the dashboard." }).eq("id", "rt-post");
    const edited = (await db.from("gtm_content_items").select("status, approved_hash").eq("id", "rt-post").single()).data!;
    assert.deepEqual(edited, { status: "drafted", approved_hash: null }, "trigger: changed text loses its approval");
    const kept = await importCalendar(db, join(dir, "calendar.yaml"));
    assert.deepEqual(kept.conflicts, ["rt-post"]);
    const row = (await db.from("gtm_content_items").select("body, status, approved_hash").eq("id", "rt-post").single()).data!;
    assert.deepEqual(row, { body: "Edited in the dashboard.", status: "drafted", approved_hash: null }, "YAML approval does not cover dashboard text");
    await importCalendar(db, join(dir, "calendar.yaml"), { force: true });
    assert.equal((await db.from("gtm_content_items").select("body").eq("id", "rt-post").single()).data!.body, "Round trip body.");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a killed (skipped) row stays killed through a re-import", async () => {
  const db = admin();
  const dir = workspace();
  try {
    await importCalendar(db, join(dir, "calendar.yaml"));
    await db.from("gtm_content_items").update({ status: "skipped" }).eq("id", "rt-letter");
    await importCalendar(db, join(dir, "calendar.yaml"), { force: true });
    assert.equal((await db.from("gtm_content_items").select("status").eq("id", "rt-letter").single()).data!.status, "skipped");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the database rejects the escaped-quote time outright", async () => {
  const { error } = await admin().from("gtm_content_items").update({ time: "\"15:00\"" }).eq("id", "rt-post");
  assert.match(error?.message ?? "", /gtm_content_items_time/);
});

test("DB-mode scheduling reads the row and storage, never local files, and refuses changed content", async () => {
  const db = admin();
  const dir = workspace();
  try {
    await importCalendar(db, join(dir, "calendar.yaml"), { force: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const cal = await loadCalendarDb(db);
  const dry = await sendCalendarItem(cal, "rt-post", { dry: true, db });
  assert.ok("dryRun" in dry);
  assert.equal((dry.body as { content: string }).content, "Round trip body.");
  assert.match((dry.body as { mediaItems: { url: string }[] }).mediaItems[0].url, /^storage:\/\/calendar\/rt-post\//);
  const tampered = { ...cal, items: cal.items.map((i) => (i.id === "rt-post" ? { ...i, body: "Not what was approved." } : i)) };
  await assert.rejects(sendCalendarItem(tampered, "rt-post", { dry: true, db }), /changed after approval/);
});

test("DB-mode scheduling enforces the channel link rules on the approved body", async () => {
  const db = admin();
  const body = "New case study at brand.example.com/case-studies/orion";
  const row = { id: "link-rule", week: 41, date: "2030-10-09", time: "09:00", pillar: "proof", title: "Link rule", format: "text", status: "approved", media: [] };
  for (const channels of [["instagram"], ["linkedin"]]) {
    await db.from("gtm_content_items").delete().eq("id", row.id);
    const { error } = await db.from("gtm_content_items").insert({ ...row, channels, body, approved_hash: contentHash({ body, media: [] }) });
    assert.equal(error, null);
    const cal = await loadCalendarDb(db);
    await assert.rejects(sendCalendarItem(cal, row.id, { dry: true, db }), new RegExp(`link-rule: ${channels[0]} (caption|body) contains a link \\(brand\\.example\\.com/case-studies/orion\\)`));
  }
  await db.from("gtm_content_items").delete().eq("id", row.id);
});

test("inspiration: add fetches the preview, upserts by URL, lists by filter; seed skips pending entries", async () => {
  const db = admin();
  const fetcher = (async (url: string) => {
    if (String(url).startsWith("https://www.youtube.com/oembed")) return new Response(JSON.stringify({ title: "Vox explainer", thumbnail_url: "https://i.ytimg.com/vi/x/hq.jpg" }));
    return new Response('<meta property="og:title" content="Page &amp; title"><meta property="og:image" content="https://img.test/og.png">');
  }) as typeof fetch;
  const video = await addInspiration(db, { url: "https://www.youtube.com/watch?v=YsZ-lx_3eoM", kind: "video", tags: ["motion-graphics"], pillar: "perspective" }, { fetcher });
  assert.deepEqual([video.title, video.thumbnail_path, video.platform], ["Vox explainer", "https://i.ytimg.com/vi/x/hq.jpg", "youtube"]);
  const again = await addInspiration(db, { url: "https://www.youtube.com/watch?v=YsZ-lx_3eoM", kind: "video", why_we_like: "Style", tags: ["motion-graphics"] }, { fetcher });
  assert.equal(again.id, video.id, "same URL updates the same row");
  const page = await addInspiration(db, { url: "https://blog.test/post", kind: "post" }, { fetcher });
  assert.equal(page.title, "Page & title");
  assert.deepEqual((await listInspiration(db, { tag: "motion-graphics" })).map((i) => i.url).sort(), ["https://www.youtube.com/watch?v=YsZ-lx_3eoM", "https://www.youtube.com/watch?v=fixture1"]);
  await assert.rejects(addInspiration(db, { url: "ftp://x", kind: "video" }), /http/);
  const dir = mkdtempSync(join(tmpdir(), "gtm-inspo-"));
  try {
    writeFileSync(join(dir, "seed.json"), JSON.stringify([
      { kind: "carousel", url: null, title: "Later", pending: "needs a URL" },
      { kind: "newsletter", url: "https://iamregenera.substack.com/p/x", title: "Seeded", thumbnail_path: "https://img.test/x.png", tags: ["regenera"] },
    ]));
    const r = await importInspiration(db, join(dir, "seed.json"), { fetcher });
    assert.deepEqual([r.saved, r.skipped], [["https://iamregenera.substack.com/p/x"], [{ title: "Later", reason: "needs a URL" }]]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("DB-mode documents compose one PDF from the stored page images; an ig_story needs no body", async () => {
  const db = admin();
  // 1x1 transparent PNG, a real image pdf-lib can embed.
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  const dir = mkdtempSync(join(tmpdir(), "gtm-doc-"));
  try {
    mkdirSync(join(dir, "posts")); mkdirSync(join(dir, "slides"));
    writeFileSync(join(dir, "posts/doc.md"), "Carousel body.");
    writeFileSync(join(dir, "slides/01.png"), png);
    writeFileSync(join(dir, "slides/02.png"), Buffer.concat([png, Buffer.from([0])])); // distinct bytes, distinct key
    writeFileSync(join(dir, "slides/story.png"), png);
    writeFileSync(join(dir, "slides/deck.pdf"), Buffer.from("%PDF-1.4\n%fixture\n"));
    writeFileSync(join(dir, "calendar.yaml"), `timezone: Europe/Berlin
items:
  - id: doc-post
    week: 41
    date: '2030-10-09'
    time: "09:00"
    pillar: build
    title: Carousel
    format: document
    channels: [linkedin]
    copy: posts/doc.md
    media: [slides/01.png, slides/02.png]
    status: approved
  - id: ig-story-post
    week: 41
    date: '2030-10-09'
    time: "10:00"
    pillar: proof
    title: Story
    format: ig_story
    channels: [instagram]
    media: [slides/story.png]
    status: approved
  - id: pdf-carousel
    week: 41
    date: '2030-10-09'
    time: "11:00"
    pillar: build
    title: Ready-made deck
    format: carousel
    channels: [linkedin]
    copy: posts/doc.md
    media: [slides/deck.pdf]
    status: approved
`);
    await importCalendar(db, join(dir, "calendar.yaml"), { force: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const cal = await loadCalendarDb(db);
  const doc = await sendCalendarItem(cal, "doc-post", { dry: true, db });
  assert.ok("dryRun" in doc);
  assert.deepEqual((doc.body as { mediaItems: unknown[] }).mediaItems, [{ type: "document", url: "pdf:composed-from-2-images" }]);
  assert.equal((doc.body as { platforms: { platformSpecificData?: Record<string, unknown> }[] }).platforms[0].platformSpecificData?.documentTitle, "Carousel", "LinkedIn document title falls back to the calendar title");
  const story = await sendCalendarItem(cal, "ig-story-post", { dry: true, db });
  assert.ok("dryRun" in story);
  const body = story.body as { content: string; platforms: { platformSpecificData?: { contentType?: string } }[] };
  assert.equal(body.content, "");
  assert.equal(body.platforms[0].platformSpecificData?.contentType, "story");
  // A ready-made PDF is stored in the private bucket (application/pdf) and sent as one document.
  const deck = await sendCalendarItem(cal, "pdf-carousel", { dry: true, db });
  assert.ok("dryRun" in deck);
  assert.deepEqual((deck.body as { mediaItems: { type: string }[] }).mediaItems.map((m) => m.type), ["document"]);
  const key = cal.items.find((i) => i.id === "pdf-carousel")!.media![0];
  assert.equal((await db.storage.from("content-review").download(key)).error, null);
});
