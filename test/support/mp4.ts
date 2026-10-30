// Minimal MP4 byte layouts for the playable-video gate: only the boxes the gate reads.
const box = (type: string, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length + 8); head.write(type, 4, "latin1");
  return Buffer.concat([head, body]);
};

export function mp4({ profile = 100, codec = "avc1", faststart = true, payload = "frames" }: { profile?: number; codec?: string; faststart?: boolean; payload?: string } = {}) {
  const hdlr = box("hdlr", Buffer.alloc(8), Buffer.from("vide", "latin1"), Buffer.alloc(12));
  const avcC = box("avcC", Buffer.from([1, profile, 0, 40, 0xff, 0xe0, 0]));
  const entry = box(codec, Buffer.alloc(78), codec.startsWith("avc") ? avcC : Buffer.alloc(0));
  const stsd = box("stsd", Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]), entry);
  const moov = box("moov", box("trak", box("mdia", hdlr, box("minf", box("stbl", stsd)))));
  const ftyp = box("ftyp", Buffer.from("isom\0\0\x02\0isom", "latin1"));
  const mdat = box("mdat", Buffer.from(payload));
  return faststart ? Buffer.concat([ftyp, moov, mdat]) : Buffer.concat([ftyp, mdat, moov]);
}
