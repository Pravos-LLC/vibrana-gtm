import { test } from "node:test";
import assert from "node:assert/strict";
import { boardSets, onBoard } from "../lib/season-board.ts";

test("the content board lists season pieces, claimed Stories and any Story with a post still to go", () => {
  const live = new Set(["sample-extra-45"]);
  assert.equal(onBoard({ id: "s1-99-sample-piece-99" }, live), true);
  assert.equal(onBoard({ id: "sample-extra-38", season_id: "season-1" }, live), true);
  assert.equal(onBoard({ id: "sample-extra-45", season_id: null }, live), true);
  assert.equal(onBoard({ id: "kb-tokenmaxxing", season_id: null }, live), false);
});

test("a failed live-calendar read throws instead of dropping every Signal Desk Story from the board (review #143)", async () => {
  const { createClient } = await import("@supabase/supabase-js");
  const { installFetchMock } = await import("./support/fetch-mock.ts");
  const { liveStoryIds } = await import("../lib/season-board.ts");
  const db = createClient("http://db.test", "test-key", { auth: { persistSession: false } });
  const failing = installFetchMock([{ url: "http://db.test/rest/v1/gtm_content_items", status: 500, json: { message: "upstream timeout" } }]);
  try { await assert.rejects(liveStoryIds(db), /live calendar items: upstream timeout/); } finally { failing.restore(); }
  const rows = Array.from({ length: 1203 }, (_, i) => ({ id: `i${i}`, story_id: i === 1202 ? "signal-late" : "s1-01" }));
  const ok = installFetchMock([{ url: "http://db.test/rest/v1/gtm_content_items", json: rows }]);
  try {
    const live = await liveStoryIds(db);
    assert.equal(live.has("signal-late"), true, "every page is read, past the server's row cap");
    const q = new URL(ok.calls[0].url).searchParams;
    assert.equal(q.get("status"), "not.in.(published,skipped)");
  } finally { ok.restore(); }
});

test("only a recorded kill leaves the board; skipped rows alone never hide a piece (review #151 N3)", () => {
  const rows = [
    { story_id: "s1-35-aios-build-1", status: "skipped" },
    { story_id: "s1-01-sample-piece-01", status: "published" }, { story_id: "s1-01-sample-piece-01", status: "skipped" },
    { story_id: "s1-02-sample-piece-02", status: "published" },
    { story_id: "s1-03-brain", status: "skipped" }, { story_id: "s1-03-brain", status: "scheduled" },
  ];
  // Killed s1-35 explicitly; s1-01's rows were skipped by a reconcile, which is not a kill.
  const { live, killed } = boardSets(rows, new Set(["s1-35-aios-build-1", "s1-03-brain"]));
  assert.deepEqual([...live], ["s1-03-brain"]);
  assert.deepEqual([...killed], ["s1-35-aios-build-1"], "a recorded kill with a live row again (restaged) is back on the board");
  assert.equal(onBoard({ id: "s1-35-aios-build-1" }, live, killed), false);
  assert.equal(onBoard({ id: "s1-01-sample-piece-01" }, live, killed), true);
  assert.equal(onBoard({ id: "s1-02-sample-piece-02" }, live, killed), true);
  assert.equal(onBoard({ id: "s1-03-brain" }, live, killed), true);
  assert.deepEqual([...boardSets(rows).killed], [], "no record, no kill");
});

test("a recorded kill with no calendar rows leaves the board (never scheduled), unless it is staged again", () => {
  assert.deepEqual([...boardSets([], new Set(["sd-never"])).killed], ["sd-never"]);
  assert.deepEqual([...boardSets([{ story_id: "sd-never", status: "scheduled" }], new Set(["sd-never"])).killed], []);
});

