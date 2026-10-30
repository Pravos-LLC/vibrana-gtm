// A failed post, explained and sent again. Before this a failed row was a red dot: the reason lived only on Zernio and
// nothing re-sent it ("Frontier AI at 1.7% of the Price?" failed on 2026-10-16 for a caption over LinkedIn's 4,000
// characters, John fixed the text, and the row stayed failed against the old Zernio post).
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadCalendarDb } from "./calendar-db";
import { must } from "./db";
import { sendCalendarItem } from "./publish-item";
import { getPost, zernio, ZernioError } from "./zernio";

type Row = { id: string; status: string; zernio_post_id: string | null };

/** The stored event a refused retry leaves, so the reason outlives the deleted Zernio post (no schema change). */
export const RETRY_FAILED_EVENT = "gtm.retry.failed";

/**
 * Why a failed post failed, in Zernio's words ("linkedin: ShareCommentary text length (4323 characters) exceeded ..."),
 * or null when nothing says. A linked post: Zernio first, then the webhook events we stored. An unlinked one: the reason a
 * refused retry recorded (its Zernio post is gone by then).
 */
export async function failureReason(db: SupabaseClient, id: string): Promise<string | null> {
  const row = must(await db.from("gtm_content_items").select("id,status,zernio_post_id").eq("id", id).maybeSingle(), `item ${id}`) as Row | null;
  if (!row) return null;
  const linked = row.zernio_post_id && row.zernio_post_id !== "pending" ? row.zernio_post_id : null;
  if (linked) {
    try {
      const post = await getPost(linked);
      const reasons = (post.platforms ?? []).filter((p) => p.errorMessage).map((p) => `${p.platform}: ${p.errorMessage}`);
      if (reasons.length) return reasons.join("; ");
    } catch (e) {
      if (!(e instanceof ZernioError && e.status === 404)) throw e;
    }
    const { data } = await db.from("gtm_zernio_events").select("payload").in("event", ["post.platform.failed", "post.failed"])
      .order("received_at", { ascending: false }).limit(200);
    for (const ev of (data ?? []) as { payload: unknown }[]) {
      const text = eventReason(ev.payload, linked);
      if (text) return text;
    }
    return null;
  }
  // Unlinked: a refused retry deleted the Zernio post and left its reason here.
  const { data: retried } = await db.from("gtm_zernio_events").select("payload").eq("event", RETRY_FAILED_EVENT)
    .eq("payload->>calendarId", id).order("received_at", { ascending: false }).limit(1);
  return ((retried ?? [])[0]?.payload as { reason?: string } | undefined)?.reason ?? null;
}

/** The error text in one stored Zernio webhook payload, when it is about `postId`. */
export function eventReason(payload: unknown, postId: string): string | null {
  const p = payload as { post?: { _id?: string; id?: string; platforms?: { platform?: string; errorMessage?: string }[] }; platform?: { platform?: string; errorMessage?: string }; error?: string; errorMessage?: string } | null;
  if (!p?.post || (p.post._id ?? p.post.id) !== postId) return null;
  const fromPlatforms = (p.post.platforms ?? []).filter((x) => x.errorMessage).map((x) => `${x.platform}: ${x.errorMessage}`);
  if (fromPlatforms.length) return fromPlatforms.join("; ");
  if (p.platform?.errorMessage) return `${p.platform.platform}: ${p.platform.errorMessage}`;
  return p.errorMessage ?? p.error ?? null;
}

export type RetryResult = { id: string; deleted: string | null; zernioPostId: string; status: string; scheduledFor: string | null };

/** Zernio's Idempotency-Key for a retry: its own per failed post (the original key is still held 24 h with the old body). */
export const retryKey = (id: string, failedPostId: string | null, now = Date.now()) => `gtm-${id}-retry-${failedPostId ?? now}`;

/**
 * Sends a failed post again from its current approved text and media, at its calendar slot.
 *  1. Every send guard runs first, as a dry run against the row as it will be (approved, unlinked): the slot is ahead, the
 *     piece is not held, the approval snapshot and final stage hold, the channel rules pass (LinkedIn length after mentions
 *     and UTM tags). A refusal here changes nothing: the post stays failed, with Zernio's reason still readable.
 *  2. Only then is the failed Zernio post deleted (it still holds the old text) and the row reset to approved (a
 *     compare-and-set on `failed`, so two clicks never send twice).
 *  3. The send uses a retry-only idempotency key. If it is refused, the row goes back to `failed`, so the calendar still
 *     offers Retry. An outcome Zernio left unclear (`pending`) is left alone for reconcile.
 */
