import { before, test } from "node:test";
import assert from "node:assert/strict";
import { admin, seed, signedIn, sql } from "../support/seed";
import { digest } from "../../lib/story";
import {
  configurePieceReview,
  decidePiecePart,
  loadPieceReview,
  pieceCandidates,
  savePieceText,
} from "../../lib/piece-review";
import {
  preparePieceDeliveries,
  sendPieceDelivery,
  reconcilePieceDeliveries,
  loadPieceDeliveries,
  deliveryOutcome,
  recoverUncertainDelivery,
  releaseUnsentDelivery,
  retireDeadDelivery,
  retiredPostAlerts,
  raiseRetiredAlerts,
} from "../../lib/piece-delivery";
import { retryPieceDelivery, scheduleSharedPieces } from "../../lib/piece-schedule";
import { ZernioError } from "../../lib/zernio";
import { moveCalendarItem } from "../../lib/reschedule";
import { reviewSummary } from "../../lib/review-summary";
import { mp4 } from "../support/mp4";
import type { Calendar } from "../../lib/calendar";
import type { ZPost } from "../../lib/zernio";
before(async () => {
  await seed();
  sql(
    "insert into public.gtm_seasons(id,title,starts_on,ends_on) values('delivery-test-season','Synthetic','2030-01-01','2099-12-31')",
  );
});
const db = admin();
const cal: Calendar = {
  path: "calendar.yaml",
  timezone: "UTC",
  accounts: { linkedin: "li", instagram: "ig", youtube: "yt" },
  manual: [],
  items: [],
};
async function ready(
  id: string,
  day: string,
  channels = ["linkedin", "youtube"],
  body = "One caption",
  reserve = true,
) {
  const ok = (r: { error: { message: string } | null }) => {
    if (r.error) throw new Error(r.error.message);
  };
  ok(
    await db
      .from("gtm_stories")
      .insert({ id, title: id, link_url: "https://example.com" }),
  );
  const bytes = mp4(),
    path = `stories/${id}/video.mp4`;
  ok(
    await db.storage
      .from("content-review")
      .upload(path, bytes, { contentType: "video/mp4", upsert: true }),
  );
  ok(
    await db.from("gtm_story_assets").insert([
      {
        id: `${id}-text`,
        story_id: id,
        title: "Text",
        kind: "copy",
        source: "caption.md",
        body,
        sha256: digest(body),
      },
      {
        id: `${id}-video`,
        story_id: id,
        title: "Video",
        kind: "video",
        source: "video.mp4",
        sha256: digest(bytes),
        storage_path: path,
        stage: "final",
      },
    ]),
  );
  const owner = await signedIn("owner"),
    candidates = await pieceCandidates(owner, id);
  let s = await configurePieceReview(owner, {
    storyId: id,
    text: candidates.find((c) => c.asset.kind === "copy")!,
    video: candidates.find((c) => c.asset.kind === "video")!,
    channels,
  });
  for (const part of ["text", "video"] as const)
    s = await decidePiecePart(owner, {
      storyId: id,
      part,
      decision: "approved",
      note: "",
      fingerprint: s[part].fingerprint,
      revision: s[part].asset.revision,
    });
  assert.equal(s.ready, true);
  const deliveries = reserve
    ? await preparePieceDeliveries(
        db,
        s,
        channels.map((channel) => ({ channel, date: day, time: "14:00" })),
        "UTC",
        "proof",
      )
    : [];
  return { s, owner, deliveries };
}
const post = (
  d: { channel: string },
  id: string,
  status = "scheduled",
): ZPost => ({
  _id: id,
  status,
  platforms: [
    { platform: d.channel, accountId: cal.accounts[d.channel], status },
  ],
});

