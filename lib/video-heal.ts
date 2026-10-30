// Self-heal for video that will not play in a browser (CLI only: it needs ffmpeg and local files). `gtm story stage`
// and `gtm media audit --fix` re-encode to the hub RESOLVER spec (H.264 High, 8-bit yuv420p, AAC, faststart) with the
// picture and audio otherwise unchanged, then prove it: the same number of video frames, the same duration, and a PSNR
// against the original high enough that nobody could see the difference. A transcode that fails any of that is refused,
// never uploaded. Server-side uploads never come here; they refuse (lib/media-guard.ts).
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { homedir } from "node:os";
import { sha256File } from "./large-media";
import { webPlayableProblemsFile } from "./video-playable";

/**
 * Luma PSNR (dB) the re-encode must reach against the original. The luma plane is where a re-encode could lose picture;
 * the chroma planes also carry the 4:4:4 to 4:2:0 subsampling the fix exists to make, so they are reported, not gated.
 * crf 16 lands around 45-50 on real footage; 40 is visually lossless.
 */
export const MIN_PSNR = 40;

export type Verification = { frames: number; framesOut: number; duration: number; durationOut: number; /** luma */ psnr: number; /** all planes at 4:4:4 */ psnrAll: number };
export type HealResult = Verification & { file: string; problems: string[]; audio: "copied" | "aac" | "none"; remuxed: boolean; backup?: string; sha256Before: string; sha256After: string };

let ffmpegKnown: boolean | undefined;
/** ffmpeg and ffprobe on PATH (never on Vercel). */
export function ffmpegAvailable(): boolean {
  if (ffmpegKnown === undefined) {
    ffmpegKnown = !process.env.VERCEL && ["ffmpeg", "ffprobe"].every((bin) => spawnSync(bin, ["-version"], { stdio: "ignore" }).status === 0);
  }
  return ffmpegKnown;
}

function probe(file: string, args: string[]): string {
  const r = spawnSync("ffprobe", ["-v", "error", ...args, file], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`ffprobe ${basename(file)}: ${r.stderr.trim().slice(-300)}`);
  return r.stdout.trim();
}

/** Video frames, counted from the packets (exact, and fast: nothing is decoded). */
export function countFrames(file: string): number {
  const n = Number(probe(file, ["-select_streams", "v:0", "-count_packets", "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0"]).split(/\s/)[0]);
  if (!Number.isFinite(n)) throw new Error(`could not count the frames of ${basename(file)}`);
  return n;
}

export const durationOf = (file: string) => Number(probe(file, ["-show_entries", "format=duration", "-of", "csv=p=0"])) || 0;
const audioCodec = (file: string) => probe(file, ["-select_streams", "a:0", "-show_entries", "stream=codec_name", "-of", "csv=p=0"]).split(/\s/)[0] || null;

