// gtm_yt_video_daily constraints against the LOCAL stack: the values real YouTube syncs send must be stored, and a
// count that can never be negative is still refused. Shorts loop, so avg_view_pct passes 100; likes (and comments,
// shares, subscriber gains and losses) are net of removals, so a day can be negative (20261109020000).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { admin, seed } from "../support/seed.ts";

const VIDEO = "constraintyt1";
before(async () => {
  await seed();
  assert.equal((await admin().from("gtm_yt_videos").upsert({ video_id: VIDEO, title: "Constraint probe", is_short: true })).error, null);
});
after(async () => { await admin().from("gtm_yt_videos").delete().eq("video_id", VIDEO); });

test("a looping Short's avg_view_pct of 140 and a net-negative likes day are stored", async () => {
  const sr = admin();
  const r = await sr.from("gtm_yt_video_daily").insert({ date: "2001-02-01", video_id: VIDEO, views: 10, avg_view_pct: 140, likes: -1, subs_gained: -1, subs_lost: 2 }).select("avg_view_pct,likes").single();
  assert.equal(r.error, null, r.error?.message ?? "");
  assert.equal(Number(r.data!.avg_view_pct), 140);
  assert.equal(r.data!.likes, -1);
});

test("negative views are still refused by the check constraint", async () => {
  const r = await admin().from("gtm_yt_video_daily").insert({ date: "2001-02-02", video_id: VIDEO, views: -1 });
  assert.equal(r.error?.code, "23514", r.error?.message ?? "expected a check violation");
  assert.equal((await admin().from("gtm_yt_video_daily").select("date").eq("video_id", VIDEO).eq("date", "2001-02-02")).data?.length, 0);
});
