import { test } from "node:test";
import assert from "node:assert/strict";
import { publicMediaConfig, publicUrlOf, publishStoryMedia, referencedImages } from "../lib/public-media.ts";
import { digest, type StoryAsset } from "../lib/story.ts";
import { jpeg } from "./support/image";

const bytes: Buffer<ArrayBuffer> = Buffer.from(jpeg({ note: "jpeg-bytes" }));
const sha = digest(bytes);
const asset = (id: string, kind: StoryAsset["kind"], extra: Partial<StoryAsset> = {}): StoryAsset => ({
  id, story_id: "s", title: id, kind, source: `assets/${id}.jpg`, sha256: sha, revision: 1,
  storage_path: kind === "image" ? `stories/s/${id}-${sha.slice(0, 16)}.jpg` : null, body: null, url: null, metadata: {}, ...extra,
});
const config = { accountId: "acct", token: "tok", bucket: "pub-bucket", baseUrl: "https://pub.test" };

function fakeDb(assets: StoryAsset[], stored = bytes) {
  const updates: unknown[] = [];
  const db = {
    from: () => ({
      select: () => ({ eq: async () => ({ data: assets, error: null }) }),
      update: (patch: unknown) => ({ eq: () => ({ eq: async () => { updates.push(patch); return { data: null, error: null }; } }) }),
    }),
    storage: { from: () => ({ download: async () => ({ data: new Blob([stored]), error: null }) }) },
  };
  return { db: db as never, updates };
}

test("referencedImages picks only images named in the Story's copy", () => {
  const assets = [asset("a", "image"), asset("b", "image"), asset("c", "copy", { body: "![x](assets/a.jpg)", source: "c.md" })];
  assert.deepEqual(referencedImages(assets).map((a) => a.id), ["a"]);
});

test("publicUrlOf trusts a recorded URL only for the current bytes", () => {
  assert.equal(publicUrlOf(asset("a", "image", { metadata: { public_url: "https://pub.test/x", public_sha256: sha } })), "https://pub.test/x");
  assert.equal(publicUrlOf(asset("a", "image", { metadata: { public_url: "https://pub.test/x", public_sha256: "0".repeat(64) } })), null);
  assert.equal(publicUrlOf(asset("a", "image")), null);
});

test("publicMediaConfig names every missing variable and requires https", () => {
  assert.throws(() => publicMediaConfig({}), /CLOUDFLARE_ACCOUNT_ID.*GTM_PUBLIC_MEDIA_BUCKET.*GTM_PUBLIC_MEDIA_BASE_URL/);
  assert.throws(() => publicMediaConfig({ CLOUDFLARE_ACCOUNT_ID: "a", CLOUDFLARE_API_TOKEN: "t", GTM_PUBLIC_MEDIA_BUCKET: "b", GTM_PUBLIC_MEDIA_BASE_URL: "http://x" }), /https/);
});

test("publish uploads, verifies the public bytes, then records the URL", async (t) => {
  const assets = [asset("a", "image"), asset("c", "copy", { body: "![x](assets/a.jpg)", source: "c.md" })];
  const { db, updates } = fakeDb(assets);
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (init?.method === "PUT") return new Response("{}", { status: 200 });
    return new Response(bytes, { status: 200, headers: { "content-type": "image/jpeg" } });
  });
  const result = await publishStoryMedia(db, "s", { config });
  const key = `stories/s/a-${sha.slice(0, 16)}.jpg`;
  assert.deepEqual(calls, [`PUT https://api.cloudflare.com/client/v4/accounts/acct/r2/buckets/pub-bucket/objects/${key}`, `GET https://pub.test/${key}`]);
  assert.deepEqual(result.images, [{ id: "a", url: `https://pub.test/${key}`, bytes: bytes.length, contentType: "image/jpeg" }]);
  assert.equal((updates[0] as { metadata: Record<string, unknown> }).metadata.public_url, `https://pub.test/${key}`);
});

test("publish refuses tampered storage bytes and a public URL serving different bytes", async (t) => {
  const assets = [asset("a", "image")];
  await assert.rejects(publishStoryMedia(fakeDb(assets, Buffer.from("other")).db, "s", { assetIds: ["a"], config }), /do not match/);
  t.mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => new Response(init?.method === "PUT" ? "{}" : "stale", { status: 200 }));
  const { db, updates } = fakeDb(assets);
  await assert.rejects(publishStoryMedia(db, "s", { assetIds: ["a"], config }), /did not serve the uploaded bytes/);
  assert.equal(updates.length, 0, "nothing recorded when verification fails");
  await assert.rejects(publishStoryMedia(db, "s", { assetIds: ["zzz"], config }), /not in Story s: zzz/);
});
