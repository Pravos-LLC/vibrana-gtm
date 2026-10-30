"use server";

import { adminDb } from "@/lib/db";
import { approveComment, hideCommentRow, markCopied, markNotSpam, skipComment } from "@/lib/engage/actions";
import { addLesson, learnFromDecisions, retireLesson } from "@/lib/engage/learn";
import { resolveFlag } from "@/lib/engage/resolve";
import { sessionDb } from "@/lib/supabase/server";

type Result = { ok: true; status: string; message: string } | { ok: false; error: string };

/** The owner only: the claim is checked here, the write uses the service client (RLS is read-only). */
async function owner(): Promise<string | null> {
  const session = await sessionDb();
  const { data } = await session.auth.getClaims();
  const claims = data?.claims as { email?: string; app_metadata?: { gtm_owner?: boolean } } | undefined;
  return claims?.app_metadata?.gtm_owner === true ? claims.email ?? "owner" : null;
}

async function act<R extends { ok: boolean }>(fn: (actor: string) => Promise<R | { ok: false; error: string }>): Promise<R | { ok: false; error: string }> {
  const actor = await owner();
  if (!actor) return { ok: false, error: "Not signed in as the cockpit owner." };
  try {
    // No revalidatePath: the card collapses in place to "Sent" / "Skipped", so John sees each decision
    // land; the next visit reloads the queue.
    return await fn(actor);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Something went wrong." };
  }
}

/** Sends the reply through Zernio (Idempotency-Key gtm-reply-<id>-<text hash>). */
export async function approveReply(id: string, text: string) {
  return act((actor) => approveComment(adminDb(), id, String(text ?? ""), actor));
}

/** LinkedIn email cards: John copied the reply and opened the comment to paste it himself. */
export async function markReplyCopied(id: string, text: string) {
  return act((actor) => markCopied(adminDb(), id, String(text ?? ""), actor));
}

export async function skipReply(id: string) {
  return act((actor) => skipComment(adminDb(), id, actor));
}

export async function hideReply(id: string) {
  return act((actor) => hideCommentRow(adminDb(), id, actor));
}

/** The agent called it spam and John says it is not: back in the queue, drafted again now. */
export async function notSpam(id: string) {
  return act((actor) => markNotSpam(adminDb(), id, actor));
}

export async function retireEngageLesson(id: string) {
  return act(async (actor) => (await retireLesson(adminDb(), id, actor)) ? { ok: true as const, status: "retired", message: "Retired." } : { ok: false as const, error: "Already retired." });
}

export async function addEngageLesson(kind: string, text: string) {
  return act(async () => {
    await addLesson(adminDb(), kind === "classification" ? "classification" : "voice", String(text ?? ""));
    return { ok: true as const, status: "added", message: "Added. The next drafts use it." };
  });
}

/** Runs the learning pass now over John's decisions since the last one. */
export async function learnNow() {
  return act(async (actor) => {
    const r = await learnFromDecisions(adminDb(), { actor, deadline: Date.now() + 55_000 });
    return { ok: true as const, status: "learned", message: r.skipped ? "Nothing new to learn from since the last run." : `Read ${r.signals} decisions: ${r.added.length} new lessons, ${r.kept} kept, ${r.retired.length} retired${r.held.length ? `, ${r.held.length} kept anyway (a run retires at most half)` : ""}${r.more ? ". More decisions are waiting: run it again" : ""}.` };
  });
}

/** Closes a red flag with an optional note; the note also teaches the classifier (lib/engage/resolve.ts). */
export async function resolveRedFlag(postKey: string, note: string) {
  return act(async (actor) => {
    const r = await resolveFlag(adminDb(), String(postKey ?? ""), String(note ?? ""), actor);
    return r.ok ? { ok: true as const, status: "resolved", message: r.lesson ? "Resolved. The model will use your note." : "Resolved." } : r;
  });
}
