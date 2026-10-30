import test from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import { installFetchMock } from "./support/fetch-mock";
import { addMissingCalendarItem, updateUnclaimedItem } from "../lib/auto-schedule";
import type { Item } from "../lib/calendar";
import type { ContentRow } from "../lib/calendar-db";

test("simultaneous approval callbacks insert a platform once, preserving the winner instead of overwriting it", async () => {
  const db = createClient("http://db.test", "test-key", { auth: { persistSession: false } });
  const row = { id: "p", status: "drafted", date: "2030-01-08" } as ContentRow;
  const m = installFetchMock([
    { method: "POST", url: "http://db.test/rest/v1/gtm_content_items", json: [{ id: "p" }], times: 1 },
    { method: "POST", url: "http://db.test/rest/v1/gtm_content_items", json: [] },
  ]);
  try {
    assert.equal(await addMissingCalendarItem(db, row), true);
    assert.equal(await addMissingCalendarItem(db, row), false);
    assert.ok(m.calls.every((c) => c.headers.prefer.includes("resolution=ignore-duplicates")));
    assert.ok(m.calls.every((c) => new URL(c.url).searchParams.get("on_conflict") === "id"));
  } finally { m.restore(); }
});

test("a losing scheduling pass cannot change or roll back a claimed/completed row", async () => {
  const db = createClient("http://db.test", "test-key", { auth: { persistSession: false } });
  const item = { id: "p", status: "drafted", date: "2030-01-08", time: "14:00", body: "approved text", media: ["master.mp4"] } as Item;
  const m = installFetchMock([
    { method: "PATCH", url: "http://db.test/rest/v1/gtm_content_items", json: [{ id: "p" }], times: 1 },
    { method: "PATCH", url: "http://db.test/rest/v1/gtm_content_items", json: [] },
  ]);
  try {
    assert.equal(await updateUnclaimedItem(db, item, { status: "approved" }), true);
    assert.equal(await updateUnclaimedItem(db, item, { status: "approved" }), false);
    for (const call of m.calls) {
      const q = new URL(call.url).searchParams;
      assert.equal(q.get("zernio_post_id"), "is.null");
      assert.equal(q.get("status"), "eq.drafted");
      assert.equal(q.get("date"), "eq.2030-01-08");
      assert.equal(q.get("body"), "eq.approved text");
      assert.equal(q.get("media"), 'eq.["master.mp4"]');
    }
  } finally { m.restore(); }
});
