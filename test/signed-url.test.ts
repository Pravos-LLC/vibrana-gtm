import { test } from "node:test";
import assert from "node:assert/strict";
import { keepSignedUrl, signedUrlExpiry } from "../lib/signed-url.ts";

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const signed = (path: string, iat: number, exp: number) =>
  `https://x.supabase.co/storage/v1/object/sign/gtm-content/${path}?token=${b64({ alg: "HS256" })}.${b64({ url: path, iat, exp })}.sig`;
const now = 1_800_000_000;

test("signedUrlExpiry reads the token's exp", () => {
  assert.equal(signedUrlExpiry(signed("a.mp4", now, now + 3600)), now + 3600);
  assert.equal(signedUrlExpiry("https://x/a.mp4"), null);
});

test("a re-signed URL for the same object keeps the one the player has", () => {
  const first = signed("a.mp4", now, now + 6 * 3600);
  const again = signed("a.mp4", now + 60, now + 60 + 6 * 3600);
  assert.notEqual(first, again);
  assert.equal(keepSignedUrl(first, again, now + 60), first);
});

test("a different object or version takes the new URL", () => {
  assert.equal(keepSignedUrl(signed("a.mp4", now, now + 3600), signed("b.mp4", now, now + 3600), now), signed("b.mp4", now, now + 3600));
  assert.equal(keepSignedUrl(signed("a.mp4", now, now + 3600), null, now), null);
  assert.equal(keepSignedUrl(null, signed("a.mp4", now, now + 3600), now), signed("a.mp4", now, now + 3600));
});

test("a signature about to lapse takes the fresh one", () => {
  const old = signed("a.mp4", now, now + 300);
  const fresh = signed("a.mp4", now + 200, now + 200 + 6 * 3600);
  assert.equal(keepSignedUrl(old, fresh, now + 200), fresh);
});
