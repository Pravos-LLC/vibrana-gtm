// Webhook side of the engage queue: one comment.received / message.received event into gtm_comments.
// Runs after the 2xx (Zernio wants an answer within 5 s); a failure is harmless because the event is
// already in gtm_zernio_events and the daily run replays the last 72 hours of them.
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminDb, must } from "../db";
import { checkPostAlert } from "./alerts";
import { ownContext } from "./own";
import { parseZernioEvent, type CommentRow, type StoredComment } from "./parse";
import { REDFLAGS } from "./redflags";
import { draftNew } from "./run";
import { COMMENT_COLUMNS, isOurRecentReply, repairFromPoll, upsertComments } from "./store";

/**
 * VIB-424: a thread that is moving fast is classified now (the same drafting call the 07:00 run would
 * make, just earlier, for this post only), then checked for backlash, so John hears about a pile-on the
 * same hour instead of the next morning. A single quiet comment waits for the daily run: no extra call.
 */
/** After this long a classification claim is treated as abandoned (the webhook's function limit is 120 s). */
export const CLAIM_STALE_MS = 10 * 60_000;

export async function redFlagCheck(db: SupabaseClient, row: CommentRow, deps: { draft?: typeof draftNew; check?: typeof checkPostAlert; now?: Date } = {}) {
  const ref = { platform: row.platform, zernio_post_id: row.zernio_post_id, platform_post_id: row.platform_post_id };
  if (!ref.zernio_post_id && !ref.platform_post_id) return { classified: false, alert: null };
  const now = deps.now ?? new Date();
  const since = new Date(now.getTime() - REDFLAGS.backlash.velocity.within_hours * 3600_000).toISOString();
  let q = db.from("gtm_comments").select("id").eq("platform", ref.platform).eq("kind", "comment").eq("is_own", false).eq("status", "new").gte("received_at", since);
  q = ref.zernio_post_id ? q.eq("zernio_post_id", ref.zernio_post_id) : q.eq("platform_post_id", ref.platform_post_id!);
  const waiting = (must(await q.limit(50), "waiting comments") as { id: string }[]).length;
  if (waiting < REDFLAGS.backlash.velocity.min_negative) return { classified: false, alert: null };
  // Claim this post's unclassified new comments in one conditional update (stance_at marks them taken), so
  // two webhooks arriving together make one model call, not two. A claim older than CLAIM_STALE_MS belongs to
  // a run that died mid-call (Vercel killed it): it is taken again rather than stranding the rows.
  const stale = new Date(now.getTime() - CLAIM_STALE_MS).toISOString();
  let claim = db.from("gtm_comments").update({ stance_at: now.toISOString() }).eq("platform", ref.platform).eq("kind", "comment")
    .eq("is_own", false).eq("status", "new").or(`stance_at.is.null,stance_at.lt.${stale}`);
  claim = ref.zernio_post_id ? claim.eq("zernio_post_id", ref.zernio_post_id) : claim.eq("platform_post_id", ref.platform_post_id!);
  const rows = must(await claim.select(COMMENT_COLUMNS), "claim comments") as StoredComment[];
  if (rows.length) {
    try {
      await (deps.draft ?? draftNew)(db, { only: ref, rows, deadline: now.getTime() + 90_000 });
    } catch (e) {
      // Give the claim back so the next webhook (or 07:00) classifies them; rows already drafted keep theirs.
      await db.from("gtm_comments").update({ stance_at: null }).in("id", rows.map((r) => r.id)).eq("status", "new").is("stance", null);
      throw e;
    }
  }
  return { classified: rows.length > 0, alert: await (deps.check ?? checkPostAlert)(db, ref, { now }) };
}

export async function ingestEngageEvent(event: string, payload: unknown) {
  try {
    const db = adminDb();
    // Account handles too (cached), so our own comment is caught even when the payload has no isOwnAccount.
    const row = parseZernioEvent(event, payload, await ownContext(db));
    if (!row) return;
    if (!row.is_own && row.kind === "comment" && await isOurRecentReply(db, row)) {
      Object.assign(row, { is_own: true, status: "skipped", note: "our own comment or reply" });
    }
    await upsertComments(db, [row]);
    // A row stored earlier (e.g. by the poll) that this event shows is ours leaves the queue too.
    if (row.is_own) await repairFromPoll(db, [row]);
    else if (row.kind === "comment" && row.status === "new") await redFlagCheck(db, row);
  } catch (e) {
    console.error(`engage ingest ${event}: ${(e as Error).message}`);
  }
}
