// Large media: a full podcast episode final (1080p, about an hour, 2.5 to 5 GB) staged as a Story's video.
// Node Buffers cannot hold files that size, and content-review's old 50 MiB single-request upload refused them, so a
// file over LARGE_MEDIA_BYTES is never read into memory: it is hashed in chunks, checked for web playback from its box
// headers and moov, uploaded with Supabase's resumable (TUS) endpoint in 6 MiB chunks, and given a small 720p review
// proxy that /content and /shared play. Approval always binds to the MASTER's sha256 (the bytes that go out), never
// to the proxy's: the proxy is only how John and a third party watch it.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { webPlayableProblemsFile } from "./video-playable";
import { guardVideoFile } from "./media-guard";

/** Above this a file takes the large path (streamed hash, resumable upload, review proxy). content-review's old cap. */
export const LARGE_MEDIA_BYTES = 50 * 1024 * 1024;
/** content-review's limit and Zernio's per-media presign limit: nothing bigger could ever be scheduled. */
export const MAX_VIDEO_BYTES = 5 * 1024 * 1024 * 1024;
/** Supabase's resumable endpoint takes exactly 6 MiB chunks (only the last may be shorter). */
export const TUS_CHUNK_BYTES = 6 * 1024 * 1024;

const READ_BYTES = 8 * 1024 * 1024;

/** A verified file too big to hold in memory: where it is, how big, and the sha256 approval binds to. */
export class LargeMedia {
  constructor(readonly path: string, readonly size: number, readonly sha256: string, readonly storageKey?: string) {}
}

export const isLargeSize = (bytes: number) => bytes > LARGE_MEDIA_BYTES;

/** sha256 of a file read in 8 MiB chunks, so memory stays flat for any size. Optionally only its first `limit` bytes. */
export function sha256File(path: string, limit = Infinity) {
  const hash = createHash("sha256");
  const buf = Buffer.allocUnsafe(READ_BYTES);
  const fd = openSync(path, "r");
  try {
    let at = 0;
    while (at < limit) {
      const n = readSync(fd, buf, 0, Math.min(READ_BYTES, limit - at), at);
      if (!n) break;
      hash.update(buf.subarray(0, n));
      at += n;
    }
    return hash.digest("hex");
  } finally { closeSync(fd); }
}

export { webPlayableProblemsFile };

/**
 * Renders the review proxy: same duration, at most 1280x720 (720x1280 for a vertical video), H.264 High yuv420p at
 * about 0.9 Mbit/s, AAC 96k, faststart. Publishing still uses the full-quality master.
 */
export function renderReviewProxy(src: string, out: string) {
  const run = spawnSync("ffmpeg", [
    "-v", "error", "-nostdin", "-y", "-i", src, "-map", "0:v:0", "-map", "0:a:0?",
    "-vf", "scale=w='if(gte(iw,ih),1280,720)':h='if(gte(iw,ih),720,1280)':force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p",
    "-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p", "-preset", "veryfast",
    "-b:v", "900k", "-maxrate", "1200k", "-bufsize", "2400k", "-g", "60",
    "-c:a", "aac", "-b:a", "96k", "-ac", "2", "-movflags", "+faststart", out,
  ], { stdio: ["ignore", "ignore", "pipe"], maxBuffer: 16 * 1024 * 1024 });
  if (run.error) throw new Error(`review proxy needs ffmpeg on PATH: ${run.error.message}`);
  if (run.status !== 0) throw new Error(`review proxy render failed: ${run.stderr?.toString().trim().slice(-500)}`);
  const problems = webPlayableProblemsFile(out);
  if (problems.length) throw new Error(`review proxy will not play in a browser: ${problems.join("; ")}`);
}

/** The resumable endpoint: the direct storage host for a hosted project (faster for big files), else the API URL. */
export function resumableEndpoint(supabaseUrl: string) {
  const u = new URL(supabaseUrl);
  const ref = u.hostname.match(/^([a-z0-9]+)\.supabase\.co$/)?.[1];
  return ref ? `https://${ref}.storage.supabase.co/storage/v1/upload/resumable` : `${u.origin}/storage/v1/upload/resumable`;
}

export type TusUpload = {
  /** NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY unless given. */
  url?: string; key?: string;
  bucket: string; object: string; file: string; contentType: string;
  /** The sha256 the bytes must have (what was hashed at plan time); a file changed since is refused. */
  sha256?: string;
  chunkBytes?: number; retries?: number; fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>;
  onProgress?: (sent: number, total: number) => void;
};

const enc = (s: string) => Buffer.from(s).toString("base64");

/**
 * Uploads a file of any size with the TUS protocol Supabase Storage speaks (create, then PATCH 6 MiB chunks), reading
 * one chunk at a time. A failed chunk resumes from the server's offset (HEAD) with backoff. The bytes are hashed as
 * the server confirms them; returns that sha256 and throws when it differs from `sha256` (the caller removes the object).
 */
