// Shared content is reviewed once; each channel owns a separate frozen delivery and failure state.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PieceReviewSnapshot } from "./piece-review";
import type { Calendar, Item } from "./calendar";
import { must } from "./db";
import { readPages } from "./db-read";
import { digest } from "./story";
import { BUCKET } from "./review";
import { buildPost, sendLarge, peopleFor, seasonsFor } from "./publish-item";
import { utmCampaign } from "./utm";
import {
  uploadMedia,
  createPost,
  getPost,
  retryPost,
  findDeliveryPost,
  scanDeliveryPost,
  ZernioError,
  type ZPost,
} from "./zernio";
import { guardMediaBytes } from "./media-guard";
import { LargeMedia, isLargeSize } from "./large-media";
import { basename } from "node:path";
export type DeliveryState =
  | "prepared"
  | "uploading"
  | "sending"
  | "uncertain"
  | "scheduled"
  | "published"
  | "failed";
export type PieceDelivery = {
  id: string;
  story_id: string;
  channel: string;
  calendar_id: string;
  slot_date: string;
  slot_time: string;
  timezone: string;
  state: DeliveryState;
  review_snapshot: PieceReviewSnapshot;
  request: Record<string, unknown> | null;
  claim_token: string | null;
  claimed_at: string | null;
  provider_id: string | null;
  publication_url: string | null;
  error: string | null;
};
export async function loadPieceDeliveries(
  db: SupabaseClient,
  storyId?: string,
): Promise<PieceDelivery[]> {
  return readPages((from, to) => {
    const q = db.from("gtm_piece_deliveries").select("*").order("id");
    return (storyId ? q.eq("story_id", storyId) : q).range(from, to);
  }, "channel delivery evidence");
}
export async function preparePieceDelivery(
  db: SupabaseClient,
  s: PieceReviewSnapshot,
  slot: { channel: string; date: string; time: string },
  timezone: string,
  pillar: string | null = null,
): Promise<PieceDelivery> {
  return must(
    await db.rpc("gtm_prepare_piece_delivery", {
      p_story_id: s.storyId,
      p_channel: slot.channel,
      p_date: slot.date,
      p_time: slot.time,
      p_timezone: timezone,
      p_expected: { text: s.text.fingerprint, video: s.video.fingerprint },
      p_pillar: pillar,
    }),
    "reserve channel delivery",
  ) as PieceDelivery;
}
export async function preparePieceDeliveries(
  db: SupabaseClient,
  s: PieceReviewSnapshot,
  slots: { channel: string; date: string; time: string }[],
  timezone: string,
  // The piece's pillar for a new calendar row (season config or the copy's front matter); the database falls back to
  // the Story's other rows and its content candidate, and asks for one rather than guessing.
  pillar: string | null = null,
): Promise<PieceDelivery[]> {
  return must(
    await db.rpc("gtm_prepare_piece_deliveries", {
      p_story_id: s.storyId,
      p_slots: slots.map((slot) => ({ ...slot, timezone })),
      p_expected: { text: s.text.fingerprint, video: s.video.fingerprint },
      p_pillar: pillar,
    }),
    "reserve all channel deliveries",
  ) as PieceDelivery[];
}
type Provider = {
  upload: typeof uploadMedia;
  create: typeof createPost;
  get: typeof getPost;
  find: typeof findDeliveryPost;
  retry: typeof retryPost;
};
const provider: Provider = {
  upload: uploadMedia,
  create: createPost,
  get: getPost,
  find: findDeliveryPost,
  retry: retryPost,
};
const account = (value: string | { _id: string }) =>
  typeof value === "string" ? value : value._id;
