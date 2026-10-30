// A legacy create Zernio still rate-limits after the client's retries created nothing: the pending claim is reset so the
// next pass retries it, and the error says so (review #151 F1).
import { test } from "node:test";
import assert from "node:assert/strict";
Object.assign(process.env, { ZERNIO_API_URL: "https://zernio.test/api/v1", ZERNIO_API_KEY: "zk_test" });
const { createClient } = await import("@supabase/supabase-js");
const { installFetchMock } = await import("./support/fetch-mock.ts");
const { sendCalendarItem } = await import("../lib/publish-item.ts");
const { calendarConfig, contentHash } = await import("../lib/calendar-db.ts");

test("a 429 on the legacy create resets the claim and is retried on the next pass", async () => {
  const m = installFetchMock([
    { method: "POST", url: "http://db.test/rest/v1/rpc/gtm_claim_legacy_send", json: true },
    { method: "POST", url: "https://zernio.test/api/v1/posts", status: 429, headers: { "retry-after": "0" }, json: { error: "rate limited" } },
    { method: "PATCH", url: "http://db.test/rest/v1/gtm_content_items", status: 204 },
    { method: "GET", url: "http://db.test/rest/v1/", json: [] },
  ]);
  try {
    const db = createClient("http://db.test", "test-key", { auth: { persistSession: false } });
    const cal = { path: "db:gtm_content_items", source: "db" as const, ...calendarConfig(), items: [{ id: "plain-linkedin", title: "Plain", status: "approved" as const, date: "2030-01-08", time: "09:00", channels: ["linkedin"], format: "text", pillar: "proof", week: 2, body: "A plain post.", media: [], approved_hash: contentHash({ body: "A plain post.", media: [] }) }] };
    await assert.rejects(sendCalendarItem(cal, "plain-linkedin", { db }), /rate-limiting posts \(429\).*retried on the next scheduling pass/);
    assert.equal(m.calls.filter((c) => c.method === "POST" && c.url.endsWith("/posts")).length, 4, "the client retried three times first");
    const reset = m.calls.find((c) => c.method === "PATCH");
    assert.ok(reset, "the pending claim was reset");
    assert.equal(JSON.parse(reset!.body!).zernio_post_id, null);
  } finally { m.restore(); }
});