test("concurrent workers create once; frozen channel versions survive draft edits and calendar drag is refused before provider access", async () => {
  const { s, owner, deliveries } = await ready(
    "delivery-concurrent",
    "2030-11-04",
  );
  let creates = 0,
    uploads = 0;
  const provider = {
    upload: async () => {
      uploads++;
      return "https://example.test/video.mp4";
    },
    create: async (request: Record<string, unknown>) => {
      creates++;
      assert.equal(request.content, "One caption");
      assert.equal((request.platforms as unknown[]).length, 1);
      assert.equal((request.mediaItems as unknown[]).length, 1);
      return { post: post(deliveries[0], "concurrent-provider") };
    },
  };
  const outcomes = await Promise.all([
    sendPieceDelivery(db, deliveries[0].id, cal, { provider }),
    sendPieceDelivery(db, deliveries[0].id, cal, { provider }),
  ]);
  assert.equal(creates, 1);
  assert.equal(uploads, 1);
  assert.equal(outcomes.filter(Boolean).length, 1);
  await savePieceText(owner, {
    storyId: s.storyId,
    body: "Separate draft",
    fingerprint: s.text.fingerprint,
    revision: s.text.asset.revision,
  });
  const frozen = (await loadPieceDeliveries(db, s.storyId))[0];
  assert.equal(frozen.review_snapshot.text.asset.body, "One caption");
  assert.equal((await loadPieceReview(db, s.storyId))!.text.status, "pending");
  await assert.rejects(
    moveCalendarItem(db, deliveries[0].calendar_id, { date: "2030-11-05" }),
    /frozen delivery/,
  );
  // The never-sent sibling no longer matches the approved versions (website #221 4952ffb): it is refused before any
  // provider call, so a draft edit cannot let it go out unapproved; the scheduler releases and prepares it again.
  let siblingCreates = 0;
  await assert.rejects(
    sendPieceDelivery(db, deliveries[1].id, cal, { provider: { ...provider, create: async () => { siblingCreates++; return {}; } } }),
    /the piece changed since this delivery was prepared/,
  );
  assert.equal(siblingCreates, 0);
  assert.equal((await loadPieceDeliveries(db, s.storyId)).find((d) => d.id === deliveries[0].id)?.state, "scheduled", "the sent channel stays frozen");
});

test("lost provider response stays uncertain until reconciliation; repeated jobs never create again", async () => {
  const { s, deliveries } = await ready("delivery-timeout", "2030-11-06", [
      "linkedin",
    ]),
    d = deliveries[0];
  let creates = 0;
  const provider = {
    upload: async () => "https://example.test/video.mp4",
    create: async () => {
      creates++;
      throw new Error("response lost after provider accepted");
    },
  };
  assert.equal(
    (await sendPieceDelivery(db, d.id, cal, { provider }))?.state,
    "uncertain",
  );
  assert.equal(
    await sendPieceDelivery(db, d.id, cal, { retry: true, provider }),
    null,
  );
  await reconcilePieceDeliveries(db, {
    storyId: s.storyId,
    provider: { find: async () => null },
  });
  assert.equal(
    (await loadPieceDeliveries(db, s.storyId))[0].state,
    "uncertain",
  );
  const observed = {
    ...post(d, "lost-provider"),
    metadata: { deliveryId: d.id },
  };
  await Promise.all([
    reconcilePieceDeliveries(db, {
      storyId: s.storyId,
      provider: { find: async () => observed },
    }),
    reconcilePieceDeliveries(db, {
      storyId: s.storyId,
      provider: { find: async () => observed },
    }),
  ]);
  assert.equal(
    (await loadPieceDeliveries(db, s.storyId))[0].provider_id,
    "lost-provider",
  );
  assert.equal(
    await sendPieceDelivery(db, d.id, cal, { retry: true, provider }),
    null,
  );
  assert.equal(creates, 1);
});