export function deliveryOutcome(
  d: PieceDelivery,
  post: ZPost,
): {
  state: "scheduled" | "published" | "failed" | "uncertain";
  url: string | null;
  error: string | null;
  publishedAt?: string | null;
} {
  const entries = post.platforms ?? [];
  const expected = (
    d.request?.platforms as { accountId: string }[] | undefined
  )?.[0]?.accountId;
  if (
    entries.length !== 1 ||
    entries[0].platform !== d.channel ||
    (expected && account(entries[0].accountId) !== expected)
  )
    throw new Error(
      "Provider channel/account does not match the frozen delivery",
    );
  if (d.provider_id && post._id !== d.provider_id)
    throw new Error("Provider identity does not match delivery");
  const p = entries[0],
    url = p.platformPostUrl ?? null;
  if (p.status === "published" || (!p.status && post.status === "published"))
    return {
      state: "published",
      url,
      error: null,
      publishedAt: p.publishedAt ?? post.publishedAt ?? null,
    };
  if (
    p.status === "failed" ||
    post.status === "failed" ||
    post.status === "partial" ||
    post.status === "cancelled"
  )
    return {
      state: "failed",
      url,
      error: p.errorMessage ?? `Provider status: ${post.status}`,
    };
  if (["scheduled", "publishing", "pending"].includes(post.status))
    return { state: "scheduled", url, error: null };
  return {
    state: "uncertain",
    url,
    error: `Unverified provider status: ${post.status}`,
  };
}
async function record(
  db: SupabaseClient,
  d: PieceDelivery,
  state: DeliveryState,
  providerId: string | null,
  url: string | null,
  error: string | null,
  publishedAt: string | null = null,
): Promise<PieceDelivery> {
  return must(
    await db.rpc("gtm_record_piece_delivery", {
      p_id: d.id,
      p_token: d.claim_token,
      p_provider_id: providerId,
      p_state: state,
      p_url: url,
      p_error: error,
      p_published_at: publishedAt,
    }),
    "record channel outcome",
  ) as PieceDelivery;
}
async function recordPost(db: SupabaseClient, d: PieceDelivery, p: ZPost) {
  const outcome = deliveryOutcome(d, p);
  return record(
    db,
    d,
    outcome.state,
    p._id,
    outcome.url,
    outcome.error,
    outcome.publishedAt,
  );
}
async function frozenRequest(
  db: SupabaseClient,
  d: PieceDelivery,
  cal: Calendar,
  p: Provider,
): Promise<Record<string, unknown>> {
  const s = d.review_snapshot,
    text = s.text.asset,
    video = s.video.asset;
  if (digest(text.body ?? "") !== text.sha256)
    throw new Error("Frozen text does not match its approved digest");
  if (!video.storage_path) throw new Error("Frozen video has no storage path");
  const row = cal.items.find((i) => i.id === d.calendar_id);
  const item: Item = {
    id: d.calendar_id,
    story_id: d.story_id,
    story_assets: [text.id, video.id],
    body: text.body ?? "",
    copy: text.source,
    title: text.title,
    date: d.slot_date,
    time: d.slot_time.slice(0, 5),
    week: row?.week ?? 1,
    pillar: row?.pillar ?? "proof",
    format: "video",
    channels: [d.channel],
    media: [video.storage_path],
    status: "approved",
  };
  const people = await peopleFor(db, text.body ?? "");
  // Our own links carry UTM tags exactly as on a legacy post, so a visit traces back to it (review #151 N8).
  const { copy, platforms } = await buildPost(
    cal,
    item,
    text.body ?? "",
    { campaign: utmCampaign(d.slot_date, await seasonsFor(db)) },
    people,
    { shared: true },
  );
  // The one length rule (lib/channel-rules.ts TEXT_LIMITS, LinkedIn at most 4,000), counted on the text actually sent:
  // the built post with its mentions and tagged links, before anything is uploaded.
  const { checkChannelLength } = await import("./channel-rules");
  const long = checkChannelLength(d.calendar_id, [d.channel], { base: (platforms[0] as { customContent?: string }).customContent ?? copy.base, perChannel: {}, meta: copy.meta });
  if (long.length) throw new Error(long.join(" "));
  let videoUrl: string;
  const size =
    typeof video.metadata?.bytes === "number" ? video.metadata.bytes : null;
  if (typeof video.metadata?.proxy_path === "string" && size === null)
    throw new Error(
      "Frozen master has no recorded size; restage it before review",
    );
  if (size !== null && isLargeSize(size))
    videoUrl = await sendLarge(
      new LargeMedia(
        video.storage_path,
        size,
        video.sha256,
        video.storage_path,
      ),
      basename(video.source),
      "video/mp4",
      db,
    );
  else {
    const result = await db.storage.from(BUCKET).download(video.storage_path);
    if (result.error || !result.data)
      throw new Error("Cannot read frozen video from storage");
    const bytes = Buffer.from(await result.data.arrayBuffer());
    if (digest(bytes) !== video.sha256)
      throw new Error("Frozen video no longer matches the approved digest");
    guardMediaBytes(bytes, "video/mp4", video.source, { publish: true });
    videoUrl = await p.upload(bytes, basename(video.source), "video/mp4");
  }
  const media: { type: string; url: string; thumbnail?: string } = {
    type: "video",
    url: videoUrl,
  };
  // Packaging bytes are part of the text fingerprint. Unrecorded local filenames cannot reach a provider.
  const thumb = text.metadata?.thumbnail_path,
    thumbSha = text.metadata?.thumbnail_sha256;
  if (
    typeof thumb === "string" &&
    typeof thumbSha === "string" &&
    (d.channel === "youtube" || d.channel === "instagram")
  ) {
    const r = await db.storage.from(BUCKET).download(thumb);
    if (r.error || !r.data) throw new Error("Cannot read frozen packaging");
    const bytes = Buffer.from(await r.data.arrayBuffer());
    if (digest(bytes) !== thumbSha)
      throw new Error("Frozen packaging digest differs from approval");
    const mime = /\.png$/i.test(thumb) ? "image/png" : "image/jpeg";
    guardMediaBytes(bytes, mime, thumb, { publish: true });
    const uploaded = await p.upload(bytes, basename(thumb), mime);
    if (d.channel === "youtube") media.thumbnail = uploaded;
    else
      platforms[0].platformSpecificData = {
        ...platforms[0].platformSpecificData,
        instagramThumbnail: uploaded,
      };
  } else if (copy.meta.youtube_thumbnail && d.channel === "youtube")
    throw new Error("Restage the approved packaging before scheduling");
  else if (d.channel === "instagram") {
    // The Instagram Reel cover is the image staged beside the video (John, 2026-10-16), sent only when John approved it
    // for Instagram at its current bytes (review #151 N8; covers stay per-platform decisions on a shared piece).
    const cover = await approvedReelCover(db, d.story_id, video.id);
    if (cover) {
      const r = await db.storage.from(BUCKET).download(cover.storage_path);
      if (r.error || !r.data) throw new Error("Cannot read the approved Reel cover");
      const bytes = Buffer.from(await r.data.arrayBuffer());
      if (digest(bytes) !== cover.sha256) throw new Error("The Reel cover changed after approval; restage it");
      const mime = /\.png$/i.test(cover.storage_path) ? "image/png" : "image/jpeg";
      guardMediaBytes(bytes, mime, cover.storage_path, { publish: true });
      platforms[0].platformSpecificData = { ...platforms[0].platformSpecificData, instagramThumbnail: await p.upload(bytes, basename(cover.storage_path), mime) };
    }
  }
  return {
    content: copy.base,
    platforms,
    timezone: d.timezone,
    scheduledFor: `${d.slot_date}T${d.slot_time.slice(0, 5)}:00`,
    mediaItems: [media],
    tags:
      d.channel === "youtube" && copy.meta.youtube_tags
        ? copy.meta.youtube_tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
        : [],
    metadata: {
      calendarId: d.calendar_id,
      storyId: d.story_id,
      deliveryId: d.id,
      textFingerprint: s.text.fingerprint,
      videoFingerprint: s.video.fingerprint,
    },
  };
}
/** The one image of the Story approved for Instagram at its current bytes, besides the shared video: its Reel cover. */
async function approvedReelCover(db: SupabaseClient, storyId: string, videoId: string) {
  const images = must(await db.from("gtm_story_assets").select("id,sha256,storage_path").eq("story_id", storyId).eq("kind", "image").neq("id", videoId), "Reel cover candidates") as { id: string; sha256: string; storage_path: string | null }[];
  if (!images.length) return null;
  const rows = must(await db.from("gtm_story_asset_channels").select("asset_id,status,approved_sha256").eq("channel", "instagram").in("asset_id", images.map((i) => i.id)), "Reel cover approvals") as { asset_id: string; status: string; approved_sha256: string | null }[];
  const approved = images.filter((i) => i.storage_path && rows.some((r) => r.asset_id === i.id && r.status === "approved" && r.approved_sha256 === i.sha256));
  return approved.length === 1 ? (approved[0] as { id: string; sha256: string; storage_path: string }) : null;
}
const slotExpired = (d: Pick<PieceDelivery, "slot_date" | "slot_time" | "timezone">, zonedToUtc: (date: string, time: string, tz: string) => Date) =>
  zonedToUtc(d.slot_date, d.slot_time.slice(0, 5), d.timezone).getTime() < Date.now() + 30 * 60_000;