/** PSNR of `out` against `src`, both compared at 4:4:4: luma (y) and all planes (average). */
export function psnr(src: string, out: string): { y: number; all: number } {
  const r = spawnSync("ffmpeg", ["-v", "info", "-nostdin", "-i", out, "-i", src, "-lavfi", "[0:v]format=yuv444p[a];[1:v]format=yuv444p[b];[a][b]psnr", "-f", "null", "-"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`psnr ${basename(src)}: ${r.stderr.trim().slice(-300)}`);
  const m = r.stderr.match(/PSNR y:(inf|[\d.]+) .*average:(inf|[\d.]+)/);
  if (!m) throw new Error(`psnr ${basename(src)}: no result`);
  const n = (x: string) => (x === "inf" ? Infinity : Number(x));
  return { y: n(m[1]), all: n(m[2]) };
}

const FASTSTART_ONLY = /^moov box sits after the media data/;

/**
 * Re-encodes `src` to `out` at the RESOLVER spec. Video frames and timing pass through; AAC audio is copied as is.
 * When the only fault is the moov box at the end, the streams are copied untouched and only moved (lossless).
 */
export function transcodePlayable(src: string, out: string): { audio: "copied" | "aac" | "none"; remuxed: boolean } {
  const audio = audioCodec(src);
  const mode = audio === null ? "none" : audio === "aac" ? "copied" : "aac";
  const problems = webPlayableProblemsFile(src);
  if (problems.length && problems.every((p) => FASTSTART_ONLY.test(p)) && mode !== "aac") {
    const remux = spawnSync("ffmpeg", ["-v", "error", "-nostdin", "-y", "-i", src, "-map", "0", "-c", "copy", "-map_metadata", "0", "-movflags", "+faststart", out], { stdio: ["ignore", "ignore", "pipe"] });
    if (remux.status === 0) return { audio: mode, remuxed: true };
  }
  const r = spawnSync("ffmpeg", [
    "-v", "error", "-nostdin", "-y", "-i", src, "-map", "0:v:0", "-map", "0:a:0?", "-map_metadata", "0",
    "-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p", "-crf", "16", "-preset", "slow", "-fps_mode", "passthrough",
    ...(mode === "copied" ? ["-c:a", "copy"] : mode === "aac" ? ["-c:a", "aac", "-b:a", "256k"] : []),
    "-movflags", "+faststart", out,
  ], { stdio: ["ignore", "ignore", "pipe"], maxBuffer: 16 * 1024 * 1024 });
  if (r.error) throw new Error(`re-encode needs ffmpeg on PATH: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`re-encode of ${basename(src)} failed: ${r.stderr?.toString().trim().slice(-500)}`);
  return { audio: mode, remuxed: false };
}

/** Proves `out` is `src` re-encoded: playable, same frame count, same duration (to a frame or two), PSNR >= MIN_PSNR. */
export function verifyTranscode(src: string, out: string): Verification {
  const problems = webPlayableProblemsFile(out);
  if (problems.length) throw new Error(`the re-encode of ${basename(src)} still will not play: ${problems.join("; ")}`);
  const p = psnr(src, out);
  const v = { frames: countFrames(src), framesOut: countFrames(out), duration: durationOf(src), durationOut: durationOf(out), psnr: p.y, psnrAll: p.all };
  if (v.frames !== v.framesOut) throw new Error(`the re-encode of ${basename(src)} has ${v.framesOut} frames, the original ${v.frames}`);
  if (Math.abs(v.duration - v.durationOut) > 0.1) throw new Error(`the re-encode of ${basename(src)} runs ${v.durationOut.toFixed(3)}s, the original ${v.duration.toFixed(3)}s`);
  if (!(v.psnr >= MIN_PSNR)) throw new Error(`the re-encode of ${basename(src)} is ${v.psnr.toFixed(1)} dB luma PSNR, under ${MIN_PSNR}`);
  return v;
}

/** Re-encode a file to a new path and verify it. Throws (and leaves nothing behind) when any check fails. */
export function healTo(src: string, out: string): Verification & { audio: "copied" | "aac" | "none"; remuxed: boolean } {
  try {
    const t = transcodePlayable(src, out);
    return { ...verifyTranscode(src, out), ...t };
  } catch (e) {
    rmSync(out, { force: true });
    throw e;
  }
}

/** Where an original goes when its file is replaced: outside the workspace (which tracks MP4s in git), one per sha. */
export const unplayableDir = () => process.env.GTM_UNPLAYABLE_DIR ?? join(homedir(), ".cache/gtm/unplayable");

/** Copies the original of a file about to be replaced to unplayableDir(); returns where it went. */
export function keepOriginal(file: string, sha256: string): string {
  const dir = unplayableDir();
  mkdirSync(dir, { recursive: true });
  const backup = join(dir, `${sha256.slice(0, 8)}-${basename(file)}`);
  if (!existsSync(backup)) copyFileSync(file, backup);
  return backup;
}

/**
 * Re-encodes an unplayable local file in place: the playable version takes its path (so a manifest, a restage and the
 * calendar keep pointing at it, and a restage of the same file stages the same bytes), and the original is kept as
 * a copy in ~/.cache/gtm/unplayable/<sha8>-<name> (never in the workspace, which tracks MP4s in git). Null when it plays.
 */
export function healInPlace(file: string, log: (line: string) => void = (l) => process.stderr.write(`${l}\n`)): HealResult | null {
  const problems = webPlayableProblemsFile(file);
  if (!problems.length) return null;
  if (!ffmpegAvailable()) throw new Error(`${basename(file)} will not play in a browser (${problems.join("; ")}) and ffmpeg is not on PATH to re-encode it`);
  const sha256Before = sha256File(file);
  const ext = extname(file);
  const tmp = join(dirname(file), `.${basename(file, ext)}.playable-${process.pid}${ext}`);
  const started = Date.now();
  log(`re-encoding ${basename(file)}: ${problems.join("; ")}`);
  const v = healTo(file, tmp);
  const backup = keepOriginal(file, sha256Before);
  renameSync(tmp, file);
  const sha256After = sha256File(file);
  log(`${v.remuxed ? "moved the moov box to the front of (no re-encode)" : "re-encoded"} ${basename(file)}${v.remuxed ? "" : " to H.264 High yuv420p"} in ${((Date.now() - started) / 1000).toFixed(0)}s: ${v.frames} frames kept, PSNR ${v.psnr === Infinity ? "inf" : v.psnr.toFixed(1)} dB luma (${v.psnrAll === Infinity ? "inf" : v.psnrAll.toFixed(1)} all planes), audio ${v.audio}, ${(statSync(file).size / 1048576).toFixed(1)} MiB; original kept at ${basename(backup)}`);
  return { ...v, file, problems, backup, sha256Before, sha256After };
}
