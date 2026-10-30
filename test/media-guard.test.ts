import test from "node:test";
import assert from "node:assert/strict";
import { guardMediaBytes, guardVideoBytes, httpRangeReader, imageUploadProblems, isImage, isVideo, remoteImageProblems, remoteVideoProblems, UnloadableImageError, UnplayableVideoError } from "../lib/media-guard";
import { imageBytesProblems, imageProblems, MAX_IMAGE_BYTES } from "../lib/image-loadable";
import { webPlayableProblems, webPlayableProblemsRanged } from "../lib/video-playable";
import { storageKeyOf } from "../lib/media-url";
import { mp4 } from "./support/mp4";
import { jpeg, png } from "./support/image";

test("every upload helper's guard refuses a video that will not play and passes everything else through", () => {
  assert.doesNotThrow(() => guardMediaBytes(mp4(), "video/mp4", "clip.mp4"));
  assert.throws(() => guardMediaBytes(mp4({ profile: 244 }), "video/mp4", "clip02.mp4"), (e) => e instanceof UnplayableVideoError && /clip02\.mp4 will not play.*High 4:4:4.*Refused before upload/s.test(e.message));
  assert.throws(() => guardVideoBytes(mp4(), "video/quicktime", "clip.mov"), /\.mov is not an MP4/);
  assert.doesNotThrow(() => guardMediaBytes(Buffer.from("%PDF-1.7"), "application/pdf", "deck.pdf"), "a PDF is not media this gate checks");
  assert.doesNotThrow(() => guardMediaBytes(Buffer.from("copy"), "text/markdown", "copy.md"));
});

test("audio must be AAC: Opus or AC-3 in an MP4 does not play everywhere", () => {
  const box = (type: string, ...parts: Buffer[]) => { const body = Buffer.concat(parts); const h = Buffer.alloc(8); h.writeUInt32BE(body.length + 8); h.write(type, 4, "latin1"); return Buffer.concat([h, body]); };
  const audioTrak = (codec: string) => box("trak", box("mdia", box("hdlr", Buffer.alloc(8), Buffer.from("soun", "latin1"), Buffer.alloc(12)), box("minf", box("stbl", box("stsd", Buffer.alloc(8), box(codec, Buffer.alloc(28)))))));
  const withAudio = (codec: string) => {
    const v = mp4();
    const moovAt = v.indexOf("moov") - 4;
    const moovLen = v.readUInt32BE(moovAt);
    const trak = audioTrak(codec);
    const moov = Buffer.concat([v.subarray(moovAt, moovAt + moovLen), trak]);
    moov.writeUInt32BE(moovLen + trak.length, 0);
    return Buffer.concat([v.subarray(0, moovAt), moov, v.subarray(moovAt + moovLen)]);
  };
  assert.deepEqual(webPlayableProblems(withAudio("mp4a")), []);
  assert.match(webPlayableProblems(withAudio("Opus")).join(), /audio codec is Opus, not AAC/);
});

