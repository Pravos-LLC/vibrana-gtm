import { test } from "node:test";
import assert from "node:assert/strict";
import { readPages, readChunks } from "../lib/db-read.ts";
import { displayReviews } from "../lib/review-display.ts";
import { encodeFixNote } from "../lib/approve-note.ts";
import { partUi, matchesStatus } from "../lib/season-review.ts";
import { deliveryState } from "../lib/delivery-report.ts";
test("a later failed page throws instead of returning an incomplete approval queue", async () => {
  await assert.rejects(readPages(async (from) => from === 0 ? { data: Array.from({ length: 500 }, (_, id) => ({ id })), error: null } : { data: null, error: { message: "failed" } }, "approvals"), /approvals: failed/);
});
test("reads every page and bounds filter URLs, deduplicating ids", async () => {
  const ids = Array.from({ length: 121 }, (_, i) => String(i));
  const calls: number[] = [];
  const rows = await readChunks([...ids, "0"], async (chunk, from) => { calls.push(chunk.length); return { data: chunk.map((id) => ({ id })).slice(from), error: null, count: chunk.length }; }, "test");
  assert.deepEqual(rows.map((r) => r.id), ids); assert.deepEqual(calls.sort((a, b) => b - a), [50, 50, 21]);
  const full = await readPages(async (from, to) => ({ data: Array.from({ length: 1201 }, (_, i) => i).slice(from, to + 1), error: null }), "all");
  assert.equal(full.length, 1201);
});
test("a server row cap below the page size is paged through, never read as the end of the table", async () => {
  const table = Array.from({ length: 1201 }, (_, i) => ({ id: i }));
  const cap = 200; // PostgREST max_rows lowered below the 500-row page
  const capped = (counted: boolean) => async (from: number, to: number) => ({ data: table.slice(from, Math.min(to + 1, from + cap)), error: null, count: counted ? table.length : null });
  assert.deepEqual((await readPages(capped(true), "counted")).map((r) => r.id), table.map((r) => r.id));
  assert.deepEqual((await readPages(capped(false), "uncounted")).map((r) => r.id), table.map((r) => r.id));
  // Pages that run dry before the count are an incomplete read, not a short table.
  await assert.rejects(readPages(async (from) => ({ data: from ? [] : table.slice(0, 10), error: null, count: 50 }), "approvals"), /approvals: read 10 of 50 rows/);
  // With a count, a small table is one request.
  let n = 0;
  await readPages(async () => { n++; return { data: table.slice(0, 3), error: null, count: 3 }; }, "small");
  assert.equal(n, 1);
});
test("chunks are read in parallel, at most four at a time, in order", async () => {
  let live = 0, peak = 0;
  const ids = Array.from({ length: 500 }, (_, i) => String(i));
  const rows = await readChunks(ids, async (chunk) => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 5)); live--; return { data: chunk.map((id) => ({ id })), error: null, count: chunk.length }; }, "par");
  assert.deepEqual(rows.map((r) => r.id), ids);
  assert.equal(peak, 4);
});
test("an accepted note never makes a pending decision look approved; waiting for fix survives reload", () => {
  const note = { id: "n", asset_id: "v", channel: null, revision: 1, created_at: "2030-01-01", resolved_at: null, resolution: "", body: encodeFixNote({ part: "media", assets: ["v"], channels: ["youtube"] }, "Shorten opening") };
  const rows = [{ asset_id: "v", channel: "youtube", status: "approved" as const, approved_sha256: "sha", note: "" }];
  assert.equal(displayReviews([{ id: "v", sha256: "sha" }], rows, [note])[0].status, "pending");
  assert.equal(partUi("pending", undefined, [note]), "fixing");
  assert.equal(matchesStatus({ text: "approved", asset: "fixing" }, "approved"), false);
  assert.equal(matchesStatus({ text: "approved", asset: "fixing" }, "waiting-fix"), true);
  assert.equal(displayReviews([{ id: "v", sha256: "new" }], rows, [])[0].status, "pending");
});
test("partial delivery is tracked per channel, while an unavailable provider remains unverified", () => {
  const item = { id: "p", story_id: "s", title: "Piece", channels: ["linkedin", "youtube"], status: "scheduled", date: "2030-01-01", zernio_post_id: "z", urls: {} };
  const post = { _id: "z", status: "partial", platforms: [{ platform: "linkedin", accountId: "a", status: "published", platformPostUrl: "https://example.com/post" }, { platform: "youtube", accountId: "b", status: "failed", errorMessage: "Reconnect account" }] };
  assert.equal(deliveryState(item, "linkedin", post).state, "published");
  assert.equal(deliveryState(item, "youtube", post).state, "failed");
  assert.equal(deliveryState(item, "linkedin").verified, false);
  assert.equal(deliveryState({ ...item, zernio_post_id: "pending" }, "linkedin").state, "unverified");
});

