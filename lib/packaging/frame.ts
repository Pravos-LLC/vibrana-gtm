// A frame cover: the cover IS one exact frame of the Story's own cut (for example the opening screen), with nothing
// composed on top. No template, brand profile or font is involved, so it is not a toolkit composition. The manifest
// binds the cover to the video's sha256 and a timestamp, and the staging gate re-extracts that frame from the video
// being staged and compares pixels, so a hand-written manifest around some other image does not pass.
// CLI only (ffmpeg and ffprobe on PATH).
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { SIZES, TOOLKIT_VERSION, type Shape } from "./catalog";
import { imageProblems, sniffImage, IMAGE_TYPES, PUBLISH_IMAGE_BYTES } from "../image-loadable";
import { psnr } from "../video-heal";

export type FrameManifest = {
  schema: 1; kind: "frame"; story: string; toolkit: string; renderedAt: string;
  /** The source cut, relative to this manifest. */
  video: { path: string; sha256: string };
  /** Seconds from the start of the video, at millisecond precision. */
  seconds: number;
  assets: Array<{ path: string; sha256: string; width: number; height: number; role: "cover"; shape: Shape }>;
};
/** A video being staged with the cover: its bytes' sha256 and where those bytes are on disk. */
export type StagedVideo = { sha256: string; abs: string };

/** Luma PSNR a re-extracted frame must reach against the stored cover (JPEG q2 round trips sit well above 40 dB). */
export const FRAME_MIN_PSNR = 35;

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
/** Streamed, so an episode-length source never has to fit in memory. */
function fileSha(path: string): string {
  const fd = openSync(path, "r"), h = createHash("sha256"), chunk = Buffer.alloc(1024 * 1024);
  try { let n: number; while ((n = readSync(fd, chunk, 0, chunk.length, null))) h.update(chunk.subarray(0, n)); }
  finally { closeSync(fd); }
  return h.digest("hex");
}

/** The registered shape whose aspect matches (within 1%), or null. */
export function shapeFor(width: number, height: number): Shape | null {
  for (const [shape, [w, h]] of Object.entries(SIZES) as Array<[Shape, readonly [number, number]]>) {
    if (Math.abs(width / height - w / h) <= 0.01 * (w / h)) return shape;
  }
  return null;
}

/**
 * The video's DISPLAY size (rotation side data and a non-square sample aspect applied, as ffmpeg's decoder shows it)
 * and the video stream's own duration (a longer audio track does not extend it).
 */
export function probeVideo(video: string): { width: number; height: number; duration: number } {
  const r = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries",
    "stream=width,height,sample_aspect_ratio,duration:stream_side_data=rotation:format=duration", "-of", "json", video], { encoding: "utf8" });
  if (r.error) throw new Error(`frame cover needs ffprobe on PATH: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`ffprobe could not read ${video}: ${r.stderr.trim()}`);
  type S = { width: number; height: number; sample_aspect_ratio?: string; duration?: string; side_data_list?: Array<{ rotation?: number }> };
  const j = JSON.parse(r.stdout) as { streams?: S[]; format?: { duration?: string } };
  const s = j.streams?.[0];
  if (!s?.width || !s?.height) throw new Error(`no video stream in ${video}`);
  let width = s.width, height = s.height;
  const [sn, sd] = (s.sample_aspect_ratio ?? "1:1").split(":").map(Number);
  if (sn > 0 && sd > 0 && sn !== sd) width = Math.round(width * sn / sd);
  const rot = Math.abs(Number(s.side_data_list?.find(d => d.rotation !== undefined)?.rotation ?? 0)) % 180;
  if (rot === 90) [width, height] = [height, width];
  const duration = Number(s.duration ?? j.format?.duration ?? NaN);
  return { width, height, duration };
}

/** Decode the frame at `at` seconds, scaled to the registered size. Input-side -ss is frame-accurate when decoding. */
function extract(video: string, at: number, shape: Shape, out: string): void {
  const [w, h] = SIZES[shape];
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-nostdin", "-ss", at.toFixed(3), "-i", video, "-frames:v", "1",
    "-vf", `scale=${w}:${h}:flags=lanczos,setsar=1`, "-q:v", "2", "-pix_fmt", "yuvj420p", out], { encoding: "utf8" });
  if (r.error) throw new Error(`frame cover needs ffmpeg on PATH: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`ffmpeg could not extract the frame: ${r.stderr.trim()}`);
  if (!existsSync(out)) throw new Error(`no video frame at ${at.toFixed(3)} s`);
}

function readManifest(path: string): FrameManifest | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as FrameManifest; } catch { return null; }
}

/**
 * Extract the frame at `seconds` from `video` as the Story's cover, full bleed at the registered size for the video's
 * display shape. Writes `<outDir>/frame-<key>/<shape>.jpg` and `manifest.json`; the directory is content-addressed by
 * the Story, the video bytes and the timestamp, so the same request returns the same files.
 */
