import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { renderOwnerCover, checkOwnerManifest, type OwnerManifest } from "../lib/packaging/owner";
import { checkPackage, packagingGate } from "../lib/packaging/model";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
function img(dir: string, name: string, size: string, color = "blue"): string {
  const out = join(dir, name);
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=${color}:size=${size}`, "-frames:v", "1", "-pix_fmt", "yuvj420p", out]);
  assert.equal(r.status, 0, String(r.stderr));
  return out;
}
const opts = { by: "John Ellison", origin: "Riverside thumbnail" };

test("an owner cover records who supplied it and passes the staging gate", { skip: !hasFfmpeg && "needs ffmpeg" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "owner-cover-"));
  try {
    const src = img(dir, "cover.jpg", "540x960");
    const r = renderOwnerCover("test-story", src, join(dir, "renders"), opts);
    assert.equal(r.cached, false);
    const m = JSON.parse(readFileSync(r.manifest, "utf8")) as OwnerManifest;
    assert.equal(m.kind, "owner");
    assert.equal(m.suppliedBy, "John Ellison");
    assert.equal(m.assets[0].sha256, sha(src));
    assert.equal(m.assets[0].shape, "portrait");
    assert.equal(renderOwnerCover("test-story", src, join(dir, "renders"), opts).cached, true);
    const expected = { story: "test-story", assetPath: r.cover, sha256: sha(r.cover) };
    assert.deepEqual(checkPackage(r.manifest, expected), []);
    assert.doesNotThrow(() => packagingGate("test-story", [{ id: "c", kind: "image", title: "cover", abs: r.cover, sha256: sha(r.cover), channels: ["instagram"], role: "cover", packaging: r.manifest }], []));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an owner cover is refused when the file changes, belongs to another Story, or misses the supplier", { skip: !hasFfmpeg && "needs ffmpeg" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "owner-cover-"));
  try {
    const r = renderOwnerCover("test-story", img(dir, "cover.jpg", "540x960"), join(dir, "renders"), opts);
    const base = { story: "test-story", assetPath: r.cover, sha256: sha(r.cover) };
    assert.match(checkPackage(r.manifest, { ...base, story: "other-story" }).join(), /another Story/);
    assert.match(checkPackage(r.manifest, { ...base, sha256: "0".repeat(64) }).join(), /not bound/);
    const m = JSON.parse(readFileSync(r.manifest, "utf8")) as OwnerManifest;
    assert.match(checkOwnerManifest(r.manifest, { ...m, suppliedBy: " " }).join(), /no supplier/);
    assert.match(checkOwnerManifest(r.manifest, { ...m, origin: "" }).join(), /no origin/);
    copyFileSync(img(dir, "other.jpg", "540x960", "red"), r.cover);
    assert.match(checkPackage(r.manifest, base).join(), /changed export/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an owner cover must match the staged video's shape and be a registered shape", { skip: !hasFfmpeg && "needs ffmpeg" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "owner-cover-"));
  try {
    assert.throws(() => renderOwnerCover("test-story", img(dir, "odd.jpg", "800x600"), join(dir, "renders"), opts), /registered shape/);
    assert.throws(() => renderOwnerCover("test-story", img(dir, "ok.jpg", "540x960"), join(dir, "renders"), { by: "", origin: "x" }), /needs --by/);
    const video = join(dir, "wide.mp4");
    assert.equal(spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:size=960x540:rate=30:duration=1", "-pix_fmt", "yuv420p", "-c:v", "libx264", video]).status, 0);
    const r = renderOwnerCover("test-story", join(dir, "ok.jpg"), join(dir, "renders"), opts);
    const errors = checkPackage(r.manifest, { story: "test-story", assetPath: r.cover, sha256: sha(r.cover), videos: [{ sha256: sha(video), abs: video }] });
    assert.match(errors.join(), /cover is portrait but the staged video is landscape/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the shape check fails closed: an unreadable or unregistered staged video refuses the cover", { skip: !hasFfmpeg && "needs ffmpeg" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "owner-cover-"));
  try {
    const r = renderOwnerCover("test-story", img(dir, "ok.jpg", "540x960"), join(dir, "renders"), opts);
    const base = { story: "test-story", assetPath: r.cover, sha256: sha(r.cover) };
    assert.match(checkPackage(r.manifest, { ...base, videos: [{ sha256: "0".repeat(64), abs: join(dir, "missing.mp4") }] }).join(), /cannot read the staged video's shape/);
    const odd = join(dir, "odd.mp4");
    assert.equal(spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:size=800x600:rate=30:duration=1", "-pix_fmt", "yuv420p", "-c:v", "libx264", odd]).status, 0);
    assert.match(checkPackage(r.manifest, { ...base, videos: [{ sha256: sha(odd), abs: odd }] }).join(), /not a registered cover shape/);
    const portrait = join(dir, "p.mp4"), wide = join(dir, "w.mp4");
    for (const [f, size] of [[portrait, "540x960"], [wide, "960x540"]] as const) assert.equal(spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=red:size=${size}:rate=30:duration=1`, "-pix_fmt", "yuv420p", "-c:v", "libx264", f]).status, 0);
    // A Story with a 16:9 and a 9:16 video accepts a cover that matches one of them.
    assert.deepEqual(checkPackage(r.manifest, { ...base, videos: [{ sha256: sha(wide), abs: wide }, { sha256: sha(portrait), abs: portrait }] }), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("owner covers must be real JPEG or PNG, named by their real format, and not tiny", { skip: !hasFfmpeg && "needs ffmpeg" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "owner-cover-"));
  try {
    const webp = join(dir, "c.webp");
    writeFileSync(webp, Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x24, 0, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.alloc(64)]));
    assert.throws(() => renderOwnerCover("test-story", webp, join(dir, "renders"), opts), /JPEG or PNG|publishable|webp/i);
    assert.throws(() => renderOwnerCover("test-story", img(dir, "tiny.jpg", "54x96"), join(dir, "renders"), opts), /at least 540px/);
    // PNG bytes named .jpg are stored by their real format.
    const realPng = join(dir, "real.png"), png = join(dir, "really-png.jpg");
    assert.equal(spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:size=540x960", "-frames:v", "1", realPng]).status, 0);
    copyFileSync(realPng, png);
    const r = renderOwnerCover("test-story", png, join(dir, "renders"), opts);
    assert.match(r.cover, /portrait\.png$/);
    assert.deepEqual(checkPackage(r.manifest, { story: "test-story", assetPath: r.cover, sha256: sha(r.cover) }), []);
    // A manifest naming PNG bytes as .jpg is refused at the gate.
    const m = JSON.parse(readFileSync(r.manifest, "utf8")) as OwnerManifest;
    copyFileSync(r.cover, join(dir, "renders", "x.jpg"));
    writeFileSync(join(dir, "renders", "manifest.json"), JSON.stringify({ ...m, assets: [{ ...m.assets[0], path: "x.jpg" }] }));
    assert.match(checkPackage(join(dir, "renders", "manifest.json")).join(), /png but named \.jpg/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("re-running with a different supplier or origin records the new values", { skip: !hasFfmpeg && "needs ffmpeg" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "owner-cover-"));
  try {
    const src = img(dir, "cover.jpg", "540x960");
    renderOwnerCover("test-story", src, join(dir, "renders"), opts);
    const again = renderOwnerCover("test-story", src, join(dir, "renders"), { by: "Abe", origin: "Canva" });
    assert.equal(again.cached, false);
    const m = JSON.parse(readFileSync(again.manifest, "utf8")) as OwnerManifest;
    assert.deepEqual([m.suppliedBy, m.origin], ["Abe", "Canva"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
