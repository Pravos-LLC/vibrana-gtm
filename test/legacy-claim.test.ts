// The legacy send claim (review #151 N4): "Publish now" is not refused because the channel already has a post that day,
// and every refusal reads in plain words.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import { installFetchMock } from "./support/fetch-mock.ts";
import { claimLegacySend } from "../lib/publish-item.ts";
import type { Item } from "../lib/calendar.ts";

const db = createClient("http://db.test", "test-key", { auth: { persistSession: false } });
const item: Item = { id: "p-linkedin", story_id: "p", title: "Post", status: "approved", date: "2030-01-08", channels: ["linkedin"], format: "text", pillar: "proof", week: 2, approved_hash: "h1" };
const refuse = (message: string) => ({ method: "POST", url: "http://db.test/rest/v1/rpc/gtm_claim_legacy_send", status: 409, json: { code: "PT409", message } });

test("Publish now onto a day that already has a post claims the same approved row instead of refusing", async () => {
  const m = installFetchMock([refuse("publishing slot was taken; replan"), { method: "PATCH", url: "http://db.test/rest/v1/gtm_content_items", json: { id: "p-linkedin" } }]);
  try {
    await claimLegacySend(db, item.id, item, [], "now");
    const patch = m.calls.find((c) => c.method === "PATCH")!;
    const q = new URL(patch.url).searchParams;
    assert.deepEqual([q.get("id"), q.get("status"), q.get("zernio_post_id"), q.get("approved_hash")], ["eq.p-linkedin", "eq.approved", "is.null", "eq.h1"]);
    assert.equal(JSON.parse(patch.body!).zernio_post_id, "pending");
  } finally { m.restore(); }
});

test("Schedule onto a taken day, a claimed row and a held piece each say what to do", async () => {
  for (const [message, mode, want] of [
    ["publishing slot was taken; replan", "schedule", /linkedin already has a post on 2030-01-08\. Move this post to another day in \/calendar, or use Publish now/],
    ["post is already claimed or no longer approved", "now", /already on its way to Zernio/],
    ["publishing is held or waiting for an accepted fix", "now", /on hold or waiting for the fix/],
    ["use shared piece dispatch", "schedule", /uses shared review; it schedules from its card/],
  ] as const) {
    const m = installFetchMock([refuse(message)]);
    try { await assert.rejects(claimLegacySend(db, item.id, item, [], mode), want); } finally { m.restore(); }
  }
});
