// Upload gate for images, the companion of lib/video-playable.ts (John, 2026-10-13: carousel s1-29 slides 4 and 5 did
// not load in /content). An image is accepted only when /content and every platform can show it: a non-empty JPEG, PNG
// or WebP (never HEIC, AVIF, GIF, TIFF or anything else), labelled with the content type its bytes really are, RGB or
// grayscale (never CMYK or YCCK, and no embedded non-RGB ICC profile), complete (PNG ends in IEND, JPEG in EOI, a WebP's
// RIFF size matches the file), with real dimensions, and within Zernio's 5 MB image limit.
// Pure byte parsing from the head of the file plus its last bytes, so the audit can probe stored images with two small
// range requests, and the server can run it without any image library.
import { inflateSync } from "node:zlib";

/** Zernio's image limit (docs: "Images: JPG, PNG, WebP, GIF, 5MB"), the tightest of the platforms we post to. */
export const PUBLISH_IMAGE_BYTES = 5 * 1000 * 1000;
/** For images that never go to a platform (storyboard frames, guide stills, thumbnails): what a page loads comfortably. */
export const BROWSER_IMAGE_BYTES = 25 * 1000 * 1000;
export const MAX_IMAGE_BYTES = PUBLISH_IMAGE_BYTES;
/** How much of the head the checks read: JPEG frame headers sit behind EXIF and ICC segments. */
export const IMAGE_HEAD_BYTES = 1024 * 1024;
/** JPEG end marker and PNG IEND are looked for this far from the end (phone photos carry trailers after EOI). */
export const IMAGE_TAIL_BYTES = 64 * 1024;

export type ImageFormat = "jpeg" | "png" | "webp" | "gif" | "heic" | "avif" | "tiff" | "bmp" | "unknown";
export const IMAGE_TYPES: Record<string, string> = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };
/** Content types that name the same format (image/jpg is a common alias). */
const TYPE_ALIASES: Record<string, string> = { "image/jpg": "image/jpeg", "image/pjpeg": "image/jpeg" };
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".heif", ".avif", ".tif", ".tiff", ".bmp"]);

export function isImageName(name?: string | null): boolean {
  const m = name?.split("?")[0].toLowerCase().match(/\.[a-z0-9]+$/);
  return !!m && IMAGE_EXT.has(m[0]);
}