test("partial channel failures retry the known provider post without approval; publication links and actual timestamps persist", async () => {
  const { s, deliveries } = await ready("delivery-partial", "2030-11-07");
  let creates = 0,
    retries = 0;
  const provider = {
    upload: async () => "https://example.test/video.mp4",
    create: async (r: Record<string, unknown>) => {
      creates++;
      const channel = (r.platforms as { platform: string }[])[0].platform,
        d = deliveries.find((d) => d.channel === channel)!;
      return {
        post: post(
          d,
          `${channel}-partial`,
          channel === "linkedin" ? "published" : "failed",
        ),
      };
    },
  };
  for (const d of deliveries)
    await sendPieceDelivery(db, d.id, cal, { provider });
  let rows = await loadPieceDeliveries(db, s.storyId);
  assert.equal(rows.find((d) => d.channel === "linkedin")!.state, "published");
  const failed = rows.find((d) => d.channel === "youtube")!;
  const retried = await sendPieceDelivery(db, failed.id, cal, {
    retry: true,
    provider: {
      ...provider,
      get: async () => post(failed, failed.provider_id!, "failed"),
      retry: async (id) => {
        retries++;
        return { post: post(failed, id, "scheduled") };
      },
    },
  });
  assert.equal(retried?.state, "scheduled", String(retried?.error));
  assert.equal(creates, 2);
  assert.equal(retries, 1);
  assert.equal((await loadPieceReview(db, s.storyId))!.text.status, "approved");
  await reconcilePieceDeliveries(db, {
    storyId: s.storyId,
    provider: {
      get: async (id) => ({
        ...post(rows.find((d) => d.provider_id === id)!, id, "published"),
        platforms: [
          {
            platform: rows.find((d) => d.provider_id === id)!.channel,
            accountId:
              cal.accounts[rows.find((d) => d.provider_id === id)!.channel],
            status: "published",
            platformPostUrl: `https://example.test/${id}`,
            publishedAt: "2030-11-07T14:01:00Z",
          },
        ],
      }),
    },
  });
  rows = await loadPieceDeliveries(db, s.storyId);
  assert.ok(rows.every((d) => d.state === "published" && d.publication_url));
  const c = await db
    .from("gtm_content_items")
    .select("published_at")
    .eq("id", failed.calendar_id)
    .single();
  assert.equal(
    Date.parse(c.data!.published_at),
    Date.parse("2030-11-07T14:01:00Z"),
  );
  assert.equal(
    deliveryOutcome(failed, {
      ...post(failed, failed.provider_id!, "published"),
      platforms: [{ platform: "youtube", accountId: "yt", status: "failed" }],
    }).state,
    "failed",
    "channel evidence overrides misleading aggregate success",
  );
});

test("hold applied during upload blocks the outbound API; read failures remain visible without reopening retry", async () => {
  const { s, deliveries } = await ready("delivery-hold", "2030-11-08", [
    "linkedin",
  ]);
  let creates = 0;
  const held = await sendPieceDelivery(db, deliveries[0].id, cal, {
    provider: {
      upload: async () => {
        await db
          .from("gtm_stories")
          .update({ held_at: new Date().toISOString() })
          .eq("id", s.storyId);
        return "https://example.test/video.mp4";
      },
      create: async () => {
        creates++;
        throw new Error("must not send");
      },
    },
  });
  assert.equal(held?.state, "failed");
  assert.match(held!.error!, /hold/);
  assert.equal(creates, 0);
});

