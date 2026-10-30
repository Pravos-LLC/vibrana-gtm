import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { hashingStream, LargeMedia, LARGE_MEDIA_BYTES, MAX_VIDEO_BYTES, resumableEndpoint, sha256File, tusUpload, webPlayableProblemsFile } from "../lib/large-media";
import { webPlayableProblems } from "../lib/video-playable";
import { checkStoryApprovalDb, digest, stageStory, type StoryAsset } from "../lib/story";
import { playPath } from "../lib/reviewer/shared";
import type { Calendar, Item } from "../lib/calendar";
import { mp4 } from "./support/mp4";

const scratch = (name: string) => mkdtempSync(join(tmpdir(), `gtm-large-${name}-`));

/** An in-memory Supabase resumable (TUS) endpoint: create, PATCH at the right offset, HEAD for the offset. */
function fakeTus() {
  const objects = new Map<string, Buffer>();
  const uploads = new Map<string, { name: string; length: number; parts: Buffer[]; offset: number }>();
  const calls: string[] = [];
  let failures = 0;
  let n = 0;
  const fetch: typeof globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const h = new Headers(init.headers);
    calls.push(`${method} ${url}`);
    if (method === "POST") {
      assert.equal(url, "http://tus.test/storage/v1/upload/resumable");
      assert.equal(h.get("tus-resumable"), "1.0.0");
      assert.equal(h.get("x-upsert"), "true");
      const meta = Object.fromEntries(h.get("upload-metadata")!.split(",").map((kv) => { const [k, v] = kv.split(" "); return [k, Buffer.from(v, "base64").toString()]; }));
      assert.equal(meta.bucketName, "content-review");
      const id = `u${++n}`;
      uploads.set(id, { name: meta.objectName, length: Number(h.get("upload-length")), parts: [], offset: 0 });
      return new Response(null, { status: 201, headers: { location: `/storage/v1/upload/resumable/${id}` } });
    }
    const u = uploads.get(url.split("/").pop()!)!;
    if (method === "HEAD") return new Response(null, { status: 200, headers: { "upload-offset": String(u.offset) } });
    if (failures > 0) { failures--; return new Response("upstream reset", { status: 502 }); }
    if (Number(h.get("upload-offset")) !== u.offset) return new Response("offset mismatch", { status: 409 });
    const body = Buffer.from(init.body as Uint8Array);
    u.parts.push(body);
    u.offset += body.length;
    if (u.offset === u.length) objects.set(u.name, Buffer.concat(u.parts));
    return new Response(null, { status: 204, headers: { "upload-offset": String(u.offset) } });
  }) as typeof globalThis.fetch;
  return { fetch, objects, calls, failNext(k = 1) { failures = k; } };
}

