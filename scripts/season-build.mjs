import { loadContent } from "../lib/content-overlay.mjs";
// Builds everything the Season review screen needs from config/season1.json:
//   - the per-channel copy files (posts/<slug>/linkedin|instagram|youtube.md), created only when missing,
//   - one Story manifest per piece (stories/s1-NN-<slug>.yaml),
//   - the calendar items, bound to their Story (new ones start as `drafted`; existing ones keep their status).
//   - list carousels: the post text follows the slides (John, 2026-10-05). A piece with `"list_copy": "derive"`
//     gets its numbered list rewritten from the deck's slides.json; every list piece is then checked (every
//     slide item named, numbered lines match the slides) and stamped with the deck's digest (`deck_sha256`).
//     A hand-written list is stamped only with `--ack <slug>`, after a person or agent has updated the text.
// Pieces whose media is not finished yet are skipped and listed. Run from vibrana-gtm with direnv env:
//   node --import tsx scripts/season-build.mjs [--draft-dir <hub>/gtm/content/drafts] [--ack <slug>[,<slug>]] [--calendar] [--dry-run]
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { parse, parseDocument, stringify } from "yaml";
import { deckCopyProblems, deckDigest, isListDeck, syncNumberedList, withStamp } from "../lib/deck.ts";

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const dry = args.includes("--dry-run");
// Approve first, schedule second (John, 2026-10-11): by default a piece gets its Story for /content review but no
// calendar item until its Story is fully approved; `--calendar` (after approval) adds or binds the calendar items.
const withCalendar = args.includes("--calendar");
const acked = new Set((flag("--ack") ?? "").split(",").filter((x) => x && !x.startsWith("--")));
const cfg = loadContent("config/season1.json");
const workspace = resolve(process.env.GTM_WORKSPACE ?? join(homedir(), "Projects/john-workspace"));
const calendarPath = process.env.GTM_CALENDAR ?? join(workspace, "2-work/content-engine/calendar.yaml");
const calDir = dirname(calendarPath);
const draftDir = resolve(flag("--draft-dir") ?? join(homedir(), "Projects/vibrana/gtm/content/drafts"));
const mediaRoot = join(workspace, cfg.media_root);
const postsRoot = join(workspace, cfg.posts_root);
const storiesRoot = join(workspace, "2-work/vibrana-gtm/content-season-2026-10/stories");
const rel = (abs) => relative(calDir, abs);
const pad = (n) => String(n).padStart(2, "0");