test("images: a real PNG or JPEG passes; empty, truncated, CMYK, HEIC, mislabelled or oversized ones are refused", () => {
  assert.deepEqual(imageBytesProblems(png(), "image/png"), []);
  assert.deepEqual(imageBytesProblems(jpeg(), "image/jpeg"), []);
  assert.match(imageBytesProblems(Buffer.alloc(0), "image/png").join(), /empty/);
  assert.match(imageBytesProblems(png().subarray(0, 40), "image/png").join(), /truncated \(no IEND/);
  assert.match(imageBytesProblems(jpeg({ eoi: false }), "image/jpeg").join(), /truncated \(no end-of-image/);
  assert.match(imageBytesProblems(jpeg({ components: 4 }), "image/jpeg").join(), /CMYK, not RGB/);
  assert.match(imageBytesProblems(png(), "image/jpeg").join(), /stored as image\/jpeg but the bytes are PNG/);
  const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic", "latin1"), Buffer.alloc(16)]);
  assert.match(imageBytesProblems(heic, "image/heic").join(), /HEIC; only JPEG, PNG and WebP/);
  // A 429 body served where an image was expected is not an image.
  assert.match(imageBytesProblems(Buffer.from('{"error":"too_many_connections","code":"SlowDown"}'), "image/png").join(), /not an image/);
  const big = imageProblems(png().subarray(0, 64), MAX_IMAGE_BYTES + 1, png().subarray(-32), "image/png");
  assert.match(big.problems.join(), /over the 5 MB image limit/);
  assert.equal(imageProblems(png({ w: 360, h: 640 }), png({ w: 360, h: 640 }).length).width, 360);
  assert.throws(() => guardMediaBytes(png(), "image/jpeg", "slide-04.png"), (e) => e instanceof UnloadableImageError && /slide-04\.png will not load/.test(e.message));
  assert.ok(isImage(null, "a/b.webp") && isVideo("video/mp4") && !isImage("application/pdf", "x.pdf"));
  assert.deepEqual(imageUploadProblems(Buffer.from("x"), "application/pdf", "x.pdf"), []);
});

test("the ranged probe reads only headers: a non-faststart 4:4:4 file is found from a few small range reads", async () => {
  const file = mp4({ profile: 244, faststart: false, payload: "x".repeat(400_000) });
  const reads: Array<[number, number]> = [];
  const problems = await webPlayableProblemsRanged(async (s, e) => { reads.push([s, e]); return file.subarray(s, e); }, file.length, 1024);
  assert.match(problems.join(), /not faststart.*High 4:4:4/s);
  assert.ok(reads.reduce((n, [s, e]) => n + (e - s), 0) < 4096, "never the media data");
});

test("remote probes go through HTTP ranges and wait out a 429 from Storage", async () => {
  const file = mp4();
  let busy = 2;
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    if (busy-- > 0) return new Response('{"error":"too_many_connections"}', { status: 429, headers: { "retry-after": "0" } });
    const m = String(new Headers(init?.headers).get("range")).match(/bytes=(\d+)-(\d+)/)!;
    const s = Number(m[1]), e = Math.min(Number(m[2]) + 1, file.length);
    return new Response(new Uint8Array(file.subarray(s, e)), { status: 206, headers: { "content-range": `bytes ${s}-${e - 1}/${file.length}` } });
  }) as typeof fetch;
  assert.deepEqual(await remoteVideoProblems("https://cdn.test/v.mp4", "v.mp4", fetchImpl), []);
  const img = png();
  const imgFetch = (async (_u: string, init?: RequestInit) => {
    const m = String(new Headers(init?.headers).get("range")).match(/bytes=(\d+)-(\d+)/)!;
    return new Response(new Uint8Array(img.subarray(Number(m[1]), Number(m[2]) + 1)), { status: 206 });
  }) as typeof fetch;
  assert.deepEqual(await remoteImageProblems(httpRangeReader("https://x.test/a.png", imgFetch), img.length, "image/png"), []);
  assert.match((await remoteImageProblems(httpRangeReader("https://x.test/a.png", imgFetch), img.length, "image/webp")).join(), /stored as image\/webp/);
});

test("a stored object's key is read back from its signed URL", () => {
  assert.equal(storageKeyOf("https://p.supabase.co/storage/v1/object/sign/content-review/stories/s1/a%20b.png?token=x"), "stories/s1/a b.png");
  assert.equal(storageKeyOf("https://p.supabase.co/storage/v1/object/sign/other/x.png?token=x"), null);
  assert.equal(storageKeyOf("https://media.zernio.com/x.mp4"), null);
});

test("images: a phone JPEG with a trailer after EOI loads; image/jpg is JPEG; 5 MB applies only to what goes out", () => {
  const trailer = Buffer.concat([jpeg(), Buffer.alloc(4096, 7)]);
  assert.deepEqual(imageBytesProblems(trailer, "image/jpeg"), []);
  assert.deepEqual(imageBytesProblems(jpeg(), "image/jpg"), []);
  const big = (max?: number) => imageProblems(png().subarray(0, 64), 6_000_000, png().subarray(-64), "image/png", max).problems.join();
  assert.match(big(), /over the 5 MB image limit/);
  assert.equal(big(25_000_000), "", "a 6 MB storyboard frame is fine in the cockpit");
  assert.doesNotThrow(() => guardMediaBytes(png(), "image/png", "frame.png"));
});

test("a Motion Photo (a JPEG with an MP4 after its EOI) loads, with or without the XMP that names it", () => {
  const box = (type: string, n: number) => { const b = Buffer.alloc(n); b.writeUInt32BE(n); b.write(type, 4, "latin1"); return b; };
  const trailer = Buffer.concat([box("ftyp", 24), box("mdat", 200_000)]);
  assert.deepEqual(imageBytesProblems(Buffer.concat([jpeg(), trailer]), "image/jpeg"), []);
  assert.deepEqual(imageBytesProblems(Buffer.concat([jpeg({ note: "GCamera:MotionPhoto=1 Container:Directory" }), Buffer.alloc(300_000, 9)]), "image/jpeg"), []);
  assert.match(imageBytesProblems(Buffer.concat([jpeg({ eoi: false }), Buffer.alloc(300_000, 9)]), "image/jpeg").join(), /truncated/, "a cut-off plain JPEG is still caught");
});