export async function retryCalendarItem(db: SupabaseClient, id: string): Promise<RetryResult> {
  const row = must(await db.from("gtm_content_items").select("id,status,zernio_post_id").eq("id", id).maybeSingle(), `item ${id}`) as Row | null;
  if (!row) throw new Error(`no calendar item ${id}`);
  if (row.status !== "failed") throw new Error(`${id} is ${row.status}; only a failed post can be retried`);
  const old = row.zernio_post_id && row.zernio_post_id !== "pending" ? row.zernio_post_id : null;
  let oldExists = false;
  if (old) {
    try {
      const post = await getPost(old);
      if (post.status === "published") throw new Error(`${id} went out on Zernio after all (${old}); run gtm calendar reconcile`);
      if (post.status !== "failed" && post.status !== "partial") throw new Error(`${id}: Zernio post ${old} is ${post.status}, not failed; run gtm calendar reconcile`);
      oldExists = true;
    } catch (e) {
      if (!(e instanceof ZernioError && e.status === 404)) throw e;
    }
  }

  const cal = await loadCalendarDb(db);
  const item = cal.items.find((i) => i.id === id);
  if (!item) throw new Error(`no calendar item ${id}`);
  // Step 1: the dry run sees the row as it will be after the reset; nothing is uploaded or written.
  await sendCalendarItem({ ...cal, items: cal.items.map((i) => (i.id === id ? { ...i, status: "approved", zernio_post_id: null } : i)) }, id, { mode: "schedule", dry: true, db });

  // Zernio's reason dies with the post: keep it, to record beside a refused retry.
  // Read whenever the row is linked: a post Zernio no longer has can still have a reason in the stored webhook events.
  const earlier = old ? await failureReason(db, id).catch(() => null) : null;
  let deleted: string | null = null;
  if (old && oldExists) {
    try { await zernio(`/posts/${old}`, { method: "DELETE" }); deleted = old; }
    catch (e) { if (!(e instanceof ZernioError && e.status === 404)) throw e; }
  }
  const reset = must(await db.from("gtm_content_items").update({ status: "approved", zernio_post_id: null, updated_at: new Date().toISOString() })
    .eq("id", id).eq("status", "failed").select("id"), `reset ${id}`) as { id: string }[];
  if (!reset.length) throw new Error(`${id} changed while retrying; refresh and look again`);

  try {
    const sent = await sendCalendarItem(await loadCalendarDb(db), id, { mode: "schedule", db, idempotencyKey: retryKey(id, old) });
    if ("dryRun" in sent) throw new Error("nothing was sent");
    return { id, deleted, zernioPostId: sent.zernioPostId, status: sent.zernioStatus, scheduledFor: sent.scheduledFor ?? null };
  } catch (e) {
    // Back to failed so Retry is offered again; never over a `pending` (Zernio may have the post: reconcile decides). The
    // reason is recorded where the calendar's failed panel reads it (failureReason), since the Zernio post is gone.
    const refusal = e instanceof Error ? e.message : String(e);
    const problems: string[] = [];
    const back = await db.from("gtm_content_items").update({ status: "failed", updated_at: new Date().toISOString() })
      .eq("id", id).eq("status", "approved").is("zernio_post_id", null);
    if (back.error) problems.push(`and the post could not be set back to failed (${back.error.message}); it shows as approved with no Zernio post`);
    const reason = `Retry refused: ${refusal}${earlier ? ` (before that, Zernio said: ${earlier})` : ""}`;
    const noted = await db.from("gtm_zernio_events").insert({ event_id: `gtm-retry-${id}-${Date.now()}`, event: RETRY_FAILED_EVENT, payload: { calendarId: id, reason } });
    if (noted.error) problems.push(`and the reason could not be stored (${noted.error.message})`);
    throw new Error(problems.length ? `${refusal} ${problems.join("; ")}` : refusal);
  }
}
