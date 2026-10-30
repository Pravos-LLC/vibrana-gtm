import { assertLiveProvidersAllowed } from "../lib/demo-safety.ts";
import { contentWritePath, writeContent } from "../lib/content-overlay.mjs";
// Uploads the Content Guide's real assets to the private content-review bucket under guide/ and
// writes content/guide/media.json (storage paths and dimensions only, never the binaries).
//
//   pnpm guide:media [--dry-run]     (node --import tsx: it imports lib/media-guard.ts)
//
// Sources are read from john-workspace (GTM_WORKSPACE, default ~/Projects/john-workspace/2-work)
// and the brand.example.com research folder. Images are re-encoded to WebP (max 1600px) so the page
// stays fast; videos upload as they are (the bucket limit is 50 MiB). Paths are content-hashed,
// so re-running uploads only what changed.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
// Every guide upload passes the same media gate as the CLI and the cockpit (run with tsx: pnpm guide:media).
const { guardMediaBytes } = await import("../lib/media-guard.ts");

if (!process.argv.includes("--dry-run")) assertLiveProvidersAllowed();

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = contentWritePath("guide/media.json");
const WS = process.env.GTM_WORKSPACE ?? join(homedir(), "Projects/john-workspace/2-work");
const SITE = process.env.VIBRANA_AI_DIR ?? join(homedir(), "Projects/vibrana/brand.example.com");
const BUCKET = "content-review";
const dry = process.argv.includes("--dry-run");

const GTM = join(WS, "vibrana-gtm");
const CLIPS = join(GTM, "coherence-clips-2026-09/approved");
const CAROUSELS = join(GTM, "carousels-2026-10");
const ESSAY = join(WS, "linkedin-engine/drafts/orion-perspectives/assets");
const ORCHID = join(SITE, "research/homepage-visual-exploration/11-orchid-language/experiment-04");

/** key -> { file, kind, poster? } */
const sources = {
  "orion-teaser-16x9": { file: join(GTM, "orion-teaser/output/teaser-16x9-FINAL.mp4"), kind: "video", poster: join(GTM, "orion-teaser/thumbnail/final/thumb-A-16x9-1920x1080.png") },
  "orion-teaser-4x5": { file: join(GTM, "orion-teaser/output/teaser-4x5-FINAL.mp4"), kind: "video", poster: join(GTM, "orion-teaser/thumbnail/final/thumb-A-4x5-1080x1350.png") },
};
for (const clip of ["c1a-company-brain", "c1b-context-bloat", "c2-ai-native", "c3-what-is-aios", "c4-sense-making", "c5-agentic-maturity"]) {
  sources[`clip-${clip}`] = { file: join(CLIPS, `${clip}.mp4`), kind: "video", poster: join(CLIPS, `${clip}-9x16.png`) };
  sources[`clip-${clip}-cover`] = { file: join(CLIPS, `${clip}-4x5.png`), kind: "image" };
}
if (existsSync(CAROUSELS)) {
  for (const name of readdirSync(CAROUSELS)) {
    const out = join(CAROUSELS, name, "out");
    if (!existsSync(out)) continue;
    for (const slide of readdirSync(out).filter((f) => /^slide-\d+\.png$/.test(f)).sort()) {
      sources[`carousel-${name}-${slide.replace(".png", "")}`] = { file: join(out, slide), kind: "image" };
    }
  }
}
for (const id of ["regenera-01", "regenera-02", "regenera-03", "regenera-04", "regenera-05"]) sources[`essay-${id}`] = { file: join(ESSAY, `${id}.jpg`), kind: "image" };
sources["essay-departmental-pods"] = { file: join(ESSAY, "departmental-pods.png"), kind: "image" };
sources["essay-regenera-case-study"] = { file: join(ESSAY, "regenera-case-study.png"), kind: "image" };
for (const id of ["ppl-dinner-v2", "ppl-cafe-laptop", "ppl-stickynotes-v2", "obj-suitcase-platform", "obj-surfboard-beach", "obj-guitar-canyon", "obj-bicycle-alley", "obj-books-window"]) {
  sources[`still-${id}`] = { file: join(ORCHID, `${id}.jpg`), kind: "image" };
}
// Season 1 picks John approved or published, for the Why wall: real photos, a cover, a quote card,
// a carousel slide and a video, so the wall isn't one post style.
const SEASON = join(GTM, "content-season-2026-10/media");
const SOCIAL = join(GTM, "substack-social/regenera-2026-10-03/out");
const REINTRO = join(WS, "linkedin-engine/drafts/reintroduction-2026/media");
sources["season-example-topic-2"] = { file: join(SEASON, "example-topic-2-noz/example-topic-2-noz-4x5-post.mp4"), kind: "video", posterAt: 1 };
sources["season-example-topic-1-slide-01"] = { file: join(SEASON, "agentic-example-topic-1/slide-01.png"), kind: "image" };
sources["regenera-social-ig-cover"] = { file: join(SOCIAL, "ig-feed/00-cover.jpg"), kind: "image" };
sources["regenera-social-quote-02"] = { file: join(SOCIAL, "cards/q02.jpg"), kind: "image" };
sources["photo-surf-morning"] = { file: join(REINTRO, "02-surf-morning.jpg"), kind: "image" };
sources["photo-salon-room"] = { file: join(REINTRO, "03-salon-room.jpg"), kind: "image" };
sources["photo-cafe-smile"] = { file: join(REINTRO, "01-cafe-smile.jpg"), kind: "image" };
sources["shot-vibrana-site"] = { file: join(GTM, "guide-shots/vibrana-site.png"), kind: "image" };
// Season 1 carousel decks, light and its Prism Dark twin, for the carousel viewer.
for (const [deck, dir] of [["agentic-example-topic-1", "agentic-example-topic-1"], ["agentic-example-topic-1-dark", "agentic-example-topic-1-dark"]]) {
  const out = join(SEASON, dir);
  if (!existsSync(out)) continue;
  for (const slide of readdirSync(out).filter((f) => /^slide-\d+\.png$/.test(f)).sort()) {
    sources[`carousel-${deck}-${slide.replace(".png", "")}`] = { file: join(out, slide), kind: "image" };
  }
}
// Labs: the AI Readiness Assessment running inside a sample-author.com post.
sources["lab-8-month-window-assessment"] = { file: join(GTM, "labs/8-month-window-assessment.png"), kind: "image" };

