// What John does to a queued comment in /engage: approve (send through Zernio), copy and open (LinkedIn
// email intake, where only a human can reply), skip, or hide. Every send claims the row first, so a
// double tap cannot send twice, and carries Idempotency-Key gtm-reply-<row id>-<text hash> to Zernio.
import type { SupabaseClient } from "@supabase/supabase-js";
import { findAgentNotes } from "../copy-guard";
import { must } from "../db";
import { ZernioError } from "../zernio";
import { HIDE_PLATFORMS, dmWindowClosed, hideComment, replyIdempotencyKey, replyToComment, sendDirectMessage } from "../zernio-inbox";
import { replyCommentId, replyTarget, type StoredComment } from "./parse";
import { getComment, latestInboundAt } from "./store";
import type { ReplyWriter } from "./draft";

export const OPEN_STATUSES = ["new", "drafted", "failed"] as const;

/** How a card is answered: through Zernio, or by hand on the platform (copy the reply, open the comment). */
export function replyMode(c: Pick<StoredComment, "source" | "kind" | "account_id" | "zernio_post_id" | "platform_post_id" | "conversation_id">): "zernio" | "manual" {
  if (c.source === "email" || !c.account_id) return "manual";
  if (c.kind === "dm") return c.conversation_id ? "zernio" : "manual";
  return replyTarget(c) ? "zernio" : "manual";
}

export function canHide(c: Pick<StoredComment, "platform" | "kind" | "source" | "account_id" | "zernio_post_id" | "platform_post_id">): boolean {
  return c.kind === "comment" && c.source !== "email" && HIDE_PLATFORMS.has(c.platform) && Boolean(c.account_id && replyTarget(c));
}

/** Zernio errors in words John can act on. */
export function sendError(e: unknown, verb = "send"): string {
  if (e instanceof ZernioError && e.status === 409) return `Zernio is still processing the last attempt. Wait a moment, then try again.`;
  if (e instanceof ZernioError && e.status === 422) return `Zernio refused a changed retry of an earlier attempt. Reload, check the post, then try again.`;
  if (e instanceof Error && /timeout|aborted/i.test(e.name + e.message)) return `Zernio did not answer in 30 seconds. Check the post before trying again: it may have gone out.`;
  return `Zernio did not ${verb} it: ${(e as Error).message.slice(0, 400)}`;
}

/** After a lost claim, the row's current state in words (the pre-claim read is stale). */
async function alreadyHandled(db: SupabaseClient, id: string): Promise<string> {
  const now = await getComment(db, id).catch(() => null);
  return now ? `Already ${now.status === "approved" ? "being sent" : now.status} (another tap or device).` : "Already handled.";
}

/**
 * Why `text` cannot go out as John's reply, or null when it can. No dash check here: the no-dash rule is for
 * agent drafts (guardReply strips them before John sees a draft), so a dash in the text is one John typed
 * himself, for example inside a quote, and his text is his call (John, 2026-10-12).
 */
export function replyProblem(text: string): string | null {
  const t = text.trim();
  if (!t) return "The reply is empty.";
  if (t.length > 2000) return "The reply is longer than 2,000 characters.";
  const notes = findAgentNotes(t);
  if (notes.length) return `Fill in or delete ${notes[0].slice(0, 60)} first.`;
  return null;
}

type Result = { ok: true; status: StoredComment["status"]; message: string } | { ok: false; error: string };
type Deps = { reply?: typeof replyToComment; dm?: typeof sendDirectMessage; latest?: typeof latestInboundAt; hide?: typeof hideComment };

/**
 * Moves a row out of an open status in one conditional update, so two taps (or two devices) cannot both
 * act. A send interrupted mid-flight leaves the row `approved`; after two minutes it can be retried, and
 * the same Idempotency-Key makes Zernio replay rather than post twice.
 */
async function claim(db: SupabaseClient, id: string, from: readonly string[], patch: Record<string, unknown>) {
  const stale = new Date(Date.now() - 120_000).toISOString();
  const { data, error } = await db.from("gtm_comments").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id)
    .or(`status.in.(${from.join(",")}),and(status.eq.approved,acted_at.lt.${stale})`).select("id");
  if (error) throw new Error(error.message);
  return (data ?? []).length > 0;
}