test("shared packaging uses frozen title and preserves upstream plain-name team tags", async () => {
  await db.from("gtm_people").insert({
    name: "Synthetic Teammate",
    linkedin_name: "Synthetic Teammate",
    linkedin_urn: "urn:li:person:synthetic",
    auto_tag: true,
  });
  const { deliveries } = await ready(
    "delivery-tags",
    "2030-11-09",
    ["linkedin", "youtube"],
    "---\nyoutube_tags: reliability,workflow\n---\nSynthetic and I shipped this",
  );
  const changedCal = {
    ...cal,
    items: deliveries.map((d) => ({
      id: d.calendar_id,
      title: "Mutable replacement",
    })),
  } as Calendar;
  for (const d of deliveries) {
    const sent = await sendPieceDelivery(db, d.id, changedCal, {
      provider: {
        upload: async () => "https://example.test/video.mp4",
        create: async (request) => {
          const platform = (
            request.platforms as {
              customContent?: string;
              platformSpecificData?: { title?: string };
            }[]
          )[0];
          if (d.channel === "linkedin")
            assert.match(
              platform.customContent!,
              /@\[Synthetic\]\(urn:li:person:synthetic\)/,
            );
          if (d.channel === "youtube") {
            assert.equal(
              platform.platformSpecificData?.title,
              "Synthetic and I shipped this",
            );
            assert.deepEqual(request.tags, ["reliability", "workflow"]);
          }
          return { post: post(d, `tags-${d.channel}`) };
        },
      },
    });
    assert.equal(sent?.state, "scheduled", sent?.error ?? "");
  }
});

