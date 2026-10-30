"use server";
import { sessionDb } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import {
  loadPieceReview,
  pieceCandidates,
  configurePieceReview,
  decidePiecePart,
  savePieceText,
  sharedDeliveryInstalled,
  type SharedPart,
  type SharedDecision,
  type PieceReviewSnapshot,
} from "@/lib/piece-review";
import { writeCopy } from "@/lib/season";
import { scheduleApproved } from "@/lib/schedule-approved";
import { must, adminDb } from "@/lib/db";
type Result =
  | { snapshot: PieceReviewSnapshot; notice?: string; error?: never }
  | { error: string; snapshot?: never; notice?: never };
async function owner() {
  const db = await sessionDb(),
    { data, error } = await db.auth.getUser();
  if (error || data.user?.app_metadata?.gtm_owner !== true)
    throw new Error("Sign in as the cockpit owner.");
  return db;
}
export async function sharedDecision(input: {
  storyId: string;
  part: SharedPart;
  decision: SharedDecision;
  note: string;
  fingerprint: string;
  revision: number;
}): Promise<Result> {
  try {
    const db = await owner();
    const snapshot = await decidePiecePart(db, input);
    revalidatePath("/content");
    // Only a deployment with the shared dispatcher schedules a shared piece; the card names the blocker otherwise.
    if (snapshot.ready && (await sharedDeliveryInstalled(db)).ok) scheduleApproved(input.storyId);
    return { snapshot };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
export async function sharedText(input: {
  storyId: string;
  prose: string;
  title: string;
  firstComment: string;
  fingerprint: string;
  revision: number;
}): Promise<Result> {
  try {
    const db = await owner(),
      current = await loadPieceReview(db, input.storyId);
    if (!current) throw new Error("Piece not found.");
    const body = writeCopy(current.text.asset.body ?? "", input.prose, {
      youtube_title: input.title,
      first_comment: input.firstComment,
    });
    const snapshot = await savePieceText(db, { ...input, body });
    revalidatePath("/content");
    return { snapshot };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
export async function adoptShared(input: {
  storyId: string;
  textId: string;
  videoId: string;
  textFingerprint: string;
  videoFingerprint: string;
  channels: string[];
}): Promise<Result> {
  try {
    const db = await owner();
    // Adoption takes a piece off channel publishing: never before shared delivery can publish it (review #147 B2).
    const delivery = await sharedDeliveryInstalled(db);
    if (!delivery.ok) throw new Error(`Shared delivery is not installed: ${delivery.reason}.`);
    const choices = await pieceCandidates(db, input.storyId),
      text = choices.find((c) => c.asset.id === input.textId),
      video = choices.find((c) => c.asset.id === input.videoId);
    if (
      !text ||
      !video ||
      text.fingerprint !== input.textFingerprint ||
      video.fingerprint !== input.videoFingerprint
    )
      throw new Error("Assets changed. Reload before selecting.");
    const snapshot = await configurePieceReview(db, {
      storyId: input.storyId,
      text,
      video,
      channels: input.channels,
    });
    revalidatePath("/content");
    return { snapshot };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
export async function convertLegacyNote(input: {
  storyId: string;
  feedbackId: string;
  part: SharedPart;
  fingerprint: string;
  revision: number;
}): Promise<Result> {
  try {
    const db = await owner(),
      snapshot = must(
        await db.rpc("gtm_convert_piece_legacy_fix", {
          p_story_id: input.storyId,
          p_feedback_id: input.feedbackId,
          p_part: input.part,
          p_expected_fingerprint: input.fingerprint,
          p_expected_revision: input.revision,
        }),
        "convert legacy note",
      ) as PieceReviewSnapshot;
    revalidatePath("/content");
    return { snapshot: (await loadPieceReview(db, input.storyId)) ?? snapshot };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export async function retrySharedChannel(input: {
  storyId: string;
  deliveryId: string;
}): Promise<Result> {
  try {
    await owner();
    const db = adminDb(),
      rows = await (
        await import("@/lib/piece-delivery")
      ).loadPieceDeliveries(db, input.storyId);
    if (!rows.some((d) => d.id === input.deliveryId))
      throw new Error("Channel delivery does not belong to this piece");
    await (
      await import("@/lib/piece-schedule")
    ).retryPieceDelivery(db, input.deliveryId);
    const snapshot = await loadPieceReview(db, input.storyId);
    if (!snapshot) throw new Error("Piece not found");
    revalidatePath("/content");
    return { snapshot };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Resume or pause scheduling for a shared piece without a new content decision (an imported piece whose approvals
 * carried over needs no second Approve). Resuming names the versions on screen; pausing always works.
 */
export async function setSharedDispatch(input: {
  storyId: string;
  enabled: boolean;
  textFingerprint: string;
  videoFingerprint: string;
}): Promise<Result> {
  try {
    const db = await owner();
    must(
      await db.rpc("gtm_set_piece_dispatch", {
        p_story_id: input.storyId,
        p_expected: input.enabled ? { text: input.textFingerprint, video: input.videoFingerprint } : null,
        p_enabled: input.enabled,
      }),
      "set scheduling",
    );
    // Reload through loadPieceReview so the card keeps its channel deliveries.
    const snapshot = await loadPieceReview(db, input.storyId);
    if (!snapshot) throw new Error("Piece not found");
    revalidatePath("/content");
    if (input.enabled && snapshot.ready && (await sharedDeliveryInstalled(db)).ok) scheduleApproved(input.storyId);
    return { snapshot };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export type ReleaseResult = { storyId: string; released: boolean; textApprovalKept: boolean; videoApprovalKept: boolean };
/**
 * Leave shared review: the piece goes back to per-platform review. A platform approval survives only where the shared
 * decision still approves those exact bytes; notes stay open. Refused while a shared delivery exists.
 */
export async function releaseShared(input: { storyId: string }): Promise<{ released: ReleaseResult; error?: never } | { error: string; released?: never }> {
  try {
    const db = await owner();
    const released = must(await db.rpc("gtm_release_piece_review", { p_story_id: input.storyId }), "leave shared review") as ReleaseResult;
    revalidatePath("/content");
    return { released };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** The card's operator actions on one channel delivery run with the service key, after the owner check. */
async function ownDelivery(storyId: string, deliveryId: string) {
  await owner();
  const db = adminDb();
  const { loadPieceDeliveries } = await import("@/lib/piece-delivery");
  if (!(await loadPieceDeliveries(db, storyId)).some((d) => d.id === deliveryId)) throw new Error("Channel delivery does not belong to this piece");
  return db;
}

/**
 * "Check Zernio and recover" on an uncertain channel (review #151 B1): found at the provider (recorded), re-sent once with
 * the same idempotency key, or verified absent and marked failed so Retry sends it. Never a second post.
 */
export async function recoverSharedChannel(input: { storyId: string; deliveryId: string }): Promise<Result> {
  try {
    const db = await ownDelivery(input.storyId, input.deliveryId);
    const { recoverUncertainDelivery } = await import("@/lib/piece-delivery");
    const { loadCalendarDb } = await import("@/lib/calendar-db");
    const out = await recoverUncertainDelivery(db, input.deliveryId, await loadCalendarDb(db));
    const snapshot = await loadPieceReview(db, input.storyId);
    if (!snapshot) throw new Error("Piece not found");
    revalidatePath("/content");
    return { snapshot, notice: out.detail };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** "Release this slot" on a channel that never reached the provider: the day is free and the post back to drafted. */
export async function releaseSharedChannel(input: { storyId: string; deliveryId: string }): Promise<Result> {
  try {
    const db = await ownDelivery(input.storyId, input.deliveryId);
    const { releaseUnsentDelivery } = await import("@/lib/piece-delivery");
    const out = await releaseUnsentDelivery(db, input.deliveryId);
    const snapshot = await loadPieceReview(db, input.storyId);
    if (!snapshot) throw new Error("Piece not found");
    revalidatePath("/content");
    return { snapshot, notice: out.detail };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** Approve or take back a cover (or another image) of an adopted piece on every shared platform it is assigned to. */
export async function decideSharedCover(input: { storyId: string; assetId: string; sha256: string; revision: number; approve: boolean }): Promise<Result> {
  try {
    const db = await owner();
    const snapshot0 = await loadPieceReview(db, input.storyId);
    if (!snapshot0) throw new Error("Piece not found");
    if ([snapshot0.text.asset.id, snapshot0.video.asset.id].includes(input.assetId)) throw new Error("The shared text and video are decided above.");
    const rows = must(await db.from("gtm_story_asset_channels").select("channel").eq("asset_id", input.assetId).in("channel", snapshot0.channels), "cover channels") as { channel: string }[];
    for (const { channel } of rows) {
      must(await db.rpc("gtm_decide_story_asset", { p_asset_id: input.assetId, p_channel: channel, p_status: input.approve ? "approved" : "pending", p_note: "", p_expected_sha256: input.sha256, p_expected_revision: input.revision }), `decide cover for ${channel}`);
    }
    const snapshot = await loadPieceReview(db, input.storyId);
    if (!snapshot) throw new Error("Piece not found");
    revalidatePath("/content");
    return { snapshot, notice: input.approve ? "Cover approved. It goes out with the next delivery of this piece." : "Cover approval taken back." };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** "Replace the cancelled post": Zernio no longer has it, so the channel is retired and scheduled again. */
export async function replaceSharedChannel(input: { storyId: string; deliveryId: string }): Promise<Result> {
  try {
    const db = await ownDelivery(input.storyId, input.deliveryId);
    const { retireDeadDelivery } = await import("@/lib/piece-delivery");
    const out = await retireDeadDelivery(db, input.deliveryId);
    const snapshot = await loadPieceReview(db, input.storyId);
    if (!snapshot) throw new Error("Piece not found");
    if (snapshot.ready) scheduleApproved(input.storyId);
    revalidatePath("/content");
    return { snapshot, notice: snapshot.ready ? out.detail : `${out.detail} Not scheduled yet: ${snapshot.blockers.join("; ")}.` };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