export function renderFrameCover(story: string, video: string, seconds: number, outDir: string): { manifest: string; cover: string; cached: boolean } {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(story)) throw new Error("invalid Story id");
  const abs = resolve(video);
  if (!existsSync(abs)) throw new Error(`video not found: ${video}`);
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error("--at must be a non-negative number of seconds");
  const at = Math.round(seconds * 1000) / 1000;
  const { width, height, duration } = probeVideo(abs);
  if (Number.isFinite(duration) && at >= duration) throw new Error(`--at ${at} is past the last video frame (${duration.toFixed(3)} s)`);
  const shape = shapeFor(width, height);
  if (!shape) throw new Error(`video displays at ${width}x${height}; a frame cover needs a registered shape (${Object.keys(SIZES).join(", ")})`);
  const [w, h] = SIZES[shape];
  const videoSha = fileSha(abs);
  const dir = resolve(outDir, `frame-${sha(Buffer.from(`${story}|${videoSha}|${at}`)).slice(0, 20)}`);
  const manifestPath = join(dir, "manifest.json"), coverPath = join(dir, `${shape}.jpg`);
  const cached = readManifest(manifestPath);
  if (cached && checkFrameManifest(manifestPath, cached, { story, assetPath: coverPath, sha256: existsSync(coverPath) ? fileSha(coverPath) : "", videos: [{ sha256: videoSha, abs }] }).length === 0) {
    return { manifest: manifestPath, cover: coverPath, cached: true };
  }
  mkdirSync(dir, { recursive: true });
  extract(abs, at, shape, coverPath);
  const bytes = readFileSync(coverPath);
  const check = imageProblems(bytes, bytes.length, bytes, IMAGE_TYPES[sniffImage(bytes)], PUBLISH_IMAGE_BYTES);
  if (check.problems.length) throw new Error(`extracted frame is not a publishable image: ${check.problems.join(", ")}`);
  const manifest: FrameManifest = {
    schema: 1, kind: "frame", story, toolkit: TOOLKIT_VERSION, renderedAt: new Date().toISOString(),
    video: { path: relative(dir, abs), sha256: videoSha }, seconds: at,
    assets: [{ path: `${shape}.jpg`, sha256: sha(bytes), width: check.width ?? w, height: check.height ?? h, role: "cover", shape }],
  };
  const tmp = `${manifestPath}.tmp-${process.pid}`;   // atomic: an interrupted write never leaves a half manifest
  writeFileSync(tmp, JSON.stringify(manifest, null, 2) + "\n");
  renameSync(tmp, manifestPath);
  return { manifest: manifestPath, cover: coverPath, cached: false };
}

/**
 * Problems with a frame manifest.
 * Without `expected` (a local check): the manifest is well formed, its exports are intact and its source video still
 * has the recorded bytes.
 * With `expected` (the staging gate): additionally the cover is this manifest's exact export for this Story, the
 * source is one of the videos being staged (`videos`; none passed means none match), and the frame is re-extracted
 * from that staged file at `seconds` and must match the cover's pixels. A cover taken from an older cut, or a
 * hand-written manifest around any other image, fails.
 */
export function checkFrameManifest(path: string, m: FrameManifest, expected?: { story: string; assetPath: string; sha256: string; videos?: StagedVideo[] }): string[] {
  const errors: string[] = [];
  if (!m || m.schema !== 1 || m.kind !== "frame") return ["not a frame manifest"];
  const root = dirname(path);
  if (expected && m.story !== expected.story) errors.push("manifest belongs to another Story");
  if (!Number.isFinite(m.seconds) || m.seconds < 0) errors.push("frame manifest has no valid timestamp");
  if (!m.video?.path || !/^[0-9a-f]{64}$/.test(m.video?.sha256 ?? "")) return [...errors, "frame manifest has no source video"];
  if (!Array.isArray(m.assets) || !m.assets.length || m.assets.some(a => !a || typeof a.path !== "string" || !Object.hasOwn(SIZES, a.shape))) return [...errors, "frame manifest has no valid cover"];
  let source: string | undefined;
  if (expected) {
    const staged = (expected.videos ?? []).find(v => v.sha256 === m.video.sha256);
    if (!staged) errors.push("frame is not from the video being staged: re-extract it from the current cut");
    else source = staged.abs;   // staging already hashed these bytes; re-extract from them, not from a path the manifest names
  } else {
    const v = resolve(root, m.video.path);
    if (!existsSync(v)) errors.push(`source video missing: ${m.video.path}`);
    else if (fileSha(v) !== m.video.sha256) errors.push("source video changed since the frame was taken");
    else source = v;
  }
  const display = source ? probeVideo(source) : null;
  for (const a of m.assets) {
    const p = resolve(root, a.path);
    if (!existsSync(p) || fileSha(p) !== a.sha256) { errors.push(`changed or missing export: ${a.path}`); continue; }
    const bytes = readFileSync(p), check = imageProblems(bytes, bytes.length, bytes, IMAGE_TYPES[sniffImage(bytes)], PUBLISH_IMAGE_BYTES);
    if (check.problems.length) errors.push(`invalid image ${a.path}: ${check.problems.join(", ")}`);
    const [w, h] = SIZES[a.shape];
    if (check.width !== a.width || check.height !== a.height || a.width !== w || a.height !== h) errors.push(`export dimensions do not match manifest: ${a.path}`);
    if (display && shapeFor(display.width, display.height) !== a.shape) errors.push(`cover shape ${a.shape} does not match the video (${display.width}x${display.height})`);
    if (expected && source && !errors.length) {
      const dir = mkdtempSync(join(tmpdir(), "frame-verify-"));
      try {
        const again = join(dir, "frame.jpg");
        extract(source, m.seconds, a.shape, again);
        const score = psnr(again, p).y;
        if (!(score >= FRAME_MIN_PSNR)) errors.push(`cover pixels are not the frame at ${m.seconds} s of the staged video (${score.toFixed(1)} dB, under ${FRAME_MIN_PSNR})`);
      } catch (e) { errors.push(`could not verify the frame: ${(e as Error).message}`); }
      finally { rmSync(dir, { recursive: true, force: true }); }
    }
  }
  if (expected && !m.assets.some(a => a.role === "cover" && resolve(root, a.path) === resolve(expected.assetPath) && a.sha256 === expected.sha256)) errors.push("cover is not bound to this packaging manifest");
  return errors;
}