const split = (text) => {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  return m ? { fm: parse(m[1]) ?? {}, body: text.slice(m[0].length).trim() } : { fm: {}, body: text.trim() };
};
const igCaption = (text) => {
  const { body } = split(text);
  const lines = body.split("\n");
  const at = lines.findIndex((l) => /^## Caption/.test(l));
  if (at < 0) return body;
  const rest = lines.slice(at + 1);
  const end = rest.findIndex((l) => /^## /.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
};
const firstLine = (body) => body.split("\n").find((l) => l.trim())?.trim() ?? "";

const channelsFor = (p) => p.kind === "carousel"
  ? { linkedin: "slides", instagram: "slides" }
  : p.kind === "short" // 9:16 only, Instagram Reel + YouTube Short, no LinkedIn cut (e.g. the Example Series podcast clips)
    ? { youtube: "video-9x16", instagram: "video-9x16" }
    : p.kind === "video+carousel"
    ? { linkedin: "video-4x5", youtube: "video-9x16", instagram: "slides" }
    : { linkedin: "video-4x5", youtube: "video-9x16", instagram: "video-9x16" };

function ensureCopy(p) {
  const dir = join(postsRoot, p.slug);
  const made = [];
  if (p.existing) return { dir, made };
  const read = (f) => readFileSync(join(draftDir, p.draft, f), "utf8");
  if (!dry) mkdirSync(dir, { recursive: true });
  const write = (name, content) => { const path = join(dir, name); if (!existsSync(path)) { if (!dry) writeFileSync(path, content); made.push(name); } };
  const li = split(read("linkedin.md"));
  const c = p.credit;
  const credit = c ? `Footage: "${c.title}" by ${c.author}` : "";
  const long = c ? `${credit}, CC BY, via YouTube (${c.url}).` : "";
  const firstComment = [li.fm.first_comment && String(li.fm.first_comment).trim(), long].filter(Boolean).join(" ");
  const fm = firstComment ? stringify({ first_comment: firstComment }, { defaultStringType: "BLOCK_LITERAL", defaultKeyType: "PLAIN", lineWidth: 0 }) : "";
  write("linkedin.md", fm ? `---\n${fm}---\n\n${li.body}\n` : `${li.body}\n`);
  write("instagram.md", `${igCaption(read("instagram.md"))}\n${c && p.kind !== "video+carousel" ? `\n${credit} (CC BY).\n` : ""}`);
  if (p.kind !== "carousel") {
    let title = p.ytTitle;
    if (!title) title = (read("video-lines.md").match(/^1\.\s+(.+)$/m) ?? [])[1] ?? p.name;
    const lead = li.body.split("\n\n")[0].trim();
    write("youtube.md", `---\nyoutube_title: ${JSON.stringify(title)}\nyoutube_category_id: 28\nyoutube_visibility: public\n---\n\n${lead}\n\n${long ? `${long}\n\n` : ""}#Shorts\n`);
  }
  return { dir, made };
}

function mediaFor(p) {
  const out = { "video-4x5": null, "video-9x16": null, slides: [] };
  if (p.video) {
    for (const k of ["4x5", "9x16"]) { const f = join(mediaRoot, `${p.video}-${k}-post.mp4`); if (existsSync(f)) out[`video-${k}`] = f; }
  }
  if (p.slides) {
    const d = join(mediaRoot, p.slides);
    if (existsSync(d)) out.slides = readdirSync(d).filter((f) => /^slide-\d+\.png$/.test(f)).sort().map((f) => join(d, f));
  }
  return out;
}

/** Keeps a list carousel's post text in step with its slides; returns the problems a person still has to fix. */
function syncList(p, dir) {
  const deckPath = join(mediaRoot, p.slides, "slides.json");
  if (!existsSync(deckPath)) {
    // Decks exported before the exporter wrote slides.json: seed it from the draft, but only when the draft is
    // what carousel.html actually rendered (image paths aside), so the text is never stamped against other slides.
    const draft = join(draftDir, p.draft, "slides.json");
    const page = join(mediaRoot, p.slides, "carousel.html");
    if (existsSync(draft) && !isListDeck(JSON.parse(readFileSync(draft, "utf8")))) return [];
    if (!existsSync(draft) || !existsSync(page)) return [`${p.slug}: no slides.json beside the slides; re-export the deck`];
    const html = readFileSync(page, "utf8");
    const at = html.indexOf("window.CAROUSEL = ");
    const strip = (d) => JSON.stringify(d.slides.map(({ src, photo, logo, ...rest }) => rest));
    let rendered = null;
    try { rendered = at < 0 ? null : JSON.parse(html.slice(at + 18, html.indexOf(";</script>", at))); } catch { rendered = null; }
    if (!rendered || strip(rendered) !== strip(JSON.parse(readFileSync(draft, "utf8")))) return [`${p.slug}: the draft slides.json differs from what was rendered; re-export the deck`];
    if (!dry) copyFileSync(draft, deckPath);
  }
  const raw = readFileSync(existsSync(deckPath) ? deckPath : join(draftDir, p.draft, "slides.json"), "utf8");
  const deck = JSON.parse(raw);
  if (!isListDeck(deck)) return [];
  const digest = deckDigest(raw);
  const problems = [];
  for (const ch of ["linkedin", "instagram"]) {
    const path = join(dir, `${ch}.md`);
    if (!existsSync(path)) continue;
    let text = readFileSync(path, "utf8");
    if (p.list_copy === "derive") text = syncNumberedList(text, deck) ?? text;
    const left = deckCopyProblems(withStamp(text, digest), deck, digest);
    if (!left.length && (p.list_copy === "derive" || acked.has(p.slug))) text = withStamp(text, digest);
    if (!dry && text !== readFileSync(path, "utf8")) writeFileSync(path, text);
    problems.push(...deckCopyProblems(text, deck, digest).map((x) => `${p.slug}/${ch}.md: ${x}`));
  }
  return problems;
}

const doc = parseDocument(readFileSync(calendarPath, "utf8"));
const items = doc.get("items");
const findItem = (id) => items.items.find((n) => n.get("id") === id);
const report = [];
const listProblems = [];

for (const p of cfg.pieces) {
  const sid = `s1-${pad(p.n)}-${p.slug}`;
  const wants = channelsFor(p);
  const media = mediaFor(p);
  const missing = [...new Set(Object.values(wants))].filter((w) => (w === "slides" ? !media.slides.length : !media[w]));
  if (missing.length) { report.push(`${sid}: SKIPPED, media not ready (${missing.join(", ")})`); continue; }
  const { dir, made } = ensureCopy(p);
  if (p.slides) listProblems.push(...syncList(p, dir));
  const copyPath = (ch) => join(dir, `${ch}.md`);
  const assets = [];
  const add = (a) => assets.push(a);
  const slides = media.slides.map((f, i) => ({ id: `${sid}-slide-${pad(i + 1)}`, f }));
  for (const ch of Object.keys(wants)) {
    if (!existsSync(copyPath(ch)) && !dry) throw new Error(`${sid}: missing ${copyPath(ch)}`);
  }
  const chan = { linkedin: [], instagram: [], youtube: [] };
  if (media["video-4x5"]) { const id = `${sid}-video-4x5`; add({ id, title: "Video 4:5 (LinkedIn)", kind: "video", source: rel(media["video-4x5"]), channels: ["linkedin"] }); chan.linkedin.push(id); }
  if (media["video-9x16"]) {
    const ch = Object.keys(wants).filter((c) => wants[c] === "video-9x16");
    const id = `${sid}-video-9x16`; add({ id, title: `Video 9:16 (${ch.join(" and ")})`, kind: "video", source: rel(media["video-9x16"]), channels: ch });
    for (const c of ch) chan[c].push(id);
  }
  if (media.slides.length && Object.values(wants).includes("slides")) {
    const ch = Object.keys(wants).filter((c) => wants[c] === "slides");
    slides.forEach((s, i) => { add({ id: s.id, title: `Slide ${i + 1} of ${slides.length}`, kind: "image", source: rel(s.f), channels: ch }); for (const c of ch) chan[c].push(s.id); });
  }
  const copyIds = {};
  for (const ch of Object.keys(wants)) {
    const id = `${sid}-${ch}`; copyIds[ch] = id;
    add({ id, title: { linkedin: "LinkedIn post and first comment", instagram: "Instagram caption", youtube: "YouTube title and description" }[ch], kind: "copy", source: rel(copyPath(ch)), channels: [ch] });
  }
  const manifest = { id: sid, title: `${p.slot} | ${p.name}`, link: cfg.story_link, season: cfg.season ?? "season-1", assets };
  if (!dry) { mkdirSync(storiesRoot, { recursive: true }); writeFileSync(join(storiesRoot, `${sid}.yaml`), stringify(manifest, { lineWidth: 0 })); }

  const prefix = { "example-topic-2": "post-wave", "example-topic-3": "post-brain", "example-topic-6": "post-grief" }[p.slug] ?? sid;
  const times = p.kind === "carousel" ? { linkedin: "08:30", instagram: "18:00" } : { linkedin: "14:00", youtube: "17:00", instagram: "18:00" };
  for (const ch of withCalendar ? Object.keys(wants) : []) {
    const id = `${prefix}-${ch}`;
    const mediaIds = chan[ch];
    const mediaSources = assets.filter((a) => mediaIds.includes(a.id)).map((a) => a.source);
    const storyAssets = [copyIds[ch], ...mediaIds];
    const format = ch === "linkedin" && p.kind === "carousel" ? "document" : wants[ch] === "slides" ? "carousel" : "video";
    const existing = findItem(id);
    if (existing) {
      existing.set("story_id", sid); existing.set("story_assets", storyAssets);
      report.push(`${id}: bound to ${sid}`);
    } else {
      items.add(doc.createNode({ id, week: p.week, date: p.date, time: times[ch], pillar: p.pillar, title: p.name, format, channels: [ch], copy: rel(copyPath(ch)), media: mediaSources, story_id: sid, story_assets: storyAssets, status: "drafted" }));
      report.push(`${id}: added (drafted)`);
    }
  }
  report.push(`${sid}: ${assets.length} assets${made.length ? `, wrote ${made.join(", ")}` : ""}`);
}
if (!dry && withCalendar) writeFileSync(calendarPath, doc.toString());
if (!withCalendar) report.push("calendar untouched (review first; rerun with --calendar once a piece is approved)");
console.log(report.join("\n"));
if (listProblems.length) {
  console.log(`\npost text does not follow its slides (${listProblems.length}):\n${listProblems.map((x) => `  - ${x}`).join("\n")}`);
  process.exitCode = 1;
}
