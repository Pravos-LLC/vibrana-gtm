// A frame cover: the cover IS one exact frame of the Story's own cut (for example the opening screen), with nothing
// composed on top. No template, brand profile or font is involved, so it is not a toolkit composition; it is bound
// by hash to the video it was taken from, and the staging gate requires that video to be the one being staged.
// CLI only (ffmpeg on PATH).
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { SIZES, TOOLKIT_VERSION, type Shape } from "./catalog";
import { imageProblems, sniffImage, IMAGE_TYPES, PUBLISH_IMAGE_BYTES } from "../image-loadable";
import { createHash } from "node:crypto";

export type FrameManifest = {
  schema: 1; kind: "frame"; story: string; toolkit: string; renderedAt: string;
  /** The source cut, relative to this manifest. */
  video: { path: string; sha256: string };
  /** Seconds from the start of the video, at millisecond precision. */
  seconds: number;
  assets: Array<{ path: string; sha256: string; width: number; height: number; role: "cover"; shape: Shape }>;
};

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
/** Streamed, so an episode-length source never has to fit in memory. */
function fileSha(path: string): string {
  const fd = openSync(path, "r"), h = createHash("sha256"), chunk = Buffer.alloc(1024 * 1024);
  try { let n: number; while ((n = readSync(fd, chunk, 0, chunk.length, null))) h.update(chunk.subarray(0, n)); }
  finally { closeSync(fd); }
  return h.digest("hex");
}

/** The registered shape whose aspect matches the video's (within 1%), or null. */
export function shapeFor(width: number, height: number): Shape | null {
  for (const [shape, [w, h]] of Object.entries(SIZES) as Array<[Shape, readonly [number, number]]>) {
    if (Math.abs(width / height - w / h) <= 0.01 * (w / h)) return shape;
  }
  return null;
}

function probe(video: string): { width: number; height: number; duration: number } {
  const r = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", video], { encoding: "utf8" });
  if (r.error) throw new Error(`frame cover needs ffprobe on PATH: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`ffprobe could not read ${video}: ${r.stderr.trim()}`);
  const j = JSON.parse(r.stdout) as { streams?: Array<{ width: number; height: number }>; format?: { duration?: string } };
  const s = j.streams?.[0];
  if (!s?.width || !s?.height) throw new Error(`no video stream in ${video}`);
  return { width: s.width, height: s.height, duration: Number(j.format?.duration ?? NaN) };
}

/**
 * Extract the frame at `seconds` from `video` as the Story's cover, full bleed at the registered size for the video's
 * shape. Writes `<outDir>/frame-<hash>/<shape>.jpg` and `manifest.json`; the directory name is content-addressed by
 * the video bytes and the timestamp, so the same request returns the same files.
 */
export function renderFrameCover(story: string, video: string, seconds: number, outDir: string): { manifest: string; cover: string; cached: boolean } {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(story)) throw new Error("invalid Story id");
  const abs = resolve(video);
  if (!existsSync(abs)) throw new Error(`video not found: ${video}`);
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error("--at must be a non-negative number of seconds");
  const at = Math.round(seconds * 1000) / 1000;
  const { width, height, duration } = probe(abs);
  if (Number.isFinite(duration) && at >= duration) throw new Error(`--at ${at} is past the end of the video (${duration.toFixed(3)} s)`);
  const shape = shapeFor(width, height);
  if (!shape) throw new Error(`video is ${width}x${height}; a frame cover needs a registered shape (${Object.keys(SIZES).join(", ")})`);
  const [w, h] = SIZES[shape];
  const videoSha = fileSha(abs);
  const dir = resolve(outDir, `frame-${sha(Buffer.from(`${story}|${videoSha}|${at}`)).slice(0, 20)}`);
  const manifestPath = join(dir, "manifest.json"), coverPath = join(dir, `${shape}.jpg`);
  if (existsSync(manifestPath) && checkFrameManifest(manifestPath, JSON.parse(readFileSync(manifestPath, "utf8"))).length === 0) {
    return { manifest: manifestPath, cover: coverPath, cached: true };
  }
  mkdirSync(dir, { recursive: true });
  // -ss after -i: frame-accurate decode to the exact timestamp, not the nearest keyframe.
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-i", abs, "-ss", at.toFixed(3), "-frames:v", "1",
    "-vf", `scale=${w}:${h}:flags=lanczos,setsar=1`, "-q:v", "2", "-pix_fmt", "yuvj420p", coverPath], { encoding: "utf8" });
  if (r.error) throw new Error(`frame cover needs ffmpeg on PATH: ${r.error.message}`);
  if (r.status !== 0 || !existsSync(coverPath)) throw new Error(`ffmpeg could not extract the frame: ${r.stderr.trim()}`);
  const bytes = readFileSync(coverPath);
  const check = imageProblems(bytes, bytes.length, bytes, IMAGE_TYPES[sniffImage(bytes)], PUBLISH_IMAGE_BYTES);
  if (check.problems.length) throw new Error(`extracted frame is not a publishable image: ${check.problems.join(", ")}`);
  const manifest: FrameManifest = {
    schema: 1, kind: "frame", story, toolkit: TOOLKIT_VERSION, renderedAt: new Date().toISOString(),
    video: { path: relative(dir, abs), sha256: videoSha }, seconds: at,
    assets: [{ path: `${shape}.jpg`, sha256: sha(bytes), width: check.width ?? w, height: check.height ?? h, role: "cover", shape }],
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return { manifest: manifestPath, cover: coverPath, cached: false };
}

/**
 * Problems with a frame manifest. With `expected`, the cover must be this manifest's exact export for this Story, and
 * the source video must be one of the videos being staged (`videos`, their sha256s): a cover taken from an older cut
 * fails until it is re-extracted from the current one.
 */
export function checkFrameManifest(path: string, m: FrameManifest, expected?: { story: string; assetPath: string; sha256: string; videos?: string[] }): string[] {
  const errors: string[] = [];
  if (m.schema !== 1 || m.kind !== "frame") return ["not a frame manifest"];
  const root = dirname(path);
  if (expected && m.story !== expected.story) errors.push("manifest belongs to another Story");
  if (!m.video?.path || !m.video?.sha256) return [...errors, "frame manifest has no source video"];
  const v = resolve(root, m.video.path);
  if (!existsSync(v)) errors.push(`source video missing: ${m.video.path}`);
  else if (fileSha(v) !== m.video.sha256) errors.push("source video changed since the frame was taken");
  if (expected?.videos && !expected.videos.includes(m.video.sha256)) errors.push("frame is not from the video being staged: re-extract it from the current cut");
  if (!Array.isArray(m.assets) || !m.assets.length) return [...errors, "frame manifest has no cover"];
  for (const a of m.assets) {
    const p = resolve(root, a.path);
    if (!existsSync(p) || fileSha(p) !== a.sha256) { errors.push(`changed or missing export: ${a.path}`); continue; }
    const bytes = readFileSync(p), check = imageProblems(bytes, bytes.length, bytes, IMAGE_TYPES[sniffImage(bytes)], PUBLISH_IMAGE_BYTES);
    if (check.problems.length) errors.push(`invalid image ${a.path}: ${check.problems.join(", ")}`);
    const size = SIZES[a.shape];
    if (!size || check.width !== a.width || check.height !== a.height || a.width !== size[0] || a.height !== size[1]) errors.push(`export dimensions do not match manifest: ${a.path}`);
  }
  if (expected && !m.assets.some(a => a.role === "cover" && resolve(root, a.path) === resolve(expected.assetPath) && a.sha256 === expected.sha256)) errors.push("cover is not bound to this packaging manifest");
  return errors;
}
