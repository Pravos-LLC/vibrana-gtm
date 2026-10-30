// Structural test (John, 2026-10-13): every stored video and image the cockpit shows is a WatchedVideo / WatchedImage
// (components/media/watched-media.tsx), which rides out a Storage 429 with fresh URLs and reports a file that really will
// not play or load. A raw <video> anywhere, or a raw <img> on the screens that show stored media, fails here.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? files(p) : /\.tsx$/.test(n) ? [p] : [];
});
/** Screens whose images are stored media (signed content-review URLs). Avatars and favicons elsewhere are third-party. */
const STORED_IMAGE_DIRS = ["components/review", "components/studio", "components/shared", "components/content", "components/calendar", "components/work", "app/content", "app/studio", "app/shared"];
const STORED_IMAGE_FILES = ["components/guide/media.tsx"];

test("no raw <video> anywhere, and no raw <img> where stored media is shown", () => {
  const all = ["app", "components"].flatMap((d) => files(join(ROOT, d))).map((p) => relative(ROOT, p));
  const bad: string[] = [];
  for (const f of all) {
    if (f === "components/media/watched-media.tsx") continue;
    // Code only: a comment may name the element.
    const text = readFileSync(join(ROOT, f), "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    if (/<video\b/.test(text)) bad.push(`${f}: raw <video>; use WatchedVideo or SignedVideo`);
    const storedImages = STORED_IMAGE_DIRS.some((d) => f.startsWith(`${d}/`)) || STORED_IMAGE_FILES.includes(f);
    if (storedImages && /<img\b/.test(text)) bad.push(`${f}: raw <img>; use WatchedImage`);
  }
  assert.deepEqual(bad, []);
});
