import test from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadContentBoard } from "../lib/content-board";
import { filterPieces, parseFilters } from "../lib/season-review";
import { reviewSummary } from "../lib/review-summary";
import { contentVisibility } from "../lib/content-visibility-db";

type Row = Record<string, any>;

/** Just enough Supabase for /content's reads: select with in/not/order, and a bucket that records what it signs. */
function fakeDb(tables: Record<string, Row[]>, beforeRead: (table: string) => Promise<void> = async () => {}) {
  const reads: Array<{ table: string; ids: unknown[] | null }> = [];
  const signed: string[] = [];
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    let ids: unknown[] | null = null;
    let slice: [number, number] | null = null;
    const chain: any = {
      select: () => chain,
      order: () => chain,
      eq: (col: string, val: unknown) => { filters.push((r) => r[col] === val); return chain; },
      is: (col: string, val: unknown) => { filters.push((r) => (r[col] ?? null) === val); return chain; },
      like: (col: string, pat: string) => { const re = new RegExp(`^${pat.replace(/%/g, ".*")}$`); filters.push((r) => re.test(String(r[col] ?? ""))); return chain; },
      maybeSingle: () => ({ then: (resolve: (v: unknown) => void) => resolve({ data: (tables[table] ?? []).filter((r) => filters.every((f) => f(r)))[0] ?? null, error: null }) }),
      in: (col: string, vals: unknown[]) => { if (col === "story_id" || col === "asset_id") ids = vals; filters.push((r) => vals.includes(r[col])); return chain; },
      not: (col: string, op: string, val: unknown) => {
        if (op === "is") filters.push((r) => r[col] != null);
        if (op === "in") { const out = String(val).replace(/[()]/g, "").split(","); filters.push((r) => !out.includes(r[col])); }
        return chain;
      },
      // Paged reads (lib/db-read.ts) ask for a range and an exact count, as PostgREST answers them.
      range: (from: number, to: number) => { slice = [from, to]; return chain; },
      then: async (resolve: (v: unknown) => void) => {
        await beforeRead(table);
        if (!slice || slice[0] === 0) reads.push({ table, ids });
        const rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
        resolve({ data: slice ? rows.slice(slice[0], slice[1] + 1) : rows, count: rows.length, error: null });
      },
    };
    return chain;
  };
  const storage = { from: () => ({ createSignedUrls: async (paths: string[]) => { signed.push(...paths); return { data: paths.map((path) => ({ path, signedUrl: `https://signed/${path}`, error: null })), error: null }; } }) };
  return { db: { from, storage } as unknown as SupabaseClient, reads, signed };
}

const story = (id: string) => ({ id, title: `W1 Tue Oct 20 | ${id}`, season_id: null, hold_who: null, hold_note: null, held_at: null, pipeline: null, series: null, third_party_who: null });
const asset = (id: string, story_id: string, kind: "copy" | "image") => ({
  id, story_id, kind, title: id, source: `${id}.${kind === "copy" ? "md" : "png"}`, sha256: "a".repeat(64), revision: 1, stage: null, metadata: {},
  storage_path: kind === "image" ? `stories/${story_id}/${id}.png` : null, body: kind === "copy" ? "Hello" : null, url: null,
});
const channel = (asset_id: string) => ({ asset_id, channel: "linkedin", status: "pending" });

function tables(): Record<string, Row[]> {
  return {
    gtm_stories: [story("s1-01-a"), story("s1-02-b")],
    gtm_story_assets: [asset("a-copy", "s1-01-a", "copy"), asset("a-img", "s1-01-a", "image"), asset("b-copy", "s1-02-b", "copy"), asset("b-img", "s1-02-b", "image")],
    gtm_story_asset_channels: ["a-copy", "a-img", "b-copy", "b-img"].map(channel),
    gtm_story_asset_versions: [{ asset_id: "b-img", revision: 1, label: "v1", sha256: "b".repeat(64), storage_path: "stories/s1-02-b/old.png", poster_path: null, body: null, created_at: "t", stage: null, changes: null, metadata: null }],
    gtm_content_items: [{ story_id: "s1-01-a", status: "scheduled", pillar: "proof", date: "2026-10-20" }, { story_id: "s1-02-b", status: "scheduled", pillar: "build", date: "2026-10-21" }],
  };
}

