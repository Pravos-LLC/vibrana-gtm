import test from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";

process.env.ZERNIO_API_URL = "https://zernio.test/api/v1";
process.env.ZERNIO_API_KEY = "zk_test";
const { sendLarge } = await import("../lib/publish-item");
const { LargeMedia } = await import("../lib/large-media");
const { digest } = await import("../lib/story");

const { mp4 } = await import("./support/mp4");
const master = mp4({ payload: "an hour of episode bytes" });

/** Storage signs the master, the signed URL streams it, Zernio presigns and takes the PUT. */
function wire(stored: Buffer) {
  const put: Buffer[] = [];
  const headers: Record<string, string>[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (url === "https://storage.test/signed/master") return new Response(new Uint8Array(stored));
    if (url.endsWith("/media/presign")) return Response.json({ uploadUrl: "https://r2.test/put", publicUrl: "https://media.zernio.test/episode.mp4" });
    if (url === "https://r2.test/put") {
      headers.push(Object.fromEntries(new Headers(init.headers)));
      put.push(Buffer.from(await new Response(init.body as ReadableStream).arrayBuffer()));
      return new Response(null, { status: 200 });
    }
    throw new Error(`unmocked ${url}`);
  }) as typeof fetch;
  const db = { storage: { from: () => ({ createSignedUrl: () => Promise.resolve({ data: { signedUrl: "https://storage.test/signed/master" }, error: null }) }) } } as unknown as SupabaseClient;
  return { put, headers, db, restore: () => { globalThis.fetch = real; } };
}

test("a large stored master streams to Zernio and is re-hashed against its approved sha256 on the way", async () => {
  const w = wire(master);
  try {
    const url = await sendLarge(new LargeMedia("stories/ep/m.mp4", master.length, digest(master), "stories/ep/m.mp4"), "m.mp4", "video/mp4", w.db);
    assert.equal(url, "https://media.zernio.test/episode.mp4");
    assert.deepEqual(w.put[0], master);
    assert.equal(w.headers[0]["content-length"], String(master.length), "the presigned PUT carries the exact length");
  } finally { w.restore(); }
});

test("stored bytes that differ from the approved digest stop the send before any post exists", async () => {
  const w = wire(mp4({ payload: "an hour of EPISODE bytes" }));
  try {
    await assert.rejects(sendLarge(new LargeMedia("stories/ep/m.mp4", master.length, digest(master), "stories/ep/m.mp4"), "m.mp4", "video/mp4", w.db), /do not match the approved digest/);
  } finally { w.restore(); }
});

test("a stored master that will not play is refused from its header, before Zernio is asked for anything", async () => {
  const w = wire(mp4({ profile: 244, payload: "an hour of episode bytes" }));
  try {
    const bad = mp4({ profile: 244, payload: "an hour of episode bytes" });
    await assert.rejects(sendLarge(new LargeMedia("stories/ep/m.mp4", bad.length, digest(bad), "stories/ep/m.mp4"), "m.mp4", "video/mp4", w.db), /m\.mp4 will not play in a browser: H\.264 profile is High 4:4:4/);
    assert.equal(w.put.length, 0, "nothing was sent");
  } finally { w.restore(); }
});
