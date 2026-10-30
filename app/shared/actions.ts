"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { sessionDb } from "@/lib/supabase/server";
import { adminDb } from "@/lib/db";
import { parsePieceTitle } from "@/lib/season";
import { scheduleApproved } from "@/lib/schedule-approved";
import { validToken } from "@/lib/reviewer/access";
import { tokenSha256 } from "@/lib/reviewer/invites";
import { notifyJohn, type ReviewerEvent } from "@/lib/reviewer/notify";

type Result = { ok: true } | { ok: false; error: string };

// Every write here runs as the reviewer's own session: the database functions (gtm_reviewer_*) check their claimed,
// unrevoked invite and the piece's third party, so nothing in this file grants access by itself.

function tell(
  storyId: string,
  kind: ReviewerEvent["kind"],
  note: string,
  party: string,
) {
  after(async () => {
    try {
      const { data } = await adminDb()
        .from("gtm_stories")
        .select("title")
        .eq("id", storyId)
        .maybeSingle();
      await notifyJohn({
        party,
        piece: parsePieceTitle(data?.title ?? storyId).name,
        storyId,
        kind,
        note,
      });
    } catch (error) {
      console.error(
        `review link notify ${storyId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
}

const message = (e: { message: string; code?: string }) =>
  e.code === "PT409"
    ? "A new version arrived while you were watching. Refresh the page to see it."
    : e.code === "42501"
      ? "This piece is not shared with you. Refresh the page."
      : e.code === "P0429"
        ? "That is a lot of notes in one hour. Please try again a little later."
        : e.message || "Not saved.";

/**
 * A third party's decision on ONE asset (the video, an image or a platform's listing): approve it, ask for changes, or leave a
 * note. Bound to the exact bytes on screen. Nothing here queues agent work: the decision lands in
 * gtm_reviewer_asset_decisions (John reads it; `gtm reviewer notes`), and John is emailed. The Story's third-party sign-off
 * is written by the database once every asset is approved on its current bytes; that release schedules what John approved.
 */
export async function decideAsset(input: {
  assetId: string;
  decision: "approved" | "changes" | "note";
  note: string;
  sha256: string;
  revision: number;
}): Promise<Result> {
  const note = input.note.trim();
  if (!["approved", "changes", "note"].includes(input.decision))
    return { ok: false, error: "Unknown decision." };
  if (input.decision !== "approved" && !note)
    return {
      ok: false,
      error:
        input.decision === "changes"
          ? "Say what you would like changed."
          : "Write your note first.",
    };
  if (note.length > 5000)
    return { ok: false, error: "Notes are limited to 5000 characters." };
  const db = await sessionDb();
  const selected = await adminDb()
    .from("gtm_story_assets")
    .select("metadata")
    .eq("id", input.assetId)
    .maybeSingle();
  if (selected.error)
    return { ok: false, error: "Review scope unavailable. Refresh to retry." };
  const { error } = await db.rpc(
    selected.data?.metadata?.shared_review === true
      ? "gtm_reviewer_decide_piece_video"
      : "gtm_reviewer_decide_asset",
    {
      p_asset_id: input.assetId,
      p_decision: input.decision,
      p_note: note,
      p_sha256: input.sha256,
      p_revision: input.revision,
    },
  );
  if (error) return { ok: false, error: message(error) };
  const admin = adminDb();
  const { data: asset } = await admin
    .from("gtm_story_assets")
    .select("story_id,title")
    .eq("id", input.assetId)
    .maybeSingle();
  if (asset?.story_id) {
    if (input.decision === "approved") scheduleApproved(asset.story_id); // a no-op until the Story's hold is released by the last approval
    const { data: story } = await admin
      .from("gtm_stories")
      .select("third_party_who")
      .eq("id", asset.story_id)
      .maybeSingle();
    tell(
      asset.story_id,
      input.decision,
      input.decision === "approved" ? asset.title : `${asset.title}: ${note}`,
      story?.third_party_who ?? "Your reviewer",
    );
  }
  revalidatePath("/shared");
  return { ok: true };
}

/**
 * The same decision from the review link itself, with no login (John, 2026-10-15: the link is the credential). The database
 * (gtm_reviewer_decide_asset_by_link, service role only) checks the link's hash names an unrevoked, unexpired invite and that
 * the asset belongs to that party's piece, then records it exactly as decideAsset does.
 */
export async function decideAssetByLink(
  token: string,
  input: {
    assetId: string;
    decision: "approved" | "changes" | "note";
    note: string;
    sha256: string;
    revision: number;
  },
): Promise<Result> {
  const note = input.note.trim();
  if (!validToken(token))
    return { ok: false, error: "This link is no longer valid." };
  if (!["approved", "changes", "note"].includes(input.decision))
    return { ok: false, error: "Unknown decision." };
  if (input.decision !== "approved" && !note)
    return {
      ok: false,
      error:
        input.decision === "changes"
          ? "Say what you would like changed."
          : "Write your note first.",
    };
  if (note.length > 5000)
    return { ok: false, error: "Notes are limited to 5000 characters." };
  const admin = adminDb();
  const selected = await admin
    .from("gtm_story_assets")
    .select("metadata")
    .eq("id", input.assetId)
    .maybeSingle();
  if (selected.error)
    return { ok: false, error: "Review scope unavailable. Refresh to retry." };
  const { error } = await admin.rpc(
    selected.data?.metadata?.shared_review === true
      ? "gtm_reviewer_decide_piece_video"
      : "gtm_reviewer_decide_asset_by_link",
    {
      p_token_sha256: tokenSha256(token),
      p_asset_id: input.assetId,
      p_decision: input.decision,
      p_note: note,
      p_sha256: input.sha256,
      p_revision: input.revision,
    },
  );
  if (error) return { ok: false, error: message(error) };
  const { data: asset } = await admin
    .from("gtm_story_assets")
    .select("story_id,title")
    .eq("id", input.assetId)
    .maybeSingle();
  if (asset?.story_id) {
    if (input.decision === "approved") scheduleApproved(asset.story_id);
    const { data: story } = await admin
      .from("gtm_stories")
      .select("third_party_who")
      .eq("id", asset.story_id)
      .maybeSingle();
    tell(
      asset.story_id,
      input.decision,
      input.decision === "approved" ? asset.title : `${asset.title}: ${note}`,
      story?.third_party_who ?? "Your reviewer",
    );
  }
  revalidatePath("/invite/[token]", "page");
  return { ok: true };
}