test("a one-piece link reads and signs only that piece; the piece list still names every story", async () => {
  const { db, reads, signed } = fakeDb(tables());
  const filters = parseFilters({ piece: "s1-01-a" });
  const board = await loadContentBoard(db, filters);
  assert.equal(board.error, null);
  if (board.error !== null) return;
  assert.deepEqual(signed, ["stories/s1-01-a/a-img.png"]);
  assert.deepEqual(reads.find((r) => r.table === "gtm_story_assets")?.ids, ["s1-01-a"]);
  assert.deepEqual(board.all.map((p) => p.storyId), ["s1-01-a"]);
  assert.deepEqual(board.pieceOptions.map((p) => p.id), ["s1-01-a", "s1-02-b"]);
  assert.deepEqual(filterPieces(board.directed, filters).map((p) => p.storyId), ["s1-01-a"]);
});

test("without a piece filter the whole board loads, versions included", async () => {
  const { db, signed } = fakeDb(tables());
  const board = await loadContentBoard(db, parseFilters({}));
  if (board.error !== null) throw new Error(board.error);
  assert.deepEqual(board.all.map((p) => p.storyId), ["s1-01-a", "s1-02-b"]);
  assert.deepEqual([...signed].sort(), ["stories/s1-01-a/a-img.png", "stories/s1-02-b/b-img.png", "stories/s1-02-b/old.png"]);
});

test("the Scheduled step follows delivered calendar legs, not approvals alone", async () => {
  const t = tables();
  const i = t.gtm_content_items[0];
  Object.assign(i, { channels: ["linkedin"], zernio_post_id: "real-post" });
  t.gtm_content_items.push({ story_id: i.story_id, status: "skipped", channels: ["instagram"] });
  assert.equal((await loadContentBoard(fakeDb(t).db, parseFilters({}))).all[0].scheduled, true);
  t.gtm_story_assets.push(asset("yt-copy", i.story_id, "copy"));
  t.gtm_story_asset_channels.push({ ...channel("yt-copy"), channel: "youtube" });
  assert.equal((await loadContentBoard(fakeDb(t).db, parseFilters({}))).all[0].scheduled, false, "a platform with no calendar leg is not scheduled");
  t.gtm_content_items.push({ story_id: i.story_id, status: "skipped", channels: ["youtube"] });
  assert.equal((await loadContentBoard(fakeDb(t).db, parseFilters({}))).all[0].scheduled, true, "an explicitly skipped platform is intentional");
  i.zernio_post_id = "pending";
  assert.equal((await loadContentBoard(fakeDb(t).db, parseFilters({}))).all[0].scheduled, false);
  i.status = "drafted";
  assert.equal((await loadContentBoard(fakeDb(t).db, parseFilters({}))).all[0].scheduled, false);
});

/** A piece with an approved LinkedIn post and a Substack essay (+ header) still pending, the essay published or not. */
function essayTables(published: boolean): Record<string, Row[]> {
  const essay = { ...asset("e-copy", "s1-01-a", "copy"), body: "![](e-img.png)", metadata: published ? { published_url: "https://sample_author.substack.com/p/x" } : {} };
  return {
    gtm_stories: [story("s1-01-a")],
    gtm_story_assets: [asset("li-copy", "s1-01-a", "copy"), essay, asset("e-img", "s1-01-a", "image")],
    gtm_story_asset_channels: [
      { asset_id: "li-copy", channel: "linkedin", status: "approved", approved_sha256: "a".repeat(64) },
      { asset_id: "e-copy", channel: "newsletter", status: "pending" },
      { asset_id: "e-img", channel: "newsletter", status: "pending" },
    ],
    gtm_content_items: [{ story_id: "s1-01-a", status: "scheduled", pillar: "proof", date: "2026-10-20" }],
  };
}

