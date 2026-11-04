import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { renderFrameCover, shapeFor, checkFrameManifest, probeVideo, type FrameManifest } from "../lib/packaging/frame";
import { checkPackage, packagingGate } from "../lib/packaging/model";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

function cut(dir: string, name: string, color: string): string {
  const out = join(dir, name);
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=${color}:size=540x960:rate=30:duration=2`, "-pix_fmt", "yuv420p", "-c:v", "libx264", out]);
  assert.equal(r.status, 0, String(r.stderr));
  return out;
}

test("shapeFor matches only registered cover shapes", () => {
  assert.equal(shapeFor(1080, 1920), "portrait");
  assert.equal(shapeFor(540, 960), "portrait");
  assert.equal(shapeFor(1920, 1080), "landscape");
  assert.equal(shapeFor(1000, 1000), "square");
  assert.equal(shapeFor(800, 600), null);
});

test("a frame cover is one exact frame of the staged cut, full size, and passes the staging gate", { skip: !hasFfmpeg && "needs ffmpeg" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "frame-cover-"));
  try {
    const video = cut(dir, "cut.mp4", "red");
    const r = renderFrameCover("test-story", video, 0.5, join(dir, "renders"));
    assert.equal(r.cached, false);
    const m = JSON.parse(readFileSync(r.manifest, "utf8")) as FrameManifest;
    assert.equal(m.kind, "frame");
    assert.equal(m.seconds, 0.5);
    assert.equal(m.video.sha256, sha(video));
    assert.deepEqual([m.assets[0].width, m.assets[0].height, m.assets[0].shape], [1080, 1920, "portrait"]);
    assert.equal(renderFrameCover("test-story", video, 0.5, join(dir, "renders")).cached, true);
    assert.deepEqual(checkPackage(r.manifest, { story: "test-story", assetPath: r.cover, sha256: sha(r.cover), videos: [{ sha256: sha(video), abs: video }] }), []);
    const cover = { id: "s-cover", title: "Cover", kind: "image", abs: r.cover, sha256: sha(r.cover), channels: ["youtube"], stage: "final", packaging: r.manifest };
    const vid = { id: "s-video", title: "Video", kind: "video", abs: video, sha256: sha(video), channels: ["youtube"], stage: "final" };
    assert.doesNotThrow(() => packagingGate("test-story", [vid, cover], [], "short"));
    // Wrong Story, or a cover byte change, fails.
    assert.throws(() => packagingGate("other-story", [vid, cover], [], "short"), /another Story/);
    assert.throws(() => packagingGate("test-story", [vid, { ...cover, sha256: "0".repeat(64) }], [], "short"), /not bound/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a frame taken from an older cut fails the gate until it is re-extracted from the cut being staged", { skip: !hasFfmpeg && "needs ffmpeg" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "frame-cover-old-"));
  try {
    const old = cut(dir, "v1.mp4", "red"), current = cut(dir, "v2.mp4", "blue");
    const r = renderFrameCover("test-story", old, 0.5, join(dir, "renders"));
    const cover = { id: "s-cover", title: "Cover", kind: "image", abs: r.cover, sha256: sha(r.cover), channels: ["youtube"], stage: "final", packaging: r.manifest };
    const vid = { id: "s-video", title: "Video", kind: "video", abs: current, sha256: sha(current), channels: ["youtube"], stage: "final" };
    assert.throws(() => packagingGate("test-story", [vid, cover], [], "short"), /not from the video being staged/);
    // The source video changing on disk also invalidates it.
    writeFileSync(old, "changed");
    const m = JSON.parse(readFileSync(r.manifest, "utf8")) as FrameManifest;
    assert.ok(checkFrameManifest(r.manifest, m).some(e => /source video changed/.test(e)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("frame covers refuse a timestamp past the end and a non-cover shape", { skip: !hasFfmpeg && "needs ffmpeg" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "frame-cover-bad-"));
  try {
    const video = cut(dir, "cut.mp4", "green");
    assert.throws(() => renderFrameCover("test-story", video, 5, join(dir, "renders")), /past the last video frame/);
    assert.throws(() => renderFrameCover("test-story", video, -1, join(dir, "renders")), /non-negative/);
    const odd = join(dir, "odd.mp4");
    spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:size=800x600:rate=30:duration=1", "-pix_fmt", "yuv420p", odd]);
    assert.throws(() => renderFrameCover("test-story", odd, 0.1, join(dir, "renders")), /registered shape/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a hand-written frame manifest around some other image fails the gate on pixels", { skip: !hasFfmpeg && "needs ffmpeg" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "frame-cover-forged-"));
  try {
    const video = cut(dir, "cut.mp4", "red");
    const other = join(dir, "other.jpg");
    spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1080x1920", "-frames:v", "1", "-q:v", "2", other]);
    const fake = join(dir, "fake"); mkdirSync(fake);
    copyFileSync(other, join(fake, "portrait.jpg"));
    const m: FrameManifest = { schema: 1, kind: "frame", story: "test-story", toolkit: "x", renderedAt: "now",
      video: { path: "../cut.mp4", sha256: sha(video) }, seconds: 0.5,
      assets: [{ path: "portrait.jpg", sha256: sha(join(fake, "portrait.jpg")), width: 1080, height: 1920, role: "cover", shape: "portrait" }] };
    writeFileSync(join(fake, "manifest.json"), JSON.stringify(m));
    const cover = { id: "s-cover", title: "Cover", kind: "image", abs: join(fake, "portrait.jpg"), sha256: sha(join(fake, "portrait.jpg")), channels: ["youtube"], stage: "final", packaging: join(fake, "manifest.json") };
    const vid = { id: "s-video", title: "Video", kind: "video", abs: video, sha256: sha(video), channels: ["youtube"], stage: "final" };
    assert.throws(() => packagingGate("test-story", [vid, cover], [], "short"), /cover pixels are not the frame/);
    // A landscape "frame" of a portrait cut fails on shape, and the hint points at gtm packaging frame.
    writeFileSync(join(fake, "manifest.json"), JSON.stringify({ ...m, assets: [{ ...m.assets[0], shape: "landscape" }] }));
    assert.throws(() => packagingGate("test-story", [vid, cover], [], "short"), /gtm packaging frame/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the gate fails closed without staged videos, and on a cover changed on disk", { skip: !hasFfmpeg && "needs ffmpeg" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "frame-cover-closed-"));
  try {
    const video = cut(dir, "cut.mp4", "red");
    const r = renderFrameCover("test-story", video, 0.5, join(dir, "renders"));
    const s = sha(r.cover);
    assert.ok(checkPackage(r.manifest, { story: "test-story", assetPath: r.cover, sha256: s }).some(e => /not from the video being staged/.test(e)));
    writeFileSync(r.cover, readFileSync(r.cover).subarray(0, 2000));
    assert.ok(checkPackage(r.manifest, { story: "test-story", assetPath: r.cover, sha256: s, videos: [{ sha256: sha(video), abs: video }] }).some(e => /changed or missing export/.test(e)));
    // A corrupt cached manifest is re-extracted, not thrown on.
    writeFileSync(r.manifest, "{ truncated");
    assert.equal(renderFrameCover("test-story", video, 0.5, join(dir, "renders")).cached, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a rotated portrait cut is read at its display size and gives an undistorted portrait cover", { skip: !hasFfmpeg && "needs ffmpeg" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "frame-cover-rot-"));
  try {
    const src = join(dir, "src.mp4");
    spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:size=960x540:rate=30:duration=2", "-pix_fmt", "yuv420p", "-c:v", "libx264", src]);
    const rotated = join(dir, "rotated.mp4");
    const r1 = spawnSync("ffmpeg", ["-v", "error", "-y", "-display_rotation", "90", "-i", src, "-c", "copy", rotated], { encoding: "utf8" });
    assert.equal(r1.status, 0, r1.stderr);
    const d = probeVideo(rotated);
    assert.deepEqual([d.width, d.height], [540, 960]);
    const r = renderFrameCover("test-story", rotated, 0.5, join(dir, "renders"));
    const m = JSON.parse(readFileSync(r.manifest, "utf8")) as FrameManifest;
    assert.equal(m.assets[0].shape, "portrait");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