export async function tusUpload(o: TusUpload): Promise<{ sha256: string; size: number }> {
  const doFetch = o.fetch ?? globalThis.fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const url = o.url ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = o.key ?? process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("resumable upload needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY");
  // Refused before the first byte goes up: a master (or a proxy) that will not play never reaches storage.
  guardVideoFile(o.file, o.contentType, o.object);
  const chunkBytes = o.chunkBytes ?? TUS_CHUNK_BYTES;
  const retries = o.retries ?? 6;
  const size = statSync(o.file).size;
  const auth = { authorization: `Bearer ${key}`, apikey: key, "tus-resumable": "1.0.0" };
  const endpoint = resumableEndpoint(url);
  const create = await doFetch(endpoint, {
    method: "POST",
    headers: {
      ...auth, "x-upsert": "true", "upload-length": String(size),
      "upload-metadata": [`bucketName ${enc(o.bucket)}`, `objectName ${enc(o.object)}`, `contentType ${enc(o.contentType)}`, `cacheControl ${enc("3600")}`].join(","),
    },
  });
  const location = create.headers.get("location");
  if (create.status !== 201 || !location) throw new Error(`resumable upload of ${o.object} refused: ${create.status} ${(await create.text()).slice(0, 300)}`);
  const target = new URL(location, endpoint).toString();

  let hash = createHash("sha256");
  let hashed = 0;
  // The server is the authority on how much it has: hash exactly the bytes it confirmed, re-reading if it went back.
  const confirm = (offset: number, chunk?: Buffer, chunkAt?: number) => {
    if (chunk && chunkAt === hashed && offset === hashed + chunk.length) { hash.update(chunk); hashed = offset; return; }
    if (offset === hashed) return;
    hash = createHash("sha256");
    hashed = 0;
    if (offset > 0) {
      const fd = openSync(o.file, "r");
      try {
        const buf = Buffer.allocUnsafe(READ_BYTES);
        while (hashed < offset) { const n = readSync(fd, buf, 0, Math.min(READ_BYTES, offset - hashed), hashed); if (!n) break; hash.update(buf.subarray(0, n)); hashed += n; }
      } finally { closeSync(fd); }
    }
  };

  const fd = openSync(o.file, "r");
  try {
    let offset = 0;
    let failures = 0;
    const buf = Buffer.allocUnsafe(chunkBytes);
    while (offset < size) {
      const n = readSync(fd, buf, 0, Math.min(chunkBytes, size - offset), offset);
      const chunk = Buffer.from(buf.subarray(0, n));
      let error: string;
      try {
        const res = await doFetch(target, {
          method: "PATCH",
          headers: { ...auth, "upload-offset": String(offset), "content-type": "application/offset+octet-stream" },
          body: chunk,
        });
        if (res.status === 204 || res.ok) {
          const next = Number(res.headers.get("upload-offset") ?? offset + n);
          confirm(next, chunk, offset);
          offset = next;
          failures = 0;
          o.onProgress?.(offset, size);
          continue;
        }
        const text = (await res.text()).slice(0, 300);
        // 409 (offset mismatch), 423 (locked), 429 and 5xx are worth resuming; anything else is a real refusal.
        if (![409, 423, 429].includes(res.status) && res.status < 500) throw new Error(`resumable upload of ${o.object} failed: ${res.status} ${text}`);
        error = `${res.status} ${text}`;
      } catch (e) {
        if (e instanceof Error && e.message.startsWith("resumable upload")) throw e;
        error = e instanceof Error ? e.message : String(e);
      }
      if (++failures > retries) throw new Error(`resumable upload of ${o.object} gave up at ${offset} of ${size} bytes: ${error}`);
      await sleep(Math.min(30_000, 1000 * 2 ** (failures - 1)));
      try {
        const head = await doFetch(target, { method: "HEAD", headers: auth });
        const at = Number(head.headers.get("upload-offset"));
        if (head.ok && Number.isFinite(at)) { confirm(at); offset = at; }
      } catch { /* the next PATCH retries from the offset we have */ }
    }
  } finally { closeSync(fd); }
  if (hashed !== size) confirm(size);
  const sha256 = hash.digest("hex");
  if (o.sha256 && sha256 !== o.sha256) throw new Error(`${o.file} changed while it was uploading (sha256 ${sha256.slice(0, 12)}, expected ${o.sha256.slice(0, 12)}); stage it again`);
  return { sha256, size };
}

/**
 * Wraps a byte stream so it is hashed as it passes through: the caller reads `digest()` after the stream ends. Used to
 * re-verify a stored master against its approved sha256 while it streams on to Zernio, never holding it in memory.
 */
export function hashingStream(source: ReadableStream<Uint8Array>) {
  const hash = createHash("sha256");
  let bytes = 0;
  let done = false;
  const stream = source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctl) { hash.update(chunk); bytes += chunk.byteLength; ctl.enqueue(chunk); },
    flush() { done = true; },
  }));
  return {
    stream,
    digest() {
      if (!done) throw new Error("the stream has not finished");
      return { sha256: hash.digest("hex"), bytes };
    },
  };
}