test("a published Substack essay has no card in /content, nothing awaiting on home, and no card in gtm story hidden", async () => {
  for (const published of [false, true]) {
    const board = await loadContentBoard(fakeDb(essayTables(published)).db, parseFilters({}));
    if (board.error !== null) throw new Error(board.error);
    assert.deepEqual(board.all[0].cards.map((c) => c.channel).sort(), published ? ["linkedin"] : ["linkedin", "newsletter"]);
    const summary = await reviewSummary(fakeDb(essayTables(published)).db);
    assert.equal(summary.awaiting, published ? 0 : 1, `home count, published=${published}`);
    const visibility = await contentVisibility(fakeDb(essayTables(published)).db);
    assert.equal(visibility.cards.listed, published ? 1 : 2, `gtm story hidden, published=${published}`);
  }
});

test("an unused header option does not hold a piece whose essay is published", async () => {
  const t = essayTables(true);
  t.gtm_story_assets.push(asset("alt-img", "s1-01-a", "image"));
  t.gtm_story_asset_channels.push({ asset_id: "alt-img", channel: "newsletter", status: "pending" });
  const board = await loadContentBoard(fakeDb(t).db, parseFilters({}));
  if (board.error !== null) throw new Error(board.error);
  assert.deepEqual(board.directed[0].cards.map((c) => c.channel), ["linkedin"]);
  const visibility = await contentVisibility(fakeDb(t).db);
  assert.deepEqual(visibility.hidden, []);
});


test("review reads begin while independent stage reads are still waiting", async () => {
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const reviewsStarted = new Promise<void>((r) => { started = r; });
  const { db } = fakeDb(tables(), async (table) => {
    if (table === "gtm_story_stages") await gate;
    if (table === "gtm_story_asset_channels") started();
  });
  const board = loadContentBoard(db, parseFilters({}));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([reviewsStarted, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("review reads waited for stages")), 1000); })]);
  } finally {
    clearTimeout(timer);
    release();
    await board;
  }
});

test("filtered approval queue signs only visible media; approved history stays accessible under All", async () => {
  const t = tables();
  for (const r of t.gtm_story_asset_channels.filter((r) => r.asset_id.startsWith("b-"))) {
    r.status = "approved"; r.approved_sha256 = "a".repeat(64);
  }
  const { db, signed } = fakeDb(t);
  const filters = parseFilters({ status: "needs-approval" });
  const board = await loadContentBoard(db, filters);
  assert.deepEqual(signed, ["stories/s1-01-a/a-img.png"]);
  assert.deepEqual(filterPieces(board.directed, filters).map((p) => p.storyId), ["s1-01-a"]);
  assert.equal(board.all.find((p) => p.storyId === "s1-02-b")!.cards[0].media[0].src, null);
  const all = await loadContentBoard(fakeDb(t).db, parseFilters({}));
  assert.ok(all.all.find((p) => p.storyId === "s1-02-b")!.cards[0].media[0].src?.startsWith("https://signed/"));
});

test("calendar publication survives missing or cleared essay metadata, without hiding another essay or social post", async () => {
  const t = essayTables(false);
  t.gtm_story_assets.push({ ...asset("other-essay", "s1-01-a", "copy"), body: "A different essay" });
  t.gtm_story_asset_channels.push({ asset_id: "other-essay", channel: "newsletter", status: "pending" });
  t.gtm_content_items.push({ id: "published-essay", story_id: "s1-01-a", status: "published", channels: ["newsletter"], story_assets: ["e-copy", "e-img"] });
  const board = await loadContentBoard(fakeDb(t).db, parseFilters({ status: "needs-approval" }));
  assert.deepEqual(board.all[0].cards.map((c) => c.copy.id), ["li-copy", "other-essay"]);
  assert.deepEqual(filterPieces(board.directed, parseFilters({ status: "needs-approval" }))[0].matched, ["newsletter:other-essay"]);
  assert.equal((await reviewSummary(fakeDb(t).db)).awaiting, 1);
  assert.equal((await contentVisibility(fakeDb(t).db)).cards.listed, 2);
  t.gtm_content_items.push({ id: "published-li", story_id: "s1-01-a", status: "published", channels: ["linkedin"], story_assets: ["li-copy"] });
  const after = await loadContentBoard(fakeDb(t).db, parseFilters({}));
  assert.deepEqual(after.all[0].cards.map((c) => c.copy.id), ["other-essay"]);
  assert.equal((await contentVisibility(fakeDb(t).db)).cards.listed, 1);
});