export function sniffImage(head: Buffer): ImageFormat {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "jpeg";
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (head.length >= 12 && head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP") return "webp";
  if (head.length >= 6 && /^GIF8[79]a$/.test(head.toString("latin1", 0, 6))) return "gif";
  if (head.length >= 12 && head.toString("latin1", 4, 8) === "ftyp") {
    const brand = head.toString("latin1", 8, 12);
    if (/^avi[fs]$/.test(brand)) return "avif";
    if (/^(heic|heix|hevc|hevx|mif1|msf1)$/.test(brand)) return "heic";
  }
  if (head.length >= 4 && (head.toString("latin1", 0, 4) === "II*\0" || head.toString("latin1", 0, 4) === "MM\0*")) return "tiff";
  if (head.length >= 2 && head.toString("latin1", 0, 2) === "BM") return "bmp";
  return "unknown";
}

/** The color space an ICC profile declares (header bytes 16-19: "RGB ", "GRAY", "CMYK", ...). */
const iccSpace = (profile: Buffer) => (profile.length >= 20 ? profile.toString("latin1", 16, 20).trim() : "");
const iccOk = (space: string) => !space || space === "RGB" || space === "GRAY";

function pngProblems(head: Buffer, size: number, tail: Buffer): { problems: string[]; width?: number; height?: number } {
  const problems: string[] = [];
  if (head.length < 33 || head.toString("latin1", 12, 16) !== "IHDR") return { problems: ["PNG has no IHDR header"] };
  const width = head.readUInt32BE(16), height = head.readUInt32BE(20);
  const colorType = head[25];
  if (![0, 2, 3, 4, 6].includes(colorType)) problems.push(`PNG color type ${colorType} is invalid`);
  // Chunks up to the first IDAT, looking for an embedded ICC profile.
  let at = 8;
  while (at + 12 <= head.length) {
    const len = head.readUInt32BE(at);
    const type = head.toString("latin1", at + 4, at + 8);
    if (type === "IDAT") break;
    if (type === "iCCP" && at + 8 + len <= head.length) {
      const body = head.subarray(at + 8, at + 8 + len);
      const nul = body.indexOf(0);
      try {
        const space = iccSpace(inflateSync(body.subarray(nul + 2)));
        if (!iccOk(space)) problems.push(`embedded ICC profile is ${space}, not RGB`);
      } catch { problems.push("embedded ICC profile does not decompress"); }
    }
    at += 12 + len;
  }
  if (size > head.length && tail.length < 12) problems.push("could not read the end of the file");
  else {
    const end = size <= head.length ? head.subarray(0, size) : tail;
    // IEND near the end (a few padding bytes after it still load).
    if (end.length < 12 || end.subarray(Math.max(0, end.length - IMAGE_TAIL_BYTES)).lastIndexOf("IEND") < 0) problems.push("PNG is truncated (no IEND at the end)");
  }
  return { problems, width, height };
}

function jpegProblems(head: Buffer, size: number, tail: Buffer): { problems: string[]; width?: number; height?: number } {
  const problems: string[] = [];
  let width: number | undefined, height: number | undefined, components: number | undefined;
  let adobeTransform: number | undefined;
  const icc: Buffer[] = [];
  let at = 2;
  while (at + 4 <= head.length) {
    if (head[at] !== 0xff) { problems.push("JPEG marker stream is corrupt"); break; }
    const marker = head[at + 1];
    if (marker === 0xff) { at++; continue; }
    if (marker === 0xd9 || marker === 0xda) break; // EOI before a frame, or start of scan: the headers are done
    if (marker >= 0xd0 && marker <= 0xd7) { at += 2; continue; }
    const len = head.readUInt16BE(at + 2);
    const seg = head.subarray(at + 4, Math.min(at + 2 + len, head.length));
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker) && seg.length >= 6) {
      height = seg.readUInt16BE(1); width = seg.readUInt16BE(3); components = seg[5];
    } else if (marker === 0xe2 && seg.toString("latin1", 0, 12) === "ICC_PROFILE\0") icc.push(seg.subarray(14));
    else if (marker === 0xee && seg.toString("latin1", 0, 5) === "Adobe" && seg.length >= 12) adobeTransform = seg[11];
    at += 2 + len;
  }
  if (components === undefined) problems.push("JPEG has no frame header in its first 1 MB");
  else if (components === 4) problems.push(`JPEG is CMYK${adobeTransform === 2 ? " (YCCK)" : ""}, not RGB`);
  else if (components !== 1 && components !== 3) problems.push(`JPEG has ${components} color components`);
  if (icc.length) { const space = iccSpace(Buffer.concat(icc)); if (!iccOk(space)) problems.push(`embedded ICC profile is ${space}, not RGB`); }
  const end = size <= head.length ? head.subarray(0, size) : tail;
  // A Motion Photo (Pixel, Samsung) carries a video after the JPEG's EOI, so the file does not end in one. Its XMP says
  // so in the head; failing that, an EOI followed straight by an MP4 box ("....ftyp") marks the end of the picture.
  const eoiThenMp4 = (() => { for (let i = head.indexOf(Buffer.from([0xff, 0xd9])); i >= 0; i = head.indexOf(Buffer.from([0xff, 0xd9]), i + 1)) if (head.toString("latin1", i + 6, i + 10) === "ftyp") return true; return false; })();
  const motionPhoto = /MotionPhoto|MicroVideo|GContainer|Container:Directory/.test(head.toString("latin1", 0, Math.min(head.length, 256 * 1024))) || eoiThenMp4 || tail.includes("SEFT");
  if (size > head.length && tail.length < 2) problems.push("could not read the end of the file");
  else if (motionPhoto) { /* the picture ends inside the file; the trailer after it is the motion clip */ }
  // EOI anywhere in the last 64 KB: Motion Photo and Samsung trailers, and padding, follow it and still load.
  else if (end.subarray(Math.max(0, end.length - IMAGE_TAIL_BYTES)).lastIndexOf(Buffer.from([0xff, 0xd9])) < 0) problems.push("JPEG is truncated (no end-of-image marker)");
  return { problems, width, height };
}