test("direct publishing applies the same accepted-note hold as autoscheduling before any provider write", async () => {
  const { createClient } = await import("@supabase/supabase-js");
  const { installFetchMock } = await import("./support/fetch-mock.ts");
  const { sendCalendarItem } = await import("../lib/publish-item.ts");
  const { calendarConfig } = await import("../lib/calendar-db.ts");
  const note = { id: "n", asset_id: "v", channel: null, body: encodeFixNote({ part: "media", assets: ["v"], channels: ["youtube"] }, "Trim opening"), created_at: "2030-01-01", resolved_at: null };
  const m = installFetchMock([
    { url: "http://db.test/rest/v1/rpc/gtm_piece_snapshot",json:null },
    { url: "http://db.test/rest/v1/gtm_stories", json: [] },
    { url: "http://db.test/rest/v1/gtm_story_assets", json: [{ id: "v", story_id: "s", kind: "video", sha256: "sha", revision: 1, stage: "final", metadata: {} }] },
    { url: "http://db.test/rest/v1/gtm_story_feedback", json: [note] },
    { url: "http://db.test/rest/v1/", json: [] },
  ]);
  try {
    const db = createClient("http://db.test", "test-key", { auth: { persistSession: false } });
    await assert.rejects(sendCalendarItem({ path: "db:gtm_content_items", source: "db", ...calendarConfig(), items: [{ id: "s-youtube", story_id: "s", title: "Piece", status: "approved", date: "2030-01-01", channels: ["youtube"], format: "video", pillar: "proof", week: 1 }] }, "s-youtube", { db }), /waiting for the fix/);
    assert.ok(m.calls.every((c) => c.method === "GET" || c.url.includes("/rpc/gtm_piece_snapshot")), "only reads occurred; no provider or decision write");
    // The hold is channel-scoped like autoscheduling (#157): the fix on YouTube does not hold the LinkedIn post.
    await assert.rejects(sendCalendarItem({ path: "db:gtm_content_items", source: "db", ...calendarConfig(), items: [{ id: "s-linkedin", story_id: "s", title: "Piece", status: "approved", date: "2030-01-01", channels: ["linkedin"], format: "video", pillar: "proof", week: 1 }] }, "s-linkedin", { db }), (e: Error) => !/waiting for the fix/.test(e.message));
  } finally { m.restore(); }
});

test("bounded provider verification leaves older records explicitly unverified", async () => {
  const { createClient } = await import("@supabase/supabase-js");
  const { installFetchMock } = await import("./support/fetch-mock.ts");
  const { loadDeliveryReport } = await import("../lib/delivery-report.ts");
  const items = Array.from({ length: 121 }, (_, i) => ({ id: `p${i}`, story_id: "s", title: "Piece", date: "2030-01-01", channels: ["youtube"], status: "scheduled", zernio_post_id: `z${i}`, urls: {} }));
  const m = installFetchMock([{ url: "http://db.test/rest/v1/gtm_content_items", json: items }, { url: "http://db.test/rest/v1/gtm_piece_deliveries", json: [] }]);
  let calls = 0;
  try {
    const db = createClient("http://db.test", "test-key", { auth: { persistSession: false } });
    const rows = await loadDeliveryReport(db, true, async (id) => { calls++; return { _id: id, status: "scheduled", platforms: [{ platform: "youtube", accountId: "a", status: "scheduled" }] }; });
    assert.equal(calls, 120); assert.equal(rows.filter((r) => r.verified).length, 120);
    assert.equal(rows[0].state, "unverified"); assert.ok(m.calls.every((c) => c.method === "GET" || c.url.includes("/rpc/gtm_piece_snapshot")), "only reads occurred; no provider or decision write");
  } finally { m.restore(); }
});

test("a shared delivery reads from the ledger: prepared is waiting for the dispatcher, never 'needs reconciliation' (review #151 N9)", async () => {
  const { ledgerState } = await import("../lib/delivery-report.ts");
  const item = { id: "s-linkedin", story_id: "s", title: "Piece", channels: ["linkedin"], status: "drafted", date: "2030-01-01", zernio_post_id: "pending", urls: {} };
  const row = (state: string, extra = {}) => ({ calendar_id: "s-linkedin", channel: "linkedin", state, slot_date: "2030-01-01", slot_time: "14:00:00", error: null, publication_url: null, provider_id: null, ...extra });
  const prepared = ledgerState(item, row("prepared"));
  assert.equal(prepared.state, "blocked");
  assert.match(prepared.reason, /Reserved for 2030-01-01 14:00, not sent yet/);
  assert.doesNotMatch(prepared.reason, /reconciliation/);
  assert.match(ledgerState(item, row("uncertain", { error: "response lost" })).reason, /use Recover on the piece/);
  assert.equal(ledgerState(item, row("published", { publication_url: "https://li/x" })).url, "https://li/x");
  assert.match(ledgerState(item, row("failed", { error: "rate limited" })).reason, /rate limited; retry it/);
});