test("sha256File streams to the same digest as hashing the bytes in memory", () => {
  const dir = scratch("sha");
  try {
    const file = join(dir, "big.bin");
    const bytes = Buffer.alloc(20 * 1024 * 1024 + 123, 7);
    bytes.write("start", 0); bytes.write("end", bytes.length - 3);
    writeFileSync(file, bytes);
    assert.equal(sha256File(file), digest(bytes));
    assert.equal(sha256File(file, 1000), digest(bytes.subarray(0, 1000)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the file playability check agrees with the in-memory one and never needs the media data", () => {
  const dir = scratch("playable");
  try {
    for (const opts of [{}, { faststart: false }, { profile: 244 }, { codec: "hvc1" }]) {
      const file = join(dir, "v.mp4");
      writeFileSync(file, mp4(opts));
      assert.deepEqual(webPlayableProblemsFile(file), webPlayableProblems(mp4(opts)), JSON.stringify(opts));
    }
    // A big trailing box (a 60 MiB stand-in for an hour of mdat) is skipped by its header, not read.
    const file = join(dir, "padded.mp4");
    writeFileSync(file, mp4());
    const free = Buffer.alloc(8); free.writeUInt32BE(8 + 60 * 1024 * 1024); free.write("free", 4, "latin1");
    appendFileSync(file, free); appendFileSync(file, Buffer.alloc(60 * 1024 * 1024));
    assert.deepEqual(webPlayableProblemsFile(file), []);
    writeFileSync(join(dir, "junk.mp4"), "not a video");
    assert.match(webPlayableProblemsFile(join(dir, "junk.mp4")).join(), /no moov/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the resumable endpoint is the direct storage host for a hosted project", () => {
  assert.equal(resumableEndpoint("https://abcdefgh.supabase.co"), "https://abcdefgh.storage.supabase.co/storage/v1/upload/resumable");
  assert.equal(resumableEndpoint("http://127.0.0.1:56321"), "http://127.0.0.1:56321/storage/v1/upload/resumable");
});

test("tusUpload sends a file in chunks, resumes a failed chunk and returns the sha of what the server confirmed", async () => {
  const dir = scratch("tus");
  try {
    const file = join(dir, "master.mp4");
    const bytes = mp4({ payload: Buffer.from(Array.from({ length: 3400 }, (_, i) => 33 + (i % 90))).toString("latin1") });
    writeFileSync(file, bytes);
    const tus = fakeTus();
    tus.failNext(2);
    const seen: number[] = [];
    const r = await tusUpload({ url: "http://tus.test", key: "k", bucket: "content-review", object: "stories/s/a.mp4", file, contentType: "video/mp4", sha256: digest(bytes), chunkBytes: 1000, fetch: tus.fetch, sleep: async () => {}, onProgress: (s) => seen.push(s) });
    assert.equal(r.sha256, digest(bytes));
    assert.deepEqual(tus.objects.get("stories/s/a.mp4"), bytes);
    assert.deepEqual(seen, [1000, 2000, 3000, bytes.length]);
    assert.equal(tus.calls.filter((c) => c.startsWith("HEAD")).length, 2, "each failure resyncs the offset");
    // A file that no longer matches the planned sha is refused.
    await assert.rejects(tusUpload({ url: "http://tus.test", key: "k", bucket: "content-review", object: "stories/s/b.mp4", file, contentType: "video/mp4", sha256: "0".repeat(64), chunkBytes: 1000, fetch: fakeTus().fetch }), /changed while it was uploading/);
    // A plain refusal (413, 403) is not retried.
    const refused = (async (_i: RequestInfo | URL, init: RequestInit = {}) => init.method === "POST" ? new Response(null, { status: 201, headers: { location: "http://tus.test/x/1" } }) : new Response("too big", { status: 413 })) as typeof fetch;
    await assert.rejects(tusUpload({ url: "http://tus.test", key: "k", bucket: "content-review", object: "x", file, contentType: "video/mp4", chunkBytes: 1000, fetch: refused, sleep: async () => {} }), /failed: 413 too big/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("hashingStream hashes the bytes as they pass", async () => {
  const body = new Response("episode bytes").body!;
  const h = hashingStream(body);
  assert.throws(() => h.digest(), /not finished/);
  const out = Buffer.from(await new Response(h.stream).arrayBuffer());
  assert.equal(out.toString(), "episode bytes");
  assert.deepEqual(h.digest(), { sha256: digest("episode bytes"), bytes: 13 });
});

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

test("a video over 50 MiB stages with a streamed hash, a resumable master upload and a review proxy", { skip: !hasFfmpeg && "needs ffmpeg" }, async () => {
  const dir = scratch("stage");
  const env = { ws: process.env.GTM_WORKSPACE, url: process.env.NEXT_PUBLIC_SUPABASE_URL, key: process.env.SUPABASE_SECRET_KEY };
  const realFetch = globalThis.fetch;
  process.env.GTM_WORKSPACE = dir;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://tus.test";
  process.env.SUPABASE_SECRET_KEY = "test-key";
  try {
    // A real 2 s faststart H.264 clip, padded past 50 MiB with a trailing free box (valid MP4, ignored by players).
    const video = join(dir, "episode.mp4");
    const made = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25:duration=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
      "-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-movflags", "+faststart", video]);
    assert.equal(made.status, 0, made.stderr?.toString());
    const free = Buffer.alloc(8); free.writeUInt32BE(8 + LARGE_MEDIA_BYTES); free.write("free", 4, "latin1");
    appendFileSync(video, free); appendFileSync(video, Buffer.alloc(LARGE_MEDIA_BYTES));
    const size = statSync(video).size;
    assert.ok(size > LARGE_MEDIA_BYTES);
    const masterSha = sha256File(video);

    const manifest = join(dir, "story.yaml");
    writeFileSync(manifest, "id: zz-large\ntitle: Large\nlink: https://example.com/large\nassets:\n  - id: episode\n    title: Episode\n    kind: video\n    source: episode.mp4\n    channels: [youtube]\n");
    const cal: Calendar = { path: join(dir, "calendar.yaml"), timezone: "Europe/Berlin", accounts: {}, manual: [], items: [] };

    const dry = await stageStory(null, manifest, cal, true) as { assets: Array<{ sha256: string; bytes: number; large?: boolean }> };
    assert.equal(dry.assets[0].sha256, masterSha, "the streamed hash is the file's sha256");
    assert.equal(dry.assets[0].bytes, size);
    assert.equal(dry.assets[0].large, true, "the 50 MiB cap does not apply to a large final");

    const tus = fakeTus();
    globalThis.fetch = tus.fetch;
    const smallUploads: string[] = [];
    const smallObjects = new Map<string, Buffer>();
    let row: { sha256?: string; storage_path?: string; metadata?: Record<string, unknown> } | undefined;
    const ok = { data: [], error: null };
    const db = {
      from(table: string) {
        return {
          select() { return { in: () => Promise.resolve(ok), eq: () => Promise.resolve(ok) }; },
          upsert(r: typeof row) { if (table === "gtm_story_assets") row = r; return Promise.resolve({ data: null, error: null }); },
          insert(r: typeof row) { if (table === "gtm_story_assets") row = r; return Promise.resolve({ data: null, error: null }); },
        };
      },
      storage: { from() { return {
        upload(key: string, bytes: Buffer) { smallObjects.set(key, bytes); return Promise.resolve({ data: null, error: null }); },
        list() { return Promise.resolve({ data: [], error: null }); },
        remove() { return Promise.resolve({ data: null, error: null }); },
        createSignedUploadUrl() { return Promise.resolve({ data: { token: "t" }, error: null }); },
        uploadToSignedUrl(key: string) { smallUploads.push(key); return Promise.resolve({ data: null, error: null }); },
      }; } },
    } as unknown as SupabaseClient;
    await stageStory(db, manifest, cal);

    const masterKey = `stories/zz-large/episode-${masterSha.slice(0, 16)}.mp4`;
    const proxyKey = `stories/zz-large/episode-${masterSha.slice(0, 16)}-review-v2.mp4`;
    assert.equal(row!.sha256, masterSha, "the asset (and so its approval) binds to the master's sha256");
    assert.equal(row!.storage_path, masterKey);
    assert.equal(digest(tus.objects.get(masterKey)!), masterSha, "the master went up whole through the resumable endpoint");
    const proxy = smallObjects.get(proxyKey)!;
    assert.ok(proxy, "the review proxy went up beside it");
    assert.ok(proxy.length < size, "the proxy is smaller than the master");
    assert.deepEqual(webPlayableProblems(proxy), [], "the proxy plays in a browser");
    assert.equal(row!.metadata!.proxy_path, proxyKey);
    assert.equal(row!.metadata!.proxy_sha256, digest(proxy));
    assert.equal(row!.metadata!.proxy_bytes, proxy.length);
    assert.equal(row!.metadata!.bytes, size);
    assert.ok(!smallUploads.includes(masterKey), "the master never takes the single-request path");
    assert.ok(smallUploads.some((k) => k.endsWith("-poster.jpg")), "the poster frame still comes from the local file");
    assert.equal(playPath({ storage_path: masterKey, metadata: row!.metadata! }), proxyKey, "/content and /shared play the proxy");
    assert.equal(playPath({ storage_path: "stories/s/clip.mp4", metadata: {} }), "stories/s/clip.mp4");
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of [["GTM_WORKSPACE", env.ws], ["NEXT_PUBLIC_SUPABASE_URL", env.url], ["SUPABASE_SECRET_KEY", env.key]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the database publish gate never downloads a large master; it hands it on to be streamed and re-hashed", async () => {
  const sha = "a".repeat(64);
  const assets: StoryAsset[] = [
    { id: "copy", story_id: "ep", title: "Copy", kind: "copy", source: "copy.md", sha256: digest("Watch the episode"), revision: 1, storage_path: null, body: "Watch the episode", url: null, metadata: {} },
    { id: "episode", story_id: "ep", title: "Episode", kind: "video", source: "episode.mp4", sha256: sha, revision: 1, storage_path: "stories/ep/episode-aaaaaaaaaaaaaaaa.mp4", body: null, url: null, metadata: { bytes: 3e9, proxy_path: "stories/ep/episode-aaaaaaaaaaaaaaaa-proxy.mp4" }, stage: "final" },
  ];
  const approvals = assets.map((a) => ({ asset_id: a.id, channel: "youtube", status: "approved", approved_sha256: a.sha256, note: "" }));
  const query = (rows: unknown[]) => ({ select: () => ({ eq: () => ({ in: () => Promise.resolve({ data: rows, error: null }) }), in: () => Promise.resolve({ data: rows, error: null }) }) });
  const db = {
    from: (table: string) => query(table === "gtm_story_assets" ? assets : approvals),
    storage: { from: () => ({ download: () => { throw new Error("a large master must not be downloaded into memory"); } }) },
  } as unknown as SupabaseClient;
  const item = { id: "ep-youtube", story_id: "ep", channels: ["youtube"], story_assets: ["copy", "episode"], copy: "copy.md", media: ["stories/ep/episode-aaaaaaaaaaaaaaaa.mp4"] } as unknown as Item;
  const r = await checkStoryApprovalDb(db, item);
  const master = r.bytes.get("stories/ep/episode-aaaaaaaaaaaaaaaa.mp4");
  assert.ok(master instanceof LargeMedia);
  assert.equal(master.sha256, sha, "bound to the master's sha256, never the proxy's");
  assert.equal(master.size, 3e9);
  assert.equal(master.storageKey, "stories/ep/episode-aaaaaaaaaaaaaaaa.mp4");
  assert.equal(r.copyText, "Watch the episode");
  assets[1].metadata = { bytes: 8 * 1024 * 1024 };
  const short = (await checkStoryApprovalDb(db, item)).bytes.get(assets[1].storage_path!);
  assert.ok(short instanceof LargeMedia, "a short master also streams, even before its review proxy is backfilled");
  assert.equal(short.size, 8 * 1024 * 1024);
});

test("a large video is refused only above 5 GiB, and an image still at 50 MiB", async () => {
  const dir = scratch("caps");
  const prev = process.env.GTM_WORKSPACE;
  process.env.GTM_WORKSPACE = dir;
  try {
    const image = join(dir, "huge.png");
    writeFileSync(image, Buffer.alloc(0));
    appendFileSync(image, Buffer.alloc(LARGE_MEDIA_BYTES + 1));
    const manifest = join(dir, "story.yaml");
    writeFileSync(manifest, "id: caps\ntitle: Caps\nlink: https://example.com/caps\nassets:\n  - id: cover\n    title: Cover\n    kind: image\n    source: huge.png\n    channels: [youtube]\n");
    const cal: Calendar = { path: join(dir, "calendar.yaml"), timezone: "Europe/Berlin", accounts: {}, manual: [], items: [] };
    await assert.rejects(stageStory(null, manifest, cal, true), /image over 50 MiB/);
    // A sparse file reports its size without using the disk; the cap is checked before any hashing.
    const video = join(dir, "too-big.mp4");
    writeFileSync(video, "");
    truncateSync(video, MAX_VIDEO_BYTES + 1);
    writeFileSync(manifest, "id: caps\ntitle: Caps\nlink: https://example.com/caps\nassets:\n  - id: ep\n    title: Episode\n    kind: video\n    source: too-big.mp4\n    channels: [youtube]\n");
    await assert.rejects(stageStory(null, manifest, cal, true), /over the 5 GiB limit/);
  } finally {
    if (prev === undefined) delete process.env.GTM_WORKSPACE; else process.env.GTM_WORKSPACE = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
