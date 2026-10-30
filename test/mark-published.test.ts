import test from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { markEssayPublished, parsePublishedUrl } from "../lib/mark-published";

type Row = Record<string, any>;

/** Just enough Supabase for markEssayPublished: filtered select / maybeSingle, and an update that reports the rows it matched. */
function fakeDb(tables: Record<string, Row[]>) {
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    let patch: Row | null = null;
    const matched = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
    const chain: any = {
      select: () => chain,
      update: (p: Row) => { patch = p; return chain; },
      // metadata is a jsonb column: PostgREST compares it as the JSON text the caller sends.
      eq: (col: string, val: unknown) => { filters.push((r) => (col === "metadata" ? JSON.stringify(r[col]) === val : r[col] === val)); return chain; },
      maybeSingle: () => Promise.resolve({ data: matched()[0] ? structuredClone(matched()[0]) : null, error: null }),
      then: (resolve: (v: unknown) => void) => {
        const rows = matched();
        if (patch) for (const r of rows) Object.assign(r, patch);
        resolve({ data: rows, error: null });
      },
    };
    return chain;
  };
  return { from } as unknown as SupabaseClient;
}

const tables = (metadata: Row = {}): Record<string, Row[]> => ({
  gtm_story_assets: [
    { id: "essay", story_id: "s", kind: "copy", sha256: "a", metadata },
    { id: "post", story_id: "s", kind: "copy", sha256: "b", metadata: {} },
    { id: "img", story_id: "s", kind: "image", sha256: "c", metadata: {} },
  ],
  gtm_story_asset_channels: [{ asset_id: "essay", channel: "newsletter" }, { asset_id: "post", channel: "linkedin" }, { asset_id: "img", channel: "newsletter" }],
});

const URL_A = "https://sample_author.substack.com/p/a";

test("the live link must be an https URL with a host", () => {
  assert.equal(parsePublishedUrl(`  ${URL_A}\n`), URL_A);
  assert.equal(parsePublishedUrl("https://sample_author.Substack.com/p/A"), "https://sample_author.substack.com/p/A", "the host is normalized, the path is not");
  for (const bad of ["", "not a link", "http://sample_author.substack.com/p/a", "https://", "https://nowhere", "javascript:alert(1)"]) assert.throws(() => parsePublishedUrl(bad), /full https link/, bad);
});

test("marking an essay writes the URL and keeps its other metadata", async () => {
  const t = tables({ edited_in_dashboard: "x" });
  const r = await markEssayPublished(fakeDb(t), "s", "essay", URL_A);
  assert.deepEqual([r.asset, r.url, r.replaced], ["essay", URL_A, null]);
  const meta = t.gtm_story_assets[0].metadata;
  assert.equal(meta.published_url, URL_A);
  assert.equal(meta.edited_in_dashboard, "x");
  assert.match(meta.published_at, /^\d{4}-\d{2}-\d{2}T/);
});

test("a dry run writes nothing", async () => {
  const t = tables();
  await markEssayPublished(fakeDb(t), "s", "essay", URL_A, { dryRun: true });
  assert.equal(t.gtm_story_assets[0].metadata.published_url, undefined);
});

test("only a newsletter copy asset of that Story can be marked", async () => {
  const t = tables();
  await assert.rejects(markEssayPublished(fakeDb(t), "s", "post", URL_A), /not a newsletter essay/);
  await assert.rejects(markEssayPublished(fakeDb(t), "s", "img", URL_A), /not a copy asset/);
  await assert.rejects(markEssayPublished(fakeDb(t), "other", "essay", URL_A), /not a copy asset/);
  assert.equal(t.gtm_story_assets[0].metadata.published_url, undefined);
});

test("a different URL replaces the old one only with force; the same URL is a no-op replace", async () => {
  const t = tables({ published_url: URL_A });
  await assert.rejects(markEssayPublished(fakeDb(t), "s", "essay", "https://sample_author.substack.com/p/b"), /already marked published at/);
  assert.equal(t.gtm_story_assets[0].metadata.published_url, URL_A);
  const r = await markEssayPublished(fakeDb(t), "s", "essay", "https://sample_author.substack.com/p/b", { force: true });
  assert.equal(r.replaced, URL_A);
  assert.equal(t.gtm_story_assets[0].metadata.published_url, "https://sample_author.substack.com/p/b");
  assert.equal((await markEssayPublished(fakeDb(t), "s", "essay", "https://sample_author.substack.com/p/b")).replaced, null);
});

test("an edit between the read and the write (a new sha256) writes nothing", async () => {
  const t = tables();
  const db = fakeDb(t);
  const real = (db as any).from;
  (db as any).from = (table: string) => {
    const chain = real(table);
    const update = chain.update;
    chain.update = (p: Row) => { t.gtm_story_assets[0].sha256 = "edited"; return update(p); };
    return chain;
  };
  await assert.rejects(markEssayPublished(db, "s", "essay", URL_A), /changed while it was being marked/);
});

test("a metadata change between the read and the write (a restage of the same bytes) writes nothing", async () => {
  const t = tables({ label: "old" });
  const db = fakeDb(t);
  const real = (db as any).from;
  (db as any).from = (table: string) => {
    const chain = real(table);
    const update = chain.update;
    chain.update = (p: Row) => { t.gtm_story_assets[0].metadata = { label: "restaged" }; return update(p); };
    return chain;
  };
  await assert.rejects(markEssayPublished(db, "s", "essay", URL_A), /changed while it was being marked/);
  assert.equal(t.gtm_story_assets[0].metadata.published_url, undefined);
});