/** Sends John's reply through Zernio. The final text is stored next to the agent's draft (voice signal). */
export async function approveComment(db: SupabaseClient, id: string, text: string, actor: string, deps: Deps = {}): Promise<Result> {
  const c = await getComment(db, id);
  if (!c) return { ok: false, error: "That comment is gone." };
  if (replyMode(c) === "manual") return { ok: false, error: "This one is answered on the platform: use Copy reply and open." };
  const problem = replyProblem(text);
  if (problem) return { ok: false, error: problem };
  // Meta's window runs from the person's newest message in the conversation, not from the row being answered.
  const lastInbound = c.kind === "dm" ? await (deps.latest ?? latestInboundAt)(db, c, c.commented_at) : c.commented_at;
  if (c.kind === "dm" && dmWindowClosed(c.platform, lastInbound)) {
    return { ok: false, error: "This DM is more than 7 days old. Meta only allows a reply inside 7 days of their last message, so answer it in the Instagram or Facebook app." };
  }
  const finalText = text.trim();
  if (!(await claim(db, id, OPEN_STATUSES, { status: "approved", final_text: finalText, acted_by: actor, acted_at: new Date().toISOString(), error: null }))) {
    return { ok: false, error: await alreadyHandled(db, id) };
  }
  try {
    let replyId: string | null;
    if (c.kind === "dm") {
      replyId = (await (deps.dm ?? sendDirectMessage)(c.conversation_id!, { accountId: c.account_id!, message: finalText, platform: c.platform, lastInboundAt: lastInbound }, replyIdempotencyKey(id, finalText))).messageId;
    } else {
      replyId = (await (deps.reply ?? replyToComment)(replyTarget(c)!, { accountId: c.account_id!, message: finalText, commentId: replyCommentId(c) }, replyIdempotencyKey(id, finalText))).commentId;
    }
    must(await db.from("gtm_comments").update({ status: "sent", sent_at: new Date().toISOString(), reply_external_id: replyId, updated_at: new Date().toISOString() }).eq("id", id), "mark sent");
    return { ok: true, status: "sent", message: "Sent." };
  } catch (e) {
    const msg = sendError(e);
    await db.from("gtm_comments").update({ status: "failed", error: msg.slice(0, 500), updated_at: new Date().toISOString() }).eq("id", id);
    return { ok: false, error: msg };
  }
}

/** A manual reply (LinkedIn email intake): John copied the text and opened the comment, so it counts as sent. */
export async function markCopied(db: SupabaseClient, id: string, text: string, actor: string): Promise<Result> {
  const c = await getComment(db, id);
  if (!c) return { ok: false, error: "That comment is gone." };
  if (replyMode(c) !== "manual") return { ok: false, error: "This one is sent through Zernio: use Approve and send." };
  const problem = replyProblem(text);
  if (problem) return { ok: false, error: problem };
  const ok = await claim(db, id, OPEN_STATUSES, { status: "sent", sent_at: new Date().toISOString(), final_text: text.trim(), acted_by: actor, acted_at: new Date().toISOString(), note: "replied by hand on the platform" });
  return ok ? { ok: true, status: "sent", message: "Marked sent. Paste it in LinkedIn." } : { ok: false, error: await alreadyHandled(db, id) };
}

export async function skipComment(db: SupabaseClient, id: string, actor: string): Promise<Result> {
  const ok = await claim(db, id, OPEN_STATUSES, { status: "skipped", acted_by: actor, acted_at: new Date().toISOString(), note: "skipped by John" });
  return ok ? { ok: true, status: "skipped", message: "Skipped." } : { ok: false, error: await alreadyHandled(db, id) };
}

type Redrafted = { ok: true; status: StoredComment["status"]; message: string; draft: string; classification: StoredComment["classification"]; reason: string | null } | { ok: false; error: string };

