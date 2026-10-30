import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Every view names its browser tab (a sidebar tab strip shows about 20 characters), so "Vibrana GTM" never appears twice.
function pages(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? pages(p) : n === "page.tsx" ? [p] : [];
  });
}

test("every page sets its own tab title, leading with the view", () => {
  const bad = pages("app").filter((f) => {
    const src = readFileSync(f, "utf8");
    const own = /^export const metadata = \{ title: "[^"]{1,24}"/m.test(src) || /^export async function generateMetadata/m.test(src);
    if (f === join("app", "page.tsx")) return !own; // the root layout title is the fallback, not Today's
    const layout = join(f, "..", "layout.tsx");
    let inherited = false;
    try { inherited = /title: "[^"]{1,24}"/.test(readFileSync(layout, "utf8")); } catch { /* no layout */ }
    return !own && !inherited;
  });
  assert.deepEqual(bad, []);
});