const tmp = mkdtempSync(join(tmpdir(), "guide-media-"));
const sha = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 16);
const probe = (file) => {
  const [w, h, d] = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "csv=p=0:s=,", file], { encoding: "utf8" })
    .trim().split(/[,\n]/).map(Number);
  return { w, h, duration: Number.isFinite(d) ? Math.round(d * 10) / 10 : undefined };
};
function webp(file, max = 1600) {
  const out = join(tmp, `${basename(file).replace(/\.\w+$/, "")}-${sha(file)}.webp`);
  execFileSync("magick", [file, "-resize", `${max}x${max}>`, "-strip", "-quality", "82", out]);
  return out;
}

/** A still from a video at `seconds`, for videos that have no separate poster file. */
function frame(file, seconds) {
  const out = join(tmp, `${basename(file).replace(/\.\w+$/, "")}-${seconds}s.png`);
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-ss", String(seconds), "-i", file, "-frames:v", "1", out]);
  return out;
}

const db = dry ? null : createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
if (!dry && (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY)) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are required");

async function upload(local, prefix, type) {
  const buf = readFileSync(local);
  const ext = type === "video/mp4" ? "mp4" : "webp";
  const path = `guide/${prefix}/${sha(buf)}.${ext}`;
  if (dry) return path;
  guardMediaBytes(buf, type, path);
  const { error } = await db.storage.from(BUCKET).upload(path, buf, { contentType: type, upsert: false, cacheControl: "31536000" });
  if (error && !/exists|Duplicate/i.test(error.message)) throw new Error(`${path}: ${error.message}`);
  return path;
}

const manifest = {};
const missing = [];
for (const [key, src] of Object.entries(sources)) {
  if (!existsSync(src.file)) { missing.push(src.file); continue; }
  if (src.kind === "video") {
    const { w, h, duration } = probe(src.file);
    const path = await upload(src.file, key, "video/mp4");
    const posterFile = src.posterAt !== undefined ? frame(src.file, src.posterAt) : src.poster;
    const poster = posterFile && existsSync(posterFile) ? await upload(webp(posterFile, 1080), `${key}-poster`, "image/webp") : null;
    manifest[key] = { kind: "video", path, poster, w, h, duration };
  } else {
    const local = webp(src.file);
    const { w, h } = probe(local);
    manifest[key] = { kind: "image", path: await upload(local, key, "image/webp"), w, h };
  }
  process.stdout.write(`${dry ? "would upload" : "ok"} ${key}\n`);
}
writeContent("guide/media.json", JSON.stringify(manifest, null, 2) + "\n");
console.log(`${Object.keys(manifest).length} assets -> ${OUT}${missing.length ? `\nmissing (skipped):\n  ${missing.join("\n  ")}` : ""}`);