test("concurrent stories reserve a whole channel group once; a colliding group leaves no partial rows", async () => {
  const a = await ready(
      "batch-a",
      "2030-11-12",
      ["linkedin", "youtube"],
      "Batch one",
      false,
    ),
    b = await ready(
      "batch-b",
      "2030-11-12",
      ["linkedin", "youtube"],
      "Batch two",
      false,
    );
  const slots = [
    { channel: "linkedin", date: "2030-11-12", time: "14:00" },
    { channel: "youtube", date: "2030-11-12", time: "17:00" },
  ];
  const results = await Promise.allSettled([
    preparePieceDeliveries(db, a.s, slots, "UTC", "proof"),
    preparePieceDeliveries(db, b.s, slots, "UTC", "proof"),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const lost = results.find(
    (r) => r.status === "rejected",
  ) as PromiseRejectedResult;
  assert.match(String(lost.reason), /slot was taken/);
  const rows = (await loadPieceDeliveries(db)).filter((d) =>
    [a.s.storyId, b.s.storyId].includes(d.story_id),
  );
  assert.equal(rows.length, 2);
  assert.equal(new Set(rows.map((d) => d.story_id)).size, 1);
});

test("home summary counts one shared piece across channels and never disguises accepted fixes as approval", async () => {
  const before = await reviewSummary(db);
  const { s, owner } = await ready(
    "summary-piece",
    "2030-11-13",
    ["linkedin", "instagram", "youtube"],
    "Shared summary",
    false,
  );
  let after = await reviewSummary(db);
  assert.equal(after.textApproved, before.textApproved + 1);
  assert.equal(after.assetApproved, before.assetApproved + 1);
  assert.equal(after.awaiting, before.awaiting);
  await db
    .from("gtm_story_assets")
    .insert({
      id: "summary-historical",
      story_id: s.storyId,
      title: "History",
      kind: "copy",
      source: "history.md",
      body: "Old",
      sha256: digest("Old"),
    });
  const legacyNote = await db
    .from("gtm_story_feedback")
    .insert({
      asset_id: "summary-historical",
      body: "[approved with note: fix before scheduling] Historical owner fix",
    })
    .select("id")
    .single();
  assert.equal(legacyNote.error, null);
  after = await reviewSummary(db);
  assert.equal(after.openNotes, before.openNotes + 1);
  assert.equal(
    after.awaiting,
    before.awaiting + 1,
    "legacy conversion remains actionable even when canonical decisions are approved",
  );
  await db.from("gtm_story_feedback").delete().eq("id", legacyNote.data!.id);
  await decidePiecePart(owner, {
    storyId: s.storyId,
    part: "video",
    decision: "fixing",
    note: "Trim the final frame only",
    fingerprint: s.video.fingerprint,
    revision: s.video.asset.revision,
  });
  after = await reviewSummary(db);
  assert.equal(after.assetApproved, before.assetApproved);
  assert.equal(
    after.awaiting,
    before.awaiting,
    "an authorised fix waits on the agent, not another owner review",
  );
  assert.equal(after.openNotes, before.openNotes + 1);
  await savePieceText(owner, {
    storyId: s.storyId,
    body: "A new draft for review",
    fingerprint: s.text.fingerprint,
    revision: s.text.asset.revision,
  });
  after = await reviewSummary(db);
  assert.equal(
    after.awaiting,
    before.awaiting + 1,
    "current shared draft reaches the home review queue exactly once",
  );
});

test("a 429 on create is a definitive refusal: the delivery is failed and retries with a new key, never uncertain (review #151 B1)", async () => {
  const { deliveries } = await ready("delivery-429", "2031-03-04", ["linkedin"]);
  const d = deliveries[0];
  const keys: string[] = [];
  const limited = { upload: async () => "https://example.test/video.mp4", create: async (_b: unknown, key?: string) => { keys.push(key!); throw new ZernioError(429, "rate limited", "/posts"); } };
  const out = await sendPieceDelivery(db, d.id, cal, { provider: limited });
  assert.equal(out?.state, "failed");
  assert.match(out?.error ?? "", /rate limited/);
  const ok = { upload: async () => "https://example.test/video.mp4", create: async (_b: unknown, key?: string) => { keys.push(key!); return { post: post(d, "after-429") }; } };
  const sent = await sendPieceDelivery(db, d.id, cal, { retry: true, provider: ok });
  assert.equal(sent?.state, "scheduled");
  assert.equal(new Set(keys).size, 2, "the retry is a new claim with a new idempotency key");
});

test("an uncertain delivery always has a way out: found at the provider, re-sent once with the same key, or verified absent and retried (review #151 B1)", async () => {
  const lost = { upload: async () => "https://example.test/video.mp4", create: async () => { throw new Error("response lost"); } };
  // 1. The provider has it: recorded, nothing sent again.
  const a = (await ready("delivery-recover-found", "2031-03-05", ["linkedin"])).deliveries[0];
  assert.equal((await sendPieceDelivery(db, a.id, cal, { provider: lost }))?.state, "uncertain");
  let creates = 0;
  const found = await recoverUncertainDelivery(db, a.id, cal, { provider: { scan: async () => ({ post: { ...post(a, "found-post"), metadata: { deliveryId: a.id } }, pages: 1, scanned: 1 }), create: async () => { creates++; return {}; } } });
  assert.equal(found.action, "found");
  assert.equal(found.delivery?.provider_id, "found-post");
  assert.equal(creates, 0);
  // 2. Absent, inside the idempotency window: re-sent with the very same key, once.
  const b = (await ready("delivery-recover-resend", "2031-03-06", ["linkedin"])).deliveries[0];
  const keys: string[] = [];
  const first = { upload: async () => "https://example.test/video.mp4", create: async (_b: unknown, key?: string) => { keys.push(key!); throw new Error("response lost"); } };
  assert.equal((await sendPieceDelivery(db, b.id, cal, { provider: first }))?.state, "uncertain");
  const resent = await recoverUncertainDelivery(db, b.id, cal, { provider: { scan: async () => ({ post: null, pages: 1, scanned: 3 }), create: async (_b: unknown, key?: string) => { keys.push(key!); return { post: post(b, "resent-post") }; } } });
  assert.equal(resent.action, "resent", resent.detail);
  assert.equal(resent.delivery?.state, "scheduled", resent.detail);
  assert.equal(resent.delivery?.state, "scheduled");
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1], "the re-send reuses the original idempotency key");
  // 3. Absent and past the window: the scan is the evidence, the delivery fails, and the retry sends it exactly once.
  const c = (await ready("delivery-recover-resolve", "2031-03-11", ["linkedin"])).deliveries[0];
  assert.equal((await sendPieceDelivery(db, c.id, cal, { provider: lost }))?.state, "uncertain");
  sql(`update public.gtm_piece_delivery_attempts set started_at=now()-interval '2 days', last_posted_at=now()-interval '2 days' where delivery_id='${c.id}'`);
  const resolved = await recoverUncertainDelivery(db, c.id, cal, { provider: { scan: async () => ({ post: null, pages: 2, scanned: 612 }) } });
  assert.equal(resolved.action, "resolved");
  assert.equal(resolved.delivery?.state, "failed");
  assert.match(resolved.delivery?.error ?? "", /Verified absent at the provider: complete Zernio metadata scan \(2 pages, 612 posts/);
  let creates3 = 0;
  const retried = await retryPieceDelivery(db, c.id, { provider: { upload: async () => "https://example.test/video.mp4", create: async (body: Record<string, unknown>) => { creates3++; const acct = (body.platforms as { accountId: string }[])[0].accountId; return { post: { _id: "after-resolve", status: "scheduled", platforms: [{ platform: "linkedin", accountId: acct, status: "scheduled" }] } }; } } });
  assert.equal(retried?.state, "scheduled", String(retried?.error));
  assert.equal(creates3, 1, "verified absent, then sent exactly once");
  // Not uncertain: nothing to recover.
  await assert.rejects(recoverUncertainDelivery(db, found.delivery!.id, cal), /Only an uncertain delivery/);
});

test("an unsent reservation can be released: the channel/day is free again and the calendar row returns to drafted", async () => {
  const { deliveries } = await ready("delivery-release", "2031-03-12", ["linkedin"]);
  const d = deliveries[0];
  const out = await releaseUnsentDelivery(db, d.id);
  assert.equal(out.action, "released");
  assert.equal((await loadPieceDeliveries(db, "delivery-release")).length, 0);
  const row = (await db.from("gtm_content_items").select("status,zernio_post_id").eq("id", d.calendar_id).single()).data;
  assert.deepEqual(row, { status: "drafted", zernio_post_id: null });
  // Another piece can now take the same channel/day.
  const other = await ready("delivery-release-next", "2031-03-12", ["linkedin"]);
  assert.equal(other.deliveries[0].slot_date, "2031-03-12");
  // A delivery that reached the provider is not released.
  const sent = await sendPieceDelivery(db, other.deliveries[0].id, cal, { provider: { upload: async () => "https://example.test/v.mp4", create: async () => ({ post: post(other.deliveries[0], "kept") }) } });
  assert.equal(sent?.state, "scheduled");
  await assert.rejects(releaseUnsentDelivery(db, other.deliveries[0].id), /only an unsent delivery can be released/);
});

test("a reservation whose piece changed while it waited is released, never sent; the approved version is prepared again", async () => {
  const { s, owner, deliveries } = await ready("delivery-changed", "2031-03-18", ["linkedin"]);
  const d = deliveries[0];
  const edited = await savePieceText(owner, { storyId: s.storyId, body: "A changed caption", fingerprint: s.text.fingerprint, revision: s.text.asset.revision });
  assert.equal(edited.text.status, "pending");
  const r = await scheduleSharedPieces(db, { storyId: s.storyId, ids: [s.storyId] });
  assert.ok(r.skipped.some((x) => /piece changed after this slot was reserved; released/.test(x.reason)), JSON.stringify(r));
  assert.ok(r.skipped.some((x) => x.id === s.storyId), "the blocker (text needs approval) is reported");
  assert.equal((await loadPieceDeliveries(db, s.storyId)).length, 0, "nothing frozen is left to send");
  assert.equal((await db.from("gtm_content_items").select("status,zernio_post_id").eq("id", d.calendar_id).single()).data?.zernio_post_id, null);
  // John approves the new text: the current versions are prepared again for the channel.
  const approved = await decidePiecePart(owner, { storyId: s.storyId, part: "text", decision: "approved", note: "", fingerprint: edited.text.fingerprint, revision: edited.text.asset.revision });
  const again = await preparePieceDeliveries(db, approved, [{ channel: "linkedin", date: "2031-03-18", time: "14:00" }], "UTC", "proof");
  assert.equal(again[0].review_snapshot.text.fingerprint, approved.text.fingerprint);
});

test("a post deleted at Zernio is reconciled as failed with a replace action; replacing frees the channel to schedule again", async () => {
  const { s, deliveries } = await ready("delivery-dead", "2031-03-19", ["linkedin"]);
  const d = deliveries[0];
  const sent = await sendPieceDelivery(db, d.id, cal, { provider: { upload: async () => "https://example.test/v.mp4", create: async () => ({ post: post(d, "dead-1") }) } });
  assert.equal(sent?.state, "scheduled");
  const gone = { get: async () => { throw new ZernioError(404, "not found", "/posts/dead-1"); } };
  await reconcilePieceDeliveries(db, { storyId: s.storyId, provider: gone });
  const failed = (await loadPieceDeliveries(db, s.storyId))[0];
  assert.equal(failed.state, "failed");
  assert.match(failed.error ?? "", /no longer exists at Zernio or was cancelled there/);
  // A live post is never retired.
  await assert.rejects(retireDeadDelivery(db, d.id, { provider: { get: async () => post(d, "dead-1") } }), /Zernio still has post dead-1/);
  sql(`update public.gtm_piece_delivery_attempts set last_posted_at=now()-interval '1 hour' where delivery_id='${d.id}'`);
  const out = await retireDeadDelivery(db, d.id, { provider: gone });
  assert.match(out.detail, /returned 404/);
  assert.equal((await loadPieceDeliveries(db, s.storyId)).length, 0);
  const again = await preparePieceDeliveries(db, (await loadPieceReview(db, s.storyId))!, [{ channel: "linkedin", date: "2031-03-19", time: "15:00" }], "UTC", "proof");
  assert.equal(again[0].channel, "linkedin");
  // The retired post is watched: still gone is quiet; brought back by Zernio is an alert, never an action.
  assert.deepEqual((await retiredPostAlerts(db, { provider: gone })).filter((a) => a.providerId === "dead-1"), []);
  const back = (await retiredPostAlerts(db, { provider: { get: async () => post(d, "dead-1", "scheduled") } })).filter((a) => a.providerId === "dead-1");
  assert.match(back[0]?.message ?? "", /retired Zernio post dead-1 reports scheduled again/);
  // John sees it on the work board, once.
  assert.equal(await raiseRetiredAlerts(db, back), 1);
  assert.equal(await raiseRetiredAlerts(db, back), 0);
  const job = (await db.from("gtm_work_items").select("status,blocked_reason,story_id").like("title", "%dead-1%").single()).data;
  assert.equal(job?.status, "blocked");
  assert.equal(job?.story_id, s.storyId);
  await db.from("gtm_work_items").delete().like("title", "%dead-1%");
});

test("an expired reservation uploads nothing: the slot is checked before any media reaches the provider (review #151 N10)", async () => {
  const { deliveries } = await ready("delivery-expired", "2031-03-20", ["linkedin"]);
  const d = deliveries[0];
  sql(`update public.gtm_piece_deliveries set slot_date='2020-01-01' where id='${d.id}'; update public.gtm_content_items set date='2020-01-01' where id='${d.calendar_id}'`);
  let uploads = 0, creates = 0;
  const out = await sendPieceDelivery(db, d.id, cal, { provider: { upload: async () => { uploads++; return "u"; }, create: async () => { creates++; return {}; } } });
  assert.equal(out?.state, "failed");
  assert.match(out?.error ?? "", /Reserved slot expired/);
  assert.deepEqual([uploads, creates], [0, 0]);
});

test("an uncertain delivery whose Zernio post is gone is settled as failed by that read, then replaced", async () => {
  const { s, deliveries } = await ready("delivery-dead-uncertain", "2031-03-25", ["linkedin"]);
  const d = deliveries[0];
  await sendPieceDelivery(db, d.id, cal, { provider: { upload: async () => "u", create: async () => ({ post: post(d, "dead-2") }) } });
  await reconcilePieceDeliveries(db, { storyId: s.storyId, provider: { get: async () => post(d, "dead-2", "mystery") } });
  assert.equal((await loadPieceDeliveries(db, s.storyId))[0].state, "uncertain");
  sql(`update public.gtm_piece_delivery_attempts set last_posted_at=now()-interval '1 hour' where delivery_id='${d.id}'`);
  const out = await retireDeadDelivery(db, d.id, { provider: { get: async () => { throw new ZernioError(404, "gone", "/posts/dead-2"); } } });
  assert.match(out.detail, /Retired the dead linkedin post/);
  assert.equal((await loadPieceDeliveries(db, s.storyId)).length, 0);
});

test("an uncertain attempt is never re-sent once John changed the piece: the absence is recorded instead (website #221-10)", async () => {
  const { s, owner, deliveries } = await ready("delivery-recover-changed", "2031-03-26", ["linkedin"]);
  const d = deliveries[0];
  assert.equal((await sendPieceDelivery(db, d.id, cal, { provider: { upload: async () => "u", create: async () => { throw new Error("response lost"); } } }))?.state, "uncertain");
  await savePieceText(owner, { storyId: s.storyId, body: "A withdrawn caption replaced", fingerprint: s.text.fingerprint, revision: s.text.asset.revision });
  let creates = 0;
  const provider = { scan: async () => ({ post: null, pages: 1, scanned: 4 }), create: async () => { creates++; return {}; } };
  const early = await recoverUncertainDelivery(db, d.id, cal, { provider });
  assert.equal(creates, 0);
  assert.match(early.detail, /not sent again.*recover again shortly/);
  sql(`update public.gtm_piece_delivery_attempts set last_posted_at=now()-interval '1 hour' where delivery_id='${d.id}'`);
  const later = await recoverUncertainDelivery(db, d.id, cal, { provider });
  assert.equal(creates, 0);
  assert.equal(later.delivery?.state, "failed");
});

test("an adopted channel that keeps a healthy legacy post is kept quietly: no skip, no red line; a failed one is reported (review #151 F2)", async () => {
  const { s } = await ready("delivery-kept-legacy", "2031-03-27", ["linkedin"], "One caption", false);
  const row = (status: string, id: string) => ({ id: `${s.storyId}-linkedin`, week: 13, date: "2031-03-27", time: "09:00", pillar: "proof", title: "Kept", format: "video", channels: ["linkedin"], status, story_id: s.storyId, story_assets: [], body: "Old", media: [], zernio_post_id: id });
  assert.equal((await db.from("gtm_content_items").upsert(row("scheduled", "legacy-ok"))).error, null);
  const quiet = await scheduleSharedPieces(db, { storyId: s.storyId, ids: [s.storyId], dryRun: true });
  assert.deepEqual(quiet.skipped.filter((k) => k.id.includes(s.storyId)), [], JSON.stringify(quiet.skipped));
  assert.equal(quiet.scheduled.length, 0, "the kept channel gets no second delivery");
  const card = (await loadPieceReview(db, s.storyId))!.deliveries!.find((d) => d.legacy)!;
  assert.equal(card.error, null);
  assert.equal((await db.from("gtm_content_items").update({ status: "failed" }).eq("id", `${s.storyId}-linkedin`)).error, null);
  const loud = await scheduleSharedPieces(db, { storyId: s.storyId, ids: [s.storyId], dryRun: true });
  assert.ok(loud.skipped.some((k) => /existing legacy post is failed/.test(k.reason)), JSON.stringify(loud.skipped));
  await db.from("gtm_content_items").delete().eq("id", `${s.storyId}-linkedin`);
});