function webpProblems(head: Buffer, size: number): { problems: string[]; width?: number; height?: number } {
  const problems: string[] = [];
  if (head.readUInt32LE(4) + 8 !== size) problems.push(`WebP is truncated or padded (RIFF says ${head.readUInt32LE(4) + 8} bytes, the file is ${size})`);
  const chunk = head.toString("latin1", 12, 16);
  let width: number | undefined, height: number | undefined;
  if (chunk === "VP8X" && head.length >= 30) { width = 1 + head.readUIntLE(24, 3); height = 1 + head.readUIntLE(27, 3); }
  else if (chunk === "VP8 " && head.length >= 30) { width = head.readUInt16LE(26) & 0x3fff; height = head.readUInt16LE(28) & 0x3fff; }
  else if (chunk === "VP8L" && head.length >= 25) { const b = head.readUInt32LE(21); width = (b & 0x3fff) + 1; height = ((b >> 14) & 0x3fff) + 1; }
  else problems.push(`WebP has an unknown first chunk ${JSON.stringify(chunk)}`);
  return { problems, width, height };
}

export type ImageCheck = { format: ImageFormat; width?: number; height?: number; problems: string[] };

/**
 * Every reason an image would not load in /content or on a platform. `head` is the start of the file (at least
 * IMAGE_HEAD_BYTES, or all of it), `tail` its last IMAGE_TAIL_BYTES, `size` its length, `contentType` what it is or
 * will be stored as (checked against the bytes when given).
 */
export function imageProblems(head: Buffer, size: number, tail: Buffer = Buffer.alloc(0), contentType?: string | null, maxBytes = PUBLISH_IMAGE_BYTES): ImageCheck {
  if (!size) return { format: "unknown", problems: ["the file is empty (0 bytes)"] };
  const format = sniffImage(head);
  if (!IMAGE_TYPES[format]) {
    const what = format === "unknown" ? "not an image these bytes can be read as" : format.toUpperCase();
    return { format, problems: [`the file is ${what}; only JPEG, PNG and WebP load everywhere`] };
  }
  const r = format === "png" ? pngProblems(head, size, tail) : format === "jpeg" ? jpegProblems(head, size, tail) : webpProblems(head, size);
  const problems = [...r.problems];
  const type = contentType ? TYPE_ALIASES[contentType.toLowerCase()] ?? contentType.toLowerCase() : null;
  if (type && type !== IMAGE_TYPES[format]) problems.push(`stored as ${contentType} but the bytes are ${format.toUpperCase()} (${IMAGE_TYPES[format]})`);
  if (r.width !== undefined && (!r.width || !r.height)) problems.push(`image is ${r.width}x${r.height}`);
  if (size > maxBytes) problems.push(maxBytes === PUBLISH_IMAGE_BYTES ? `${(size / 1e6).toFixed(1)} MB is over the 5 MB image limit (Zernio, LinkedIn, Instagram)` : `${(size / 1e6).toFixed(1)} MB is over the ${maxBytes / 1e6} MB limit for an image in the cockpit`);
  return { format, width: r.width, height: r.height, problems };
}

/** The same for a whole image in memory. */
export const imageBytesProblems = (bytes: Buffer, contentType?: string | null, maxBytes = PUBLISH_IMAGE_BYTES) =>
  imageProblems(bytes.subarray(0, IMAGE_HEAD_BYTES), bytes.length, bytes.subarray(Math.max(0, bytes.length - IMAGE_TAIL_BYTES)), contentType, maxBytes).problems;
