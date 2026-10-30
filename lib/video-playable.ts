// Upload gate for review and scheduling video: the /content player and the social platforms only
// play H.264 at Baseline/Main/High (8-bit 4:2:0) with the moov box ahead of the media data.
// Clips 02-05 shipped as High 4:4:4 with moov at the end and would not play (2026-10-06).
// The s1-14 clips (uploaded 2026-10-06, before this gate) sat broken in storage until John hit them on 2026-10-13, so
// every write path now refuses through lib/media-guard.ts, `gtm story stage` re-encodes on its own (lib/video-heal.ts),
// and `gtm media audit` plus a daily cron re-probe what is stored (lib/media-audit.ts).
// Pure byte parsing, so it runs anywhere the CLI does (and on Vercel), without ffprobe.
import { closeSync, openSync, readSync, statSync } from "node:fs";

const PLAYABLE_PROFILES: Record<number, string> = { 66: "Baseline", 77: "Main", 100: "High" };
const PROFILE_NAMES: Record<number, string> = { 88: "Extended", 110: "High 10", 122: "High 4:2:2", 244: "High 4:4:4 Predictive", 44: "CAVLC 4:4:4" };

/** The hub RESOLVER's fix, word for word (AAC audio may be copied instead when it already is AAC). */
export const REENCODE_HINT =
  "ffmpeg -i in.mp4 -c:v libx264 -profile:v high -pix_fmt yuv420p -crf 16 -preset slow -c:a aac -b:a 256k -movflags +faststart out.mp4";

type Box = { type: string; start: number; body: number; end: number };

function boxes(buf: Buffer, from: number, to: number): Box[] {
  const out: Box[] = [];
  let at = from;
  while (at + 8 <= to) {
    let size = buf.readUInt32BE(at);
    const type = buf.toString("latin1", at + 4, at + 8);
    let body = at + 8;
    if (size === 1) {
      if (at + 16 > to) break;
      size = Number(buf.readBigUInt64BE(at + 8)); body = at + 16;
    } else if (size === 0) size = to - at;
    if (size < body - at || at + size > to) break;
    out.push({ type, start: at, body, end: at + size });
    at += size;
  }
  return out;
}

const child = (buf: Buffer, box: Box | undefined, type: string, skip = 0) =>
  box ? boxes(buf, box.body + skip, box.end).find((b) => b.type === type) : undefined;