/** Upload work can be reclaimed; a committed outbound attempt is never blindly re-created. */
export async function sendPieceDelivery(
  db: SupabaseClient,
  id: string,
  cal: Calendar,
  options: { retry?: boolean; provider?: Partial<Provider> } = {},
): Promise<PieceDelivery | null> {
  const p = { ...provider, ...options.provider };
  let d = must(
    await db.rpc("gtm_claim_piece_delivery", {
      p_id: id,
      p_retry: options.retry === true,
    }),
    "claim channel delivery",
  ) as PieceDelivery | null;
  if (!d) return null;
  let started = false,
    knownId = d.provider_id;
  try {
    // A known provider failure is retried in place, preserving its identity and every other channel.
    if (d.provider_id) {
      const observed = await p.get(d.provider_id),
        outcome = deliveryOutcome(d, observed);
      if (outcome.state !== "failed") return await recordPost(db, d, observed);
      d = must(
        await db.rpc("gtm_start_piece_send", {
          p_id: d.id,
          p_token: d.claim_token,
          p_request: d.request,
        }),
        "start provider retry",
      ) as PieceDelivery;
      started = true;
      const r = await p.retry(d.provider_id!);
      if (!r.post?._id)
        throw new Error("Provider retry returned no verified post");
      return await recordPost(db, d, r.post);
    }
    // Never let a recovered prepared upload turn an expired schedule into immediate publication. Checked before any
    // upload, so an expired slot never streams a master to the provider for nothing (review #151 N10).
    const { zonedToUtc } = await import("./calendar");
    if (slotExpired(d, zonedToUtc))
      throw new Error(
        "Reserved slot expired. Reconcile and move this unsent delivery before retrying.",
      );
    const request = d.request ?? (await frozenRequest(db, d, cal, p));
    if (slotExpired(d, zonedToUtc))
      throw new Error(
        "Reserved slot expired while the media uploaded. Reconcile and move this unsent delivery before retrying.",
      );
    d = must(
      await db.rpc("gtm_start_piece_send", {
        p_id: d.id,
        p_token: d.claim_token,
        p_request: request,
      }),
      "persist provider request",
    ) as PieceDelivery;
    started = true;
    const created = await p.create(
      request,
      `gtm-delivery-${d.id}-${d.claim_token}`,
      { timeoutMs: 120_000, retry429: false },
    );
    if (!created.post?._id)
      throw new Error("Provider returned no post id; reconciliation required");
    knownId = created.post._id;
    return await recordPost(db, d, created.post);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    // A never-sent delivery whose frozen versions are no longer the approved ones is not a failure: the scheduler
    // releases it and prepares the current approved versions (or shows the blocker).
    if (!started && PIECE_CHANGED.test(detail)) throw e;
    // Only a known rejection is retryable. A 429 is one: the provider refused before creating anything (review #151 B1).
    // 409, 5xx and lost responses stay uncertain until reconciliation or recoverUncertainDelivery settles them.
    const rejected =
      e instanceof ZernioError &&
      [400, 401, 402, 403, 404, 413, 415, 429].includes(e.status);
    try {
      return await record(
        db,
        d,
        started && !rejected ? "uncertain" : "failed",
        knownId,
        null,
        detail,
      );
    } catch {
      throw new Error(
        `Delivery outcome could not be saved. Reconcile ${d.id} before retrying.`,
      );
    }
  }
}
/** The ledger's refusal for a never-sent delivery whose piece changed since it was prepared. */
export const PIECE_CHANGED = /the piece changed since this delivery was prepared/;
/** A provider post that no longer exists or was cancelled at Zernio cannot be retried in place; it is replaced. */
export const DEAD_POST = "no longer exists at Zernio or was cancelled there; replace it from the piece's card (gtm piece replace";

