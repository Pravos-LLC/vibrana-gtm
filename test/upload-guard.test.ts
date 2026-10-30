// Structural test (John, 2026-10-13): no upload path may skip the media gate. Every module in the CLI, the cockpit, its
// libraries and scripts that writes bytes to Storage, Zernio or R2 must import lib/media-guard.ts and call a guard. A new
// upload path without one fails here, before it can put a 4:4:4 clip or a broken slide in front of John.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const DIRS = ["lib", "app", "cli", "scripts", "components"];
/** Any of these writes media somewhere a browser or a platform will later read it. */
const WRITES: Array<[string, RegExp]> = [
  ["storage .upload(", /\.upload\(/],
  ["uploadToSignedUrl(", /uploadToSignedUrl\(/],
  ["tusUpload(", /\btusUpload\(/],
  ["Zernio uploadMedia(", /\buploadMedia(?:Stream)?\(/],
  ["Zernio presign", /\/media\/presign/],
  ["R2 object PUT", /\/r2\/buckets\//],
  ["Storage REST write", /\/storage\/v1\/(?:object\/(?!sign|public|authenticated)|upload\/resumable)/],
];
const GUARDS = /\b(guardMediaBytes|guardVideoBytes|guardVideoFile|guardVideoRanged|guardImageFile)\(/;
const IMPORTS_GUARD = /from\s+["'](?:\.{1,2}\/|@\/lib\/)(?:[\w./-]*\/)?media-guard(?:\.ts)?["']|import\(["'](?:\.{1,2}\/)[\w./-]*media-guard(?:\.ts)?["']\)/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === "node_modules" ? [] : files(p);
    return /\.(ts|tsx|mjs|js)$/.test(name) ? [p] : [];
  });
}

/** The modules that write media without the gate, with what they write. */
export function unguarded(paths: Array<{ path: string; text: string }>) {
  const out: string[] = [];
  for (const { path, text } of paths) {
    const writes = WRITES.filter(([, re]) => re.test(text)).map(([name]) => name);
    if (!writes.length) continue;
    if (!IMPORTS_GUARD.test(text) && !/^lib\/media-guard\.ts$/.test(path)) out.push(`${path}: ${writes.join(", ")} without importing lib/media-guard`);
    else if (!GUARDS.test(text)) out.push(`${path}: ${writes.join(", ")} without calling a guard`);
  }
  return out;
}

test("every module that uploads media imports and calls the media guard", () => {
  const all = DIRS.flatMap((d) => files(join(ROOT, d))).map((p) => ({ path: relative(ROOT, p), text: readFileSync(p, "utf8") }));
  const writers = all.filter(({ text }) => WRITES.some(([, re]) => re.test(text))).map((f) => f.path).sort();
  // The known upload paths (a removal is fine; a new one must be guarded, which the next assertion checks).
  for (const known of ["lib/story.ts", "lib/calendar-db.ts", "lib/zernio.ts", "lib/large-media.ts", "lib/publish-item.ts", "lib/inspiration.ts", "lib/public-media.ts", "lib/media-fix.ts", "scripts/guide-media.mjs"]) {
    assert.ok(writers.includes(known), `${known} is no longer seen as an upload path: update this test if it truly stopped uploading`);
  }
  assert.deepEqual(unguarded(all), []);
});

test("the scanner catches an unguarded upload path", () => {
  const bad = { path: "lib/new-thing.ts", text: `export async function put(db) { await db.storage.from("content-review").upload("k", bytes, { contentType: "video/mp4" }); }` };
  assert.match(unguarded([bad]).join(), /lib\/new-thing\.ts: storage \.upload\( without importing lib\/media-guard/);
  const imported = { path: "lib/x.ts", text: `import { guardMediaBytes } from "./media-guard";\nawait uploadMedia(b, "a.mp4", "video/mp4");` };
  assert.match(unguarded([imported]).join(), /without calling a guard/);
  const ok = { path: "lib/y.ts", text: `import { guardMediaBytes } from "./media-guard";\nguardMediaBytes(b, t, k);\nawait db.storage.from(B).upload(k, b);` };
  assert.deepEqual(unguarded([ok]), []);
});
