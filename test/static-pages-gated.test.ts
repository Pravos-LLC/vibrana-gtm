// Files under public/ are served by Next.js but still pass through proxy.ts. This pins that any one-off static page or audio file
// put there (e.g. a review page at public/<name>/review.html) are inside the proxy matcher and are not a public path, so a signed-out visitor is sent to /login.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { publicPath } from "../lib/reviewer/access";

const src = readFileSync(join(import.meta.dirname, "..", "proxy.ts"), "utf8");
const matcher = new RegExp("^" + /matcher:\s*\["([^"]+)"\]/.exec(src)![1].replace(/\\\\/g, "\\") + "$");

for (const p of ["/one-off/review.html", "/one-off/audio/sample.mp3"]) {
  test(`proxy gates ${p}`, () => {
    assert.ok(matcher.test(p), "inside the proxy matcher");
    assert.equal(publicPath(p), false, "not a public path");
  });
}