/** Provider reads are isolated per channel; a timeout cannot hide later outcomes. */
export async function reconcilePieceDeliveries(
  db: SupabaseClient,
  options: { storyId?: string; provider?: Partial<Provider> } = {},
) {
  const p = { ...provider, ...options.provider },
    rows = await loadPieceDeliveries(db, options.storyId),
    result: PieceDelivery[] = [];
  for (const d of rows) {
    if (
      (d.state === "published" && d.publication_url) ||
      (d.state === "failed" && !d.provider_id) ||
      d.state === "prepared" ||
      d.state === "uploading" ||
      !d.claim_token
    ) {
      result.push(d);
      continue;
    }
    try {
      let post: ZPost | null;
      try {
        post = d.provider_id ? await p.get(d.provider_id) : await p.find(d.id);
      } catch (e) {
        // Deleted at Zernio: the outcome is known (nothing will go out), and the card offers the replacement.
        if (d.provider_id && e instanceof ZernioError && e.status === 404 && d.state !== "published") {
          result.push(await record(db, d, "failed", d.provider_id, null, `Zernio post ${d.provider_id} ${DEAD_POST} ${d.id})`));
          continue;
        }
        throw e;
      }
      if (!post) {
        result.push(
          await record(
            db,
            d,
            d.state === "sending" ? "uncertain" : d.state,
            d.provider_id,
            null,
            "Provider outcome is unverified. No new post will be created.",
          ),
        );
        continue;
      }
      if (!d.provider_id && post.metadata?.deliveryId !== d.id)
        throw new Error("Provider metadata does not match this delivery");
      const outcome = deliveryOutcome(d, post);
      // A recent uncertain retry may still be executing at the provider. Do not reopen its retry gate.
      if (
        outcome.state === "failed" &&
        ["sending", "uncertain"].includes(d.state) &&
        d.claimed_at &&
        Date.now() - Date.parse(d.claimed_at) < 120_000
      ) {
        result.push(
          await record(
            db,
            d,
            "uncertain",
            d.provider_id,
            null,
            "Provider attempt may still be running; reconciliation will check again.",
          ),
        );
        continue;
      }
      if (post.status === "cancelled" && d.provider_id && d.state !== "published") {
        result.push(await record(db, d, "failed", d.provider_id, null, `Zernio post ${d.provider_id} ${DEAD_POST} ${d.id})`));
        continue;
      }
      result.push(await recordPost(db, d, post));
    } catch (e) {
      result.push(
        await record(
          db,
          d,
          d.state === "sending" ? "uncertain" : d.state,
          d.provider_id,
          null,
          `Reconciliation unavailable: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
    }
  }
  return result;
}

/** How an operator action on one channel delivery ended, in plain words for the card and the CLI. */
export type RecoveryOutcome = { delivery: PieceDelivery | null; action: "found" | "resent" | "resolved" | "released"; detail: string };

/**
 * The way out of `uncertain` (review #151 B1): an uncertain delivery with no provider id is never left without an action.
 * 1. A complete metadata scan of the provider finds the post: its outcome is recorded (no new post).
 * 2. Not found and still inside the provider's idempotency window: the frozen request is re-sent with the same
 *    idempotency key, so the provider returns the original if it exists and otherwise creates it exactly once.
 * 3. Not found and past the window: the scan is recorded as evidence and the delivery becomes failed; the existing retry
 *    in place then sends it with a new key (gtm_resolve_uncertain_delivery, then gtm_claim_piece_delivery retry).
 */
export async function recoverUncertainDelivery(
  db: SupabaseClient,
  id: string,
  cal: Calendar,
  options: { provider?: Partial<Provider & { scan: typeof scanDeliveryPost }> } = {},
): Promise<RecoveryOutcome> {
  const p = { ...provider, scan: scanDeliveryPost, ...options.provider };
  const d = (await loadPieceDeliveries(db)).find((row) => row.id === id);
  if (!d) throw new Error("Delivery not found");
  if (d.state !== "uncertain" || d.provider_id)
    throw new Error(`Only an uncertain delivery with no provider post needs recovery (this one is ${d.state}${d.provider_id ? ", with a provider post" : ""}); reconcile it instead`);
  const scan = await p.scan(d.id);
  if (scan.post) {
    if (scan.post.metadata?.deliveryId !== d.id) throw new Error("Provider metadata does not match this delivery");
    return { delivery: await recordPost(db, d, scan.post), action: "found", detail: `Found the post at the provider (${scan.post._id}); recorded its outcome without sending again.` };
  }
  // A same-key re-send skips the approval re-check (website #221-10): if John changed or withdrew the piece since this
  // attempt, never re-send the old text; record the verified absence instead, so the retry re-checks approval.
  const { loadPieceReview } = await import("./piece-review");
  const now = await loadPieceReview(db, d.story_id);
  const changed = !now || now.text.status !== "approved" || now.video.status !== "approved"
    || now.text.fingerprint !== d.review_snapshot.text.fingerprint || now.video.fingerprint !== d.review_snapshot.video.fingerprint;
  const resend = changed ? { error: { message: "piece changed: idempotency window has passed for this version" } } : await db.rpc("gtm_resend_uncertain_delivery", { p_id: d.id, p_token: d.claim_token });
  if (!resend.error) {
    const sending = resend.data as PieceDelivery;
    try {
      const created = await p.create(sending.request!, `gtm-delivery-${sending.id}-${sending.claim_token}`, { timeoutMs: 120_000, retry429: false });
      if (!created.post?._id) throw new Error("Provider returned no post id; reconciliation required");
      return { delivery: await recordPost(db, sending, created.post), action: "resent", detail: "Sent again with the same idempotency key: the provider created it once (or returned the original)." };
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      const rejected = e instanceof ZernioError && [400, 401, 402, 403, 404, 413, 415, 429].includes(e.status);
      return { delivery: await record(db, sending, rejected ? "failed" : "uncertain", null, null, detail), action: "resent", detail: rejected ? `The provider refused it (${detail}); retry it now.` : `Still unverified (${detail}); recover again in a few minutes.` };
    }
  }
  if (!/idempotency window has passed/.test(resend.error.message)) throw new Error(`Re-send refused: ${resend.error.message}`);
  const evidence = `complete Zernio metadata scan (${scan.pages} page${scan.pages === 1 ? "" : "s"}, ${scan.scanned} posts, includeHidden) found no post with deliveryId ${d.id}`;
  const r = await db.rpc("gtm_resolve_uncertain_delivery", { p_id: d.id, p_evidence: evidence });
  if (r.error && /too recent/.test(r.error.message)) return { delivery: d, action: "resolved", detail: "The piece changed since this attempt, so it is not sent again. Zernio has no post for it yet; the last request is under 15 minutes old, so recover again shortly to mark it failed." };
  const resolved = must(r, "resolve uncertain delivery") as PieceDelivery;
  return { delivery: resolved, action: "resolved", detail: `Verified absent at the provider and marked failed; retry it to send it once. Evidence: ${evidence}.` };
}

/** Frees the channel/day of a delivery that never reached the provider; its calendar row returns to drafted. */
export async function releaseUnsentDelivery(db: SupabaseClient, id: string): Promise<RecoveryOutcome> {
  const r = must(await db.rpc("gtm_release_piece_delivery", { p_id: id }), "release unsent delivery") as { channel: string; slotDate: string };
  return { delivery: null, action: "released", detail: `Released the ${r.channel} slot on ${r.slotDate}; the post is back to drafted and the day is free.` };
}

/**
 * Replace a provider post that was cancelled or deleted at Zernio (website #221 gtm_retire_piece_delivery). The provider
 * is read first: only a 404 or a cancelled post is retired, with that read as the evidence; a live or failed-but-retryable
 * post is refused (retry it in place). The channel is then free for a fresh delivery of the current approved versions.
 */
export async function retireDeadDelivery(db: SupabaseClient, id: string, options: { provider?: Partial<Provider> } = {}): Promise<RecoveryOutcome> {
  const p = { ...provider, ...options.provider };
  const d = (await loadPieceDeliveries(db)).find((row) => row.id === id);
  if (!d) throw new Error("Delivery not found");
  if (!d.provider_id || !["failed", "uncertain"].includes(d.state)) throw new Error(`Only a failed or uncertain delivery with a Zernio post can be replaced (this one is ${d.state}${d.provider_id ? "" : ", with no Zernio post: retry or release it"})`);
  let evidence: string;
  try {
    const post = await p.get(d.provider_id);
    if (post.status !== "cancelled") throw new Error(`Zernio still has post ${d.provider_id} (${post.status}); retry it in place instead of replacing it`);
    evidence = `GET /posts/${d.provider_id} at ${new Date().toISOString()} reports status cancelled`;
  } catch (e) {
    if (!(e instanceof ZernioError && e.status === 404)) throw e;
    evidence = `GET /posts/${d.provider_id} at ${new Date().toISOString()} returned 404 (deleted at Zernio)`;
  }
  // The ledger retires only a failed delivery: an uncertain one is first settled by this provider read.
  if (d.state === "uncertain") await record(db, d, "failed", d.provider_id, null, `Zernio post ${d.provider_id} ${DEAD_POST} ${d.id}): ${evidence}`);
  must(await db.rpc("gtm_retire_piece_delivery", { p_id: d.id, p_evidence: evidence }), "retire dead provider post");
  return { delivery: null, action: "released", detail: `Retired the dead ${d.channel} post (${evidence}); the channel schedules again from the current approved versions.` };
}

/**
 * A retired provider post is read for 14 days more (website #221): if Zernio reports it scheduled or published again,
 * the provider resurrected a post the ledger let go of. That is an alert for John, never an action: the channel may now
 * go out twice. Returns one line per resurrected post; a read that fails is retried on the next run.
 */
export type RetiredAlert = { storyId: string; channel: string; providerId: string; message: string };
export async function retiredPostAlerts(db: SupabaseClient, options: { provider?: Partial<Provider>; now?: Date } = {}): Promise<RetiredAlert[]> {
  const p = { ...provider, ...options.provider };
  const since = new Date((options.now ?? new Date()).getTime() - 14 * 86_400_000).toISOString();
  const rows = await readPages<{ id: string; story_id: string; channel: string; provider_id: string | null }>((from, to) =>
    db.from("gtm_piece_delivery_attempts").select("id,story_id,channel,provider_id", { count: "exact" }).gt("retired_at", since).not("provider_id", "is", null).order("id").range(from, to), "retired provider posts");
  const alerts: RetiredAlert[] = [];
  for (const r of rows) {
    try {
      const post = await p.get(r.provider_id!);
      if (["scheduled", "published", "publishing"].includes(post.status) && !alerts.some((a) => a.providerId === r.provider_id))
        alerts.push({ storyId: r.story_id, channel: r.channel, providerId: r.provider_id!, message: `${r.story_id} ${r.channel}: retired Zernio post ${r.provider_id} reports ${post.status} again; check it at Zernio before the replacement goes out` });
    } catch (e) {
      if (!(e instanceof ZernioError && e.status === 404)) continue;
    }
  }
  return alerts;
}

/**
 * Puts each resurrected-post alert where John looks: a blocked job on the work board (/work, and the work line on
 * /content), one per post, never repeated while it is open. Nothing about the delivery or the post is changed.
 */
export async function raiseRetiredAlerts(db: SupabaseClient, alerts: RetiredAlert[]): Promise<number> {
  let raised = 0;
  for (const a of alerts) {
    const title = `Zernio brought back retired post ${a.providerId} (${a.channel})`.slice(0, 200);
    const open = must(await db.from("gtm_work_items").select("id").eq("title", title).neq("status", "done").limit(1), "open delivery alerts") as { id: string }[];
    if (open.length) continue;
    must(await db.from("gtm_work_items").insert({ story_id: a.storyId, title, status: "blocked", agent: "delivery-watch", blocked_reason: a.message.slice(0, 1000) }), "raise delivery alert");
    raised++;
  }
  return raised;
}
