// Shared staging rules that need no database (review #145 N1, N3).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sameChannels, sharedChannels, sharedDeliveryInstalled } from "../lib/piece-review.ts";

test("one channel rule for configuring a shared piece and for checking a restage against it", () => {
  const assets = [
    { id: "t", channels: ["youtube", "linkedin", "newsletter"] },
    { id: "v", channels: ["instagram", "linkedin"] },
    { id: "cover", channels: ["website"] },
  ];
  assert.deepEqual(sharedChannels(assets, ["t", "v"]), ["linkedin", "instagram", "youtube"], "a Substack companion or a cover's channel is not drift");
  assert.deepEqual(sharedChannels(assets, ["v"]), ["linkedin", "instagram"]);
  assert.equal(sameChannels(["youtube", "linkedin"], ["linkedin", "youtube"]), true);
  assert.equal(sameChannels(["linkedin"], ["linkedin", "youtube"]), false);
  assert.deepEqual(sharedChannels(assets, []), []);
});

test("shared delivery counts as installed only once the delivery ledger is in the database", async () => {
  const probe = (error: { code?: string; message: string } | null) => ({ from: () => ({ select: () => ({ limit: async () => ({ error }) }) }) }) as unknown as SupabaseClient;
  assert.deepEqual(await sharedDeliveryInstalled(probe(null)), { ok: true });
  const missing = await sharedDeliveryInstalled(probe({ code: "PGRST205", message: "Could not find the table 'public.gtm_piece_delivery_attempts'" }));
  assert.equal(missing.ok, false);
  assert.match(!missing.ok ? missing.reason : "", /brand\.example\.com #221/);
  assert.equal((await sharedDeliveryInstalled(probe({ code: "42703", message: "column gtm_piece_delivery_attempts.story_id does not exist" }))).ok, false, "an older ledger without this build's columns is not installed");
  await assert.rejects(sharedDeliveryInstalled(probe({ code: "57014", message: "statement timeout" })), /shared delivery check: statement timeout/, "a failed read is an error, never a silent off");
});
