import { test } from "node:test";
import assert from "node:assert/strict";
import { upstreamChangeIsRelevant } from "../scripts/migration-relevance.mjs";

const V = "supabase/migrations/20260901000000_gtm_tables.sql";
const vendored = [V];
const noFetch = (name: string): string => { throw new Error(`unexpected fetch of ${name}`); };
const body = (s: string) => () => s;

test("a pure rename of a vendored file (empty patch) is relevant, whatever its new name", () => {
  for (const filename of ["supabase/migrations/20260901000000_renamed.sql", "supabase/archive/old.sql", "docs/old.sql"]) {
    assert.equal(upstreamChangeIsRelevant({ filename, previous_filename: V, status: "renamed", patch: "" }, vendored, noFetch), true, filename);
    assert.equal(upstreamChangeIsRelevant({ filename, previous_filename: V, status: "renamed" }, vendored, noFetch), true, `${filename} (no patch key)`);
  }
});

test("a file renamed onto a vendored path is relevant", () => {
  assert.equal(upstreamChangeIsRelevant({ filename: V, previous_filename: "supabase/migrations/x.sql", status: "renamed", patch: "" }, vendored, noFetch), true);
});

test("a content-free rename of an unrelated SQL file is judged by its content, not its empty patch", () => {
  const f = { filename: "supabase/migrations/2_site.sql", previous_filename: "supabase/migrations/1_site.sql", status: "renamed", patch: "" };
  assert.equal(upstreamChangeIsRelevant(f, vendored, body("create table site_pages (id int);")), false);
  assert.equal(upstreamChangeIsRelevant(f, vendored, body("grant select on site_pages to anon;")), true);
});

test("modified, added and removed entries keep their existing rules", () => {
  assert.equal(upstreamChangeIsRelevant({ filename: V, status: "modified", patch: "-- whitespace" }, vendored, noFetch), true);
  assert.equal(upstreamChangeIsRelevant({ filename: V, status: "removed" }, vendored, noFetch), true);
  assert.equal(upstreamChangeIsRelevant({ filename: "supabase/migrations/9_site.sql", status: "added", patch: "+create table site_x();" }, vendored, noFetch), false);
  assert.equal(upstreamChangeIsRelevant({ filename: "supabase/migrations/9_site.sql", status: "added", patch: "+alter table gtm_posts add c int;" }, vendored, noFetch), true);
  assert.equal(upstreamChangeIsRelevant({ filename: "supabase/migrations/9_x.sql", status: "removed" }, vendored, noFetch), false);
  assert.equal(upstreamChangeIsRelevant({ filename: "app/page.tsx", status: "modified", patch: "gtm_" }, vendored, noFetch), false);
});
