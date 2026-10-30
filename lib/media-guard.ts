// The one gate every media write goes through (video since 2026-10-13 morning, images since that afternoon): Supabase Storage (content-review), Zernio's media upload, the resumable
// endpoint. Each refuses bytes a browser cannot play (lib/video-playable.ts) before anything is sent. Server-side paths
// only refuse; the CLI's `gtm story stage` re-encodes first (lib/video-heal.ts) and then lands here like everything else.
// test/upload-guard.test.ts fails when a module writes media without calling one of these, so a new upload path cannot
// skip it (the s1-14 clips of 2026-10-06 did, and sat broken in storage for a week).
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { extname } from "node:path";
import { BROWSER_IMAGE_BYTES, IMAGE_HEAD_BYTES, IMAGE_TAIL_BYTES, imageBytesProblems, imageProblems, isImageName, PUBLISH_IMAGE_BYTES } from "./image-loadable";
import { REENCODE_HINT, webPlayableProblems, webPlayableProblemsFile, webPlayableProblemsRanged, type RangeReader } from "./video-playable";

const VIDEO_EXT = new Set([".mp4", ".m4v", ".mov", ".webm", ".mkv", ".avi"]);

/** A video by content type or by file name (a key, a path, a filename). */
export function isVideo(contentType?: string | null, name?: string | null): boolean {
  if (contentType && /^video\//i.test(contentType)) return true;
  const ext = name ? extname(name.split("?")[0]).toLowerCase() : "";
  return VIDEO_EXT.has(ext);
}

/** Problems for something that is not an MP4 at all (a .mov, a .webm): the platforms and /content take MP4 only. */
function containerProblems(contentType?: string | null, name?: string | null): string[] {
  const ext = name ? extname(name.split("?")[0]).toLowerCase() : "";
  if (ext && ext !== ".mp4" && VIDEO_EXT.has(ext)) return [`${ext} is not an MP4`];
  if (contentType && /^video\//i.test(contentType) && contentType.toLowerCase() !== "video/mp4") return [`${contentType} is not video/mp4`];
  return [];
}

export class UnplayableVideoError extends Error {
  constructor(readonly label: string, readonly problems: string[]) {
    super(`${label} will not play in a browser: ${problems.join("; ")}. Refused before upload. Re-encode it first:\n  ${REENCODE_HINT}`);
    this.name = "UnplayableVideoError";
  }
}

export class UnloadableImageError extends Error {
  constructor(readonly label: string, readonly problems: string[]) {
    super(`${label} will not load in a browser or on the platforms: ${problems.join("; ")}. Refused before upload. Export it as an sRGB PNG or JPEG under 5 MB.`);
    this.name = "UnloadableImageError";
  }
}

/** An image by content type or by file name. */
export function isImage(contentType?: string | null, name?: string | null): boolean {
  return !!(contentType && /^image\//i.test(contentType)) || isImageName(name);
}

/** Every reason these bytes would not load as an image; empty for a good image or anything that is not an image. */
export function imageUploadProblems(bytes: Uint8Array, contentType?: string | null, name?: string | null, opts: { publish?: boolean } = {}): string[] {
  if (!isImage(contentType, name)) return [];
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return imageBytesProblems(buf, contentType && /^image\//i.test(contentType) ? contentType : null, opts.publish ? PUBLISH_IMAGE_BYTES : BROWSER_IMAGE_BYTES);
}

/**
 * The guard every upload helper calls: refuses a video that will not play or an image that will not load, before any
 * byte is sent. A no-op for PDFs and copy. `label` names the file (a key, a path, a filename) in the error.
 */
export function guardMediaBytes(bytes: Uint8Array, contentType: string | null | undefined, label: string, opts: { /** it goes out to a platform: Zernio's 5 MB image limit applies */ publish?: boolean } = {}): void {
  guardVideoBytes(bytes, contentType, label);
  const problems = imageUploadProblems(bytes, contentType, label, opts);
  if (problems.length) throw new UnloadableImageError(label, problems);
}

/** Every reason these bytes would not play; empty for a playable MP4 or anything that is not a video. */
export function videoBytesProblems(bytes: Uint8Array, contentType?: string | null, name?: string | null): string[] {
  if (!isVideo(contentType, name)) return [];
  const container = containerProblems(contentType, name);
  if (container.length) return container;
  return webPlayableProblems(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
}

/** Refuses video bytes that will not play. A no-op for images, PDFs and copy, so every upload helper can call it. */
export function guardVideoBytes(bytes: Uint8Array, contentType: string | null | undefined, label: string): void {
  const problems = videoBytesProblems(bytes, contentType, label);
  if (problems.length) throw new UnplayableVideoError(label, problems);
}

/** The same for a file of any size (an episode master): reads only its box headers and moov. */
export function guardVideoFile(path: string, contentType: string | null | undefined, label = path): void {
  if (!isVideo(contentType, path)) return;
  const problems = [...containerProblems(contentType, path)];
  if (!problems.length) problems.push(...webPlayableProblemsFile(path));
  if (problems.length) throw new UnplayableVideoError(label, problems);
}

/** The same for bytes reached by range reads (a stored master streamed on to Zernio). */
export async function guardVideoRanged(read: RangeReader, size: number, contentType: string | null | undefined, label: string): Promise<void> {
  if (!isVideo(contentType, label)) return;
  const problems = [...containerProblems(contentType, label)];
  if (!problems.length) problems.push(...(await webPlayableProblemsRanged(read, size)));
  if (problems.length) throw new UnplayableVideoError(label, problems);
}

/** A GET that waits out a rate limit (Storage answers 429 to a burst of probes) or a passing 5xx. */
async function getWithRetry(url: string, headers: Record<string, string>, fetchImpl: typeof fetch): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let res: Response | undefined;
    // no-store: Next's patched fetch must not cache or dedupe a range read; a timeout so a stalled read cannot hang a page.
    // Bounded: at most 4 tries of 10 s and 3 waits of 4 s or less, so one read never runs past about 50 s (the cron starts
    // no probe after 200 s of its 300 s).
    try { res = await fetchImpl(url, { headers, cache: "no-store", signal: AbortSignal.timeout(10_000) }); } catch (e) { if (attempt >= 3) throw e; }
    if (res && res.status !== 429 && res.status < 500) return res;
    if (res && attempt >= 3) return res;
    await res?.body?.cancel().catch(() => {});
    await new Promise((r) => setTimeout(r, Math.min(4000, Number(res?.headers.get("retry-after")) * 1000 || 500 * 2 ** attempt)));
  }
}

/** A RangeReader over HTTP(S): a signed Storage URL, a public CDN URL. */
export function httpRangeReader(url: string, fetchImpl: typeof fetch = fetch): RangeReader {
  return async (start, end) => {
    const res = await getWithRetry(url, { range: `bytes=${start}-${end - 1}` }, fetchImpl);
    if (res.status !== 206 && res.status !== 200) throw new Error(`range read ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    // A server that ignores Range sends the whole file from byte 0.
    return res.status === 200 ? buf.subarray(start, end) : buf;
  };
}

/** Size and served content type of a remote object from a one-byte ranged GET. */
export async function remoteMeta(url: string, fetchImpl: typeof fetch = fetch): Promise<{ size: number | null; contentType: string | null }> {
  const res = await getWithRetry(url, { range: "bytes=0-0" }, fetchImpl);
  const contentType = res.headers.get("content-type");
  const range = res.headers.get("content-range")?.match(/\/(\d+)$/);
  await res.body?.cancel().catch(() => {});
  if (!res.ok) return { size: null, contentType: null };
  const len = Number(res.headers.get("content-length"));
  return { size: range ? Number(range[1]) : Number.isFinite(len) ? len : null, contentType };
}

/** Size of a remote object from a one-byte ranged GET (Content-Range), or null. */
export async function remoteSize(url: string, fetchImpl: typeof fetch = fetch): Promise<number | null> {
  const res = await getWithRetry(url, { range: "bytes=0-0" }, fetchImpl);
  if (!res.ok) return null;
  const range = res.headers.get("content-range")?.match(/\/(\d+)$/);
  await res.body?.cancel().catch(() => {});
  if (range) return Number(range[1]);
  const len = Number(res.headers.get("content-length"));
  return Number.isFinite(len) && len > 0 ? len : null;
}

/** Header-only probe of a remote video. Throws only when the URL cannot be read. */
export async function remoteVideoProblems(url: string, name: string, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const container = containerProblems(null, name);
  if (container.length) return container;
  const size = await remoteSize(url, fetchImpl);
  if (!size) throw new Error(`could not read the size of ${name}`);
  return webPlayableProblemsRanged(httpRangeReader(url, fetchImpl), size);
}

/** Header-and-tail probe of a remote image (two small range reads). `contentType` is what it is served as. */
export async function remoteImageProblems(read: RangeReader, size: number, contentType?: string | null, maxBytes = BROWSER_IMAGE_BYTES): Promise<string[]> {
  if (!size) return ["the file is empty (0 bytes)"];
  const head = await read(0, Math.min(size, IMAGE_HEAD_BYTES));
  const tail = size > head.length ? await read(Math.max(0, size - IMAGE_TAIL_BYTES), size) : Buffer.alloc(0);
  return imageProblems(head, size, tail, contentType && /^image\//i.test(contentType) ? contentType : null, maxBytes).problems;
}

/** The same for a local file of any size (a guide still, an export). */
export function guardImageFile(path: string, contentType: string | null | undefined, label = path): void {
  if (!isImage(contentType, path)) return;
  const size = statSync(path).size;
  const fd = openSync(path, "r");
  try {
    const head = Buffer.alloc(Math.min(size, IMAGE_HEAD_BYTES)); readSync(fd, head, 0, head.length, 0);
    const tail = Buffer.alloc(Math.min(size, IMAGE_TAIL_BYTES)); readSync(fd, tail, 0, tail.length, size - tail.length);
    const problems = imageProblems(head, size, tail, contentType && /^image\//i.test(contentType) ? contentType : null, BROWSER_IMAGE_BYTES).problems;
    if (problems.length) throw new UnloadableImageError(label, problems);
  } finally { closeSync(fd); }
}