/**
 * John overrules the agent's spam label: the comment goes back to the queue as a real one and is drafted again
 * right away, with "not spam" passed to the model (it cannot label it spam again). The correction is kept in
 * reclassified_from, which the learning run reads. If the redraft fails the card still opens for John to write.
 */
export async function markNotSpam(db: SupabaseClient, id: string, actor: string, deps: { write?: ReplyWriter; draft?: typeof import("./run").draftNew } = {}): Promise<Redrafted> {
  const c = await getComment(db, id);
  if (!c) return { ok: false, error: "That comment is gone." };
  if (c.classification !== "spam") return { ok: false, error: "This one is not marked as spam." };
  const now = new Date().toISOString();
  // Back to `new` so draftNew picks it up. One conditional update on "still labeled spam and open" makes
  // exactly one of two racing taps win. stance_at is set so the webhook's red-flag claim leaves the row alone
  // while this redraft runs; reclassified_from makes every drafting path honor "not spam" (lib/engage/run.ts).
  const { data: won, error: claimError } = await db.from("gtm_comments").update({
    status: "new", classification: null, reclassified_from: "spam", stance: c.stance === "spam" ? null : c.stance ?? null, stance_at: now,
    acted_by: actor, acted_at: now, note: "John: not spam", error: null, updated_at: now,
  }).eq("id", id).eq("classification", "spam").in("status", ["drafted", "failed"]).select("id");
  if (claimError) throw new Error(claimError.message);
  if (!(won ?? []).length) return { ok: false, error: await alreadyHandled(db, id) };
  const fresh = (await getComment(db, id))!;
  let failure: string | null = null;
  try {
    const draftNew = deps.draft ?? (await import("./run")).draftNew;
    const r = await draftNew(db, { rows: [fresh], johnSays: { [id]: "this is not spam" }, write: deps.write, deadline: Date.now() + 55_000 });
    if (r.errors.length) failure = r.errors[0].error;
  } catch (e) {
    failure = (e as Error).message;
  }
  const after = await getComment(db, id);
  if (!after) return { ok: false, error: "That comment is gone." };
  if (after.status === "new") {
    // The redraft did not land: open the card for John to write it himself.
    must(await db.from("gtm_comments").update({ status: "drafted", classification: "needs_john", draft_reason: `Not spam (John). The redraft failed${failure ? `: ${failure.slice(0, 200)}` : ""}`, updated_at: new Date().toISOString() }).eq("id", id).eq("status", "new"), "open for John");
    return { ok: true, status: "drafted", message: "Marked not spam. The redraft failed, so write this one.", draft: "", classification: "needs_john", reason: "Not spam (John). The redraft failed." };
  }
  return { ok: true, status: after.status, message: "Marked not spam and redrafted.", draft: after.draft ?? "", classification: after.classification, reason: after.draft_reason };
}

/** Hides the comment on the platform (spam). Only where Zernio supports hiding. */
export async function hideCommentRow(db: SupabaseClient, id: string, actor: string, deps: Deps = {}): Promise<Result> {
  const c = await getComment(db, id);
  if (!c) return { ok: false, error: "That comment is gone." };
  if (!canHide(c)) return { ok: false, error: `${c.platform} comments cannot be hidden through Zernio. Skip it instead.` };
  if (!(await claim(db, id, OPEN_STATUSES, { status: "approved", acted_by: actor, acted_at: new Date().toISOString(), error: null }))) return { ok: false, error: await alreadyHandled(db, id) };
  try {
    await (deps.hide ?? hideComment)(replyTarget(c)!, c.external_id, c.account_id!);
    must(await db.from("gtm_comments").update({ status: "hidden", note: "hidden as spam", updated_at: new Date().toISOString() }).eq("id", id), "mark hidden");
    return { ok: true, status: "hidden", message: "Hidden." };
  } catch (e) {
    const msg = sendError(e, "hide");
    await db.from("gtm_comments").update({ status: "failed", error: msg.slice(0, 500), updated_at: new Date().toISOString() }).eq("id", id);
    return { ok: false, error: msg };
  }
}