test("the kill record is read completely and fails loudly", async () => {
  const { createClient } = await import("@supabase/supabase-js");
  const { installFetchMock } = await import("./support/fetch-mock.ts");
  const { boardStoryIds } = await import("../lib/season-board.ts");
  const db = createClient("http://db.test", "test-key", { auth: { persistSession: false } });
  const ok = installFetchMock([
    { url: "http://db.test/rest/v1/gtm_sync_state", json: { value: { "s1-40-recorded": { at: "t" } } } },
    { url: "http://db.test/rest/v1/gtm_story_feedback", json: [{ id: "n1", asset_id: "s1-35-aios-build-1-linkedin" }] },
    { url: "http://db.test/rest/v1/gtm_story_asset_channels", json: [] },
    { url: "http://db.test/rest/v1/gtm_story_assets", json: [{ id: "s1-35-aios-build-1-linkedin", story_id: "s1-35-aios-build-1" }] },
    { url: "http://db.test/rest/v1/gtm_content_items", json: [{ id: "a", story_id: "s1-35-aios-build-1", status: "skipped" }, { id: "b", story_id: "s1-40-recorded", status: "skipped" }, { id: "c", story_id: "s1-01-sample-piece-01", status: "skipped" }] },
  ]);
  try {
    const { killed } = await boardStoryIds(db);
    assert.deepEqual([...killed].sort(), ["s1-35-aios-build-1", "s1-40-recorded"]);
  } finally { ok.restore(); }
  const failing = installFetchMock([{ url: "http://db.test/rest/v1/", status: 500, json: { message: "down" } }]);
  try { await assert.rejects(boardStoryIds(db), /down/); } finally { failing.restore(); }
});

test("a Story with a review still open is on the board before it has a calendar row (signal-pax-silica-aeta, 2026-11-17)", () => {
  // Approval is what makes the calendar row for a Story without a season, so the review has to be visible without one.
  const rows = [{ story_id: "signal-banked", status: "banked" }, { story_id: "signal-published", status: "published" }, { story_id: "signal-skipped", status: "skipped" }];
  const reviewing = new Set(["signal-staged", "s1-34-killed", "signal-banked", "signal-published", "signal-skipped"]);
  const { live, killed } = boardSets(rows, new Set(["s1-34-killed"]), reviewing);
  assert.equal(onBoard({ id: "signal-staged", season_id: null }, live, killed), true);
  assert.equal(onBoard({ id: "s1-34-killed" }, live, killed), false, "an open review never brings a killed piece back");
  for (const id of ["signal-banked", "signal-published", "signal-skipped"]) assert.equal(onBoard({ id, season_id: null }, live, killed), false, `${id}: its calendar row decides, not its leftover review`);
  assert.equal(onBoard({ id: "kb-tokenmaxxing", season_id: null }, live, killed), false, "no review, no row, no season: not listed");
});

test("open reviews are read completely, skip Stories the calendar decides, and a failed read throws", async () => {
  const { createClient } = await import("@supabase/supabase-js");
  const { installFetchMock } = await import("./support/fetch-mock.ts");
  const { boardStoryIds, reviewingStoryIds } = await import("../lib/season-board.ts");
  const db = createClient("http://db.test", "test-key", { auth: { persistSession: false } });
  const ok = installFetchMock([
    { url: "http://db.test/rest/v1/gtm_sync_state", json: { value: {} } },
    { url: "http://db.test/rest/v1/gtm_story_feedback", json: [] },
    { url: "http://db.test/rest/v1/gtm_content_items", json: [{ id: "x", story_id: "signal-banked", status: "banked" }] },
    { url: "http://db.test/rest/v1/gtm_story_asset_channels", times: 1, json: [
      { asset_id: "signal-staged-linkedin", channel: "linkedin", status: "pending", gtm_story_assets: { story_id: "signal-staged" } },
      { asset_id: "signal-banked-linkedin", channel: "linkedin", status: "pending", gtm_story_assets: { story_id: "signal-banked" } },
    ] },
    { url: "http://db.test/rest/v1/gtm_story_assets", json: [{ id: "signal-staged-linkedin", story_id: "signal-staged", kind: "copy", source: "linkedin.md", body: "Hi", metadata: {} }] },
    { url: "http://db.test/rest/v1/gtm_story_asset_channels", json: [{ asset_id: "signal-staged-linkedin", channel: "linkedin", status: "pending" }] },
  ]);
  try {
    const { live } = await boardStoryIds(db);
    assert.deepEqual([...live], ["signal-staged"], "the banked Story's leftover review does not list it");
    const first = new URL(ok.calls.find((c) => c.url.includes("gtm_story_asset_channels"))!.url).searchParams;
    assert.equal(first.get("status"), "in.(pending,rejected)");
    const assetRead = new URL(ok.calls.find((c) => new URL(c.url).pathname.endsWith("/gtm_story_assets"))!.url).searchParams;
    assert.equal(assetRead.get("story_id"), "in.(signal-staged)", "only undecided Stories are read in full");
  } finally { ok.restore(); }
  const failing = installFetchMock([{ url: "http://db.test/rest/v1/gtm_story_asset_channels", status: 500, json: { message: "reviews down" } }]);
  try { await assert.rejects(reviewingStoryIds(db), /open reviews: reviews down/); } finally { failing.restore(); }
});
