// Tiny real images for the image upload gate (lib/image-loadable.ts): a valid PNG or JPEG of a few dozen bytes.
// `note` goes into a text chunk (PNG) or a comment (JPEG), so two images can differ in bytes and hash.
import { crc32, deflateSync } from "node:zlib";

const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
};

export function png({ w = 2, h = 2, note = "" }: { w?: number; h?: number; note?: string } = {}): Buffer {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr),
    ...(note ? [chunk("tEXt", Buffer.from(`Comment\0${note}`, "latin1"))] : []),
    chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A JPEG header skeleton (SOI, optional comment, SOF0 with `components`, SOS, EOI): enough for the gate, not a decoder. */
export function jpeg({ w = 2, h = 2, components = 3, note = "", eoi = true }: { w?: number; h?: number; components?: number; note?: string; eoi?: boolean } = {}): Buffer {
  const seg = (marker: number, data: Buffer) => { const head = Buffer.from([0xff, marker, 0, 0]); head.writeUInt16BE(data.length + 2, 2); return Buffer.concat([head, data]); };
  const sof = Buffer.alloc(6 + components * 3); sof[0] = 8; sof.writeUInt16BE(h, 1); sof.writeUInt16BE(w, 3); sof[5] = components;
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]), ...(note ? [seg(0xfe, Buffer.from(note))] : []), seg(0xc0, sof),
    seg(0xda, Buffer.from([1, 1, 0, 0, 63, 0])), Buffer.from([0x12, 0x34]), ...(eoi ? [Buffer.from([0xff, 0xd9])] : []),
  ]);
}