/** Problems that stop a browser from playing this MP4; empty when it is safe to upload. */
export function webPlayableProblems(buf: Buffer): string[] {
  const top = boxes(buf, 0, buf.length);
  const moovAt = top.findIndex((b) => b.type === "moov");
  const mdatAt = top.findIndex((b) => b.type === "mdat");
  if (moovAt < 0) return ["no moov box (not a complete MP4)"];
  const problems: string[] = [];
  if (mdatAt >= 0 && mdatAt < moovAt) problems.push("moov box sits after the media data (not faststart), so the player stalls before it can start");
  const moov = top[moovAt];
  let videoTracks = 0;
  for (const trak of boxes(buf, moov.body, moov.end).filter((b) => b.type === "trak")) {
    const mdia = child(buf, trak, "mdia");
    const hdlr = child(buf, mdia, "hdlr");
    const handler = hdlr ? buf.toString("latin1", hdlr.body + 8, hdlr.body + 12) : "";
    const stsd = child(buf, child(buf, child(buf, mdia, "minf"), "stbl"), "stsd");
    const entry = stsd ? boxes(buf, stsd.body + 8, stsd.end)[0] : undefined;
    if (handler === "soun") {
      // AAC (mp4a) is what every browser and platform decodes; Opus, AC-3, PCM or ALAC in an MP4 is not.
      if (entry && entry.type !== "mp4a") problems.push(`audio codec is ${entry.type.trim()}, not AAC (mp4a)`);
      continue;
    }
    if (handler !== "vide") continue;
    videoTracks++;
    if (!entry) { problems.push("video track has no sample description"); continue; }
    if (entry.type !== "avc1" && entry.type !== "avc3") { problems.push(`video codec is ${entry.type.trim()}, not H.264 (avc1)`); continue; }
    // VisualSampleEntry fields take 78 bytes before the child boxes
    const avcC = child(buf, entry, "avcC", 78);
    if (!avcC) { problems.push("H.264 track has no avcC configuration"); continue; }
    const profile = buf[avcC.body + 1];
    if (!PLAYABLE_PROFILES[profile]) {
      problems.push(`H.264 profile is ${PROFILE_NAMES[profile] ?? `#${profile}`}; browsers only decode Baseline, Main or High (8-bit 4:2:0)`);
    }
  }
  if (!videoTracks) problems.push("no video track");
  return problems;
}

/** Throws with the fix when an MP4 would not play on the review page or the platforms. */
export function assertWebPlayable(buf: Buffer, label: string) {
  const problems = webPlayableProblems(buf);
  if (problems.length) throw new Error(`${label} will not play in a browser: ${problems.join("; ")}. Re-encode it first:\n  ${REENCODE_HINT}`);
}

/** Reads bytes [start, end) of a stored file: a ranged HTTP GET, a file read, a slice. */
export type RangeReader = (start: number, end: number) => Promise<Buffer>;

/**
 * webPlayableProblems from the box headers and the moov box alone, read through `read`: the cheap probe the audit uses
 * on stored media (a few KB for a faststart file, two or three small range requests otherwise), never the media data.
 */
export async function webPlayableProblemsRanged(read: RangeReader, size: number, headBytes = 256 * 1024): Promise<string[]> {
  if (size < 8) return ["no moov box (not a complete MP4)"];
  const head = await read(0, Math.min(size, headBytes));
  const bytes = async (start: number, end: number) => (end <= head.length ? head.subarray(start, end) : read(start, Math.min(end, size)));
  const parts: Buffer[] = [];
  let at = 0;
  for (let n = 0; at + 8 <= size && n < 64; n++) {
    const h = await bytes(at, Math.min(at + 16, size));
    if (h.length < 8) break;
    let len = h.readUInt32BE(0);
    const type = h.toString("latin1", 4, 8);
    if (len === 1) { if (h.length < 16) break; len = Number(h.readBigUInt64BE(8)); } else if (len === 0) len = size - at;
    if (len < 8 || at + len > size) break;
    if (type === "moov") {
      if (len > 512 * 1024 * 1024) return ["moov box is implausibly large"];
      const moov = Buffer.from(await bytes(at, at + len));
      if (moov.length !== len) return ["moov box could not be read whole"];
      if (moov.readUInt32BE(0) === 1) return ["moov box uses a 64-bit size, which this check does not read"];
      parts.push(moov);
    } else {
      const stub = Buffer.alloc(8);
      stub.writeUInt32BE(8); stub.write(type, 4, "latin1");
      parts.push(stub);
    }
    at += len;
  }
  return webPlayableProblems(Buffer.concat(parts));
}

/**
 * webPlayableProblems for a file of any size: walks the top-level boxes by their headers (seeking past mdat) and reads
 * only the moov box, then checks a stand-in buffer with the same box order (empty boxes for everything but moov).
 */
export function webPlayableProblemsFile(path: string): string[] {
  const size = statSync(path).size;
  const fd = openSync(path, "r");
  try {
    const parts: Buffer[] = [];
    const head = Buffer.alloc(16);
    let at = 0;
    while (at + 8 <= size) {
      readSync(fd, head, 0, 16, at);
      let len = head.readUInt32BE(0);
      const type = head.toString("latin1", 4, 8);
      if (len === 1) len = Number(head.readBigUInt64BE(8));
      else if (len === 0) len = size - at;
      if (len < 8 || at + len > size) break;
      if (type === "moov") {
        if (len > 512 * 1024 * 1024) return ["moov box is implausibly large"];
        const moov = Buffer.alloc(len);
        readSync(fd, moov, 0, len, at);
        if (moov.readUInt32BE(0) === 1) return ["moov box uses a 64-bit size, which this check does not read"];
        parts.push(moov);
      } else {
        const stub = Buffer.alloc(8);
        stub.writeUInt32BE(8); stub.write(type, 4, "latin1");
        parts.push(stub);
      }
      at += len;
    }
    return webPlayableProblems(Buffer.concat(parts));
  } finally { closeSync(fd); }
}

