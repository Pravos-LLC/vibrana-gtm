"use server";

import { revalidatePath } from "next/cache";
import { adminDb } from "@/lib/db";
import { editCandidate, REJECT_REASONS, rejectCandidate, sendToReview, type RejectReason } from "@/lib/candidates/store";
import { EDITABLE, type Editable } from "@/lib/candidates/validate";
import { sessionDb } from "@/lib/supabase/server";

export type CandidateResult =
  | { ok: true; status: string; gtm_story_id?: string | null; updated_at?: string; value?: unknown; warnings?: string[] }
  | { ok: false; error: string };

/** Owner only: the gtm_owner claim is checked here, then the write uses the service client (the browser role cannot write gtm_* tables). */
async function owner(): Promise<string | null> {
  const session = await sessionDb();
  const { data } = await session.auth.getClaims();
  const claims = data?.claims as { email?: string; app_metadata?: { gtm_owner?: boolean } } | undefined;
  return claims?.app_metadata?.gtm_owner === true ? claims.email ?? "owner" : null;
}
const fail = (e: unknown, fallback: string): CandidateResult => ({ ok: false, error: e instanceof Error ? e.message : fallback });

/**
 * Send to Review: stage the candidate as a Story with drafted calendar items (the same writer as
 * `gtm story stage`) so it appears in /content, and mark its signal drafted. Claimed once: a second click
 * finds it already accepted. Nothing is approved or scheduled.
 */
export async function sendCandidateToReview(id: string): Promise<CandidateResult> {
  const actor = await owner();
  if (!actor) return { ok: false, error: "Only the cockpit owner decides candidates." };
  try {
    const r = await sendToReview(adminDb(), id, actor);
    revalidatePath("/signals");
    revalidatePath("/content");
    revalidatePath("/");
    return { ok: true, status: r.status, gtm_story_id: r.gtm_story_id };
  } catch (e) {
    return fail(e, "Could not send it to review.");
  }
}

/** Edit one field inline. Stored next to the agent's frozen draft, so John's change is voice signal. */
export async function editCandidateField(id: string, field: Editable, value: string, expectedUpdatedAt: string): Promise<CandidateResult> {
  const actor = await owner();
  if (!actor) return { ok: false, error: "Only the cockpit owner edits candidates." };
  if (!(EDITABLE as readonly string[]).includes(field)) return { ok: false, error: "That part cannot be edited here." };
  try {
    const r = await editCandidate(adminDb(), id, field, value, actor, expectedUpdatedAt);
    revalidatePath("/signals");
    return { ok: true, status: r.row.status, updated_at: r.row.updated_at, value: r.row[field], warnings: r.warnings };
  } catch (e) {
    return fail(e, "Could not save the edit.");
  }
}

/** Reject with a reason; the reason is also a taste label on the candidate's signal. */
export async function rejectCandidateAction(id: string, reason: RejectReason, note: string): Promise<CandidateResult> {
  const actor = await owner();
  if (!actor) return { ok: false, error: "Only the cockpit owner decides candidates." };
  if (!REJECT_REASONS.some((r) => r.slug === reason)) return { ok: false, error: "Pick a reason." };
  try {
    const r = await rejectCandidate(adminDb(), id, reason, note, actor);
    revalidatePath("/signals");
    revalidatePath("/");
    return { ok: true, status: r.status };
  } catch (e) {
    return fail(e, "Could not reject it.");
  }
}
