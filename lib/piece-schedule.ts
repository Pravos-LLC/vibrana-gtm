import type { SupabaseClient } from "@supabase/supabase-js";
import { loadCalendarDb } from "./calendar-db";
import { loadPieceReview } from "./piece-review";
import {
  loadPieceDeliveries,
  preparePieceDeliveries,
  sendPieceDelivery,
  reconcilePieceDeliveries,
  releaseUnsentDelivery,
  PIECE_CHANGED,
} from "./piece-delivery";
import { readPages } from "./db-read";
import {
  planSlots,
  loadSeasonPieces,
  channelTime,
  type Season,
  type AutoScheduleResult,
} from "./auto-schedule";
import type { Item } from "./calendar";
import { frontmatterData, splitFrontmatter } from "./frontmatter";

const PILLARS = ["proof", "perspective", "build", "lists"];
/** The pillar a new calendar row of a shared piece takes: its season config, then the copy's front matter; else none
 *  (the database then uses the Story's other rows or its content candidate, and asks rather than guessing). */
export function piecePillar(seasonPillar: string | null | undefined, copyBody: string | null | undefined): string | null {
  if (seasonPillar && PILLARS.includes(seasonPillar)) return seasonPillar;
  const fm = frontmatterData(splitFrontmatter(copyBody ?? "").frontmatter).pillar;
  return typeof fm === "string" && PILLARS.includes(fm) ? fm : null;
}
export async function sharedPieceIds(db: SupabaseClient): Promise<string[]> {
  const rows = await readPages<{ story_id: string }>(
    (from, to) =>
      db
        .from("gtm_piece_reviews")
        .select("story_id")
        .order("story_id")
        .range(from, to),
    "shared scheduling selection",
  );
  return rows.map((r) => r.story_id);
}
/** One authority per opted-in piece. Old approvals never participate in this pass. */
export async function scheduleSharedPieces(
  db: SupabaseClient,
  options: {
    storyId?: string;
    dryRun?: boolean;
    now?: Date;
    ids?: string[];
  } = {},
): Promise<AutoScheduleResult> {
  const ids = (options.ids ?? (await sharedPieceIds(db))).filter(
      (id) => !options.storyId || id === options.storyId,
    ),
    result: AutoScheduleResult = {
      dryRun: !!options.dryRun,
      scheduled: [],
      skipped: [],
      failed: [],
      held: [],
      notFinal: [],
    };
  if (!ids.length) return result;
  const seasons = await readPages<Season>(
      (from, to) =>
        db
          .from("gtm_seasons")
          .select("id,starts_on,ends_on")
          .order("id")
          .range(from, to),
      "publishing season rules",
    ),
    pieces = loadSeasonPieces();
  for (const storyId of ids) {
    try {
      if (!options.dryRun) await reconcilePieceDeliveries(db, { storyId });
      let cal = await loadCalendarDb(db);
      for (const d of await loadPieceDeliveries(db, storyId)) {
        if (["prepared", "uploading"].includes(d.state) && !options.dryRun) {
          try {
            await sendPieceDelivery(db, d.id, cal);
          } catch (e) {
            // John changed or replaced the piece while this reservation waited (a hold, a pause): release it; below,
            // the current approved versions are prepared again, or the piece's blocker is reported.
            if (!(e instanceof Error && PIECE_CHANGED.test(e.message))) throw e;
            await releaseUnsentDelivery(db, d.id);
            result.skipped.push({ id: d.calendar_id, reason: `${d.channel}: the piece changed after this slot was reserved; released it to prepare the approved version again` });
            cal = await loadCalendarDb(db);
          }
        }
        else if (["uncertain", "sending", "failed"].includes(d.state))
          result.skipped.push({
            id: d.calendar_id,
            reason: `${d.channel} delivery ${d.state}${d.error ? `: ${d.error}` : ""}. ${d.state === "failed" ? "Retry it" : "Recover it"} on the piece in /content (gtm piece ${d.state === "failed" ? "retry" : "recover"} ${d.id}).`,
          });
      }
      const s = await loadPieceReview(db, storyId);
      if (!s) continue;
      if (!s.ready) {
        result.skipped.push({ id: storyId, reason: s.blockers.join("; ") });
        continue;
      }
      const existing = await loadPieceDeliveries(db, storyId),
        piece = pieces.find((p) => p.storyId === storyId),
        pillar = piecePillar(piece?.pillar, s.text.asset.body);
      const ready: Item[] = [];
      for (const channel of s.channels) {
        if (existing.some((d) => d.channel === channel)) continue;
        const prior = cal.items.filter(
          (i) => i.story_id === storyId && i.channels.includes(channel),
        );
        // A channel that keeps its existing legacy post is kept, not news: a healthy queued or published legacy post is
        // not a skip (no daily WARN, review #151 F2). Only one whose outcome is unsettled is reported, with what to do.
        const kept = prior.filter((i) => i.zernio_post_id || ["scheduled", "published"].includes(i.status));
        if (kept.length) {
          const unsettled = kept.filter((i) => i.zernio_post_id === "pending" || (i.status !== "scheduled" && i.status !== "published"));
          if (unsettled.length)
            result.skipped.push({
              id: unsettled[0].id,
              reason: `${channel}: the existing legacy post is ${unsettled[0].zernio_post_id === "pending" ? "not confirmed by Zernio" : unsettled[0].status}; check it in the delivery report before this channel gets a shared delivery`,
            });
          continue;
        }
        const date =
          prior[0]?.date ??
          piece?.date ??
          (options.now ?? new Date()).toISOString().slice(0, 10);
        ready.push({
          ...(prior[0] ?? {}),
          id: prior[0]?.id ?? `${storyId}-${channel}`,
          story_id: storyId,
          title: prior[0]?.title ?? piece?.title ?? s.text.asset.title,
          pillar: prior[0]?.pillar ?? pillar ?? "",
          format: "video",
          date,
          time: prior[0]?.time ?? channelTime(channel, "video"),
          week: 1,
          channels: [channel],
          status: "approved",
          body: s.text.asset.body ?? "",
          media: [s.video.asset.storage_path!],
          story_assets: [s.text.asset.id, s.video.asset.id],
        });
      }
      let plan = planSlots({
        items: cal.items,
        ready,
        now: options.now ?? new Date(),
        timeZone: cal.timezone,
        seasons,
        manual: cal.manual,
      });
      result.skipped.push(...plan.skipped);
      if (options.dryRun) {
        result.scheduled.push(...plan.slotted);
        continue;
      }
      if (!plan.slotted.length) continue;
      let reserved;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          reserved = await preparePieceDeliveries(
            db,
            s,
            plan.slotted,
            cal.timezone,
            pillar,
          );
          break;
        } catch (e) {
          if (
            attempt === 2 ||
            !(e instanceof Error) ||
            !e.message.includes("slot was taken")
          )
            throw e;
          cal = await loadCalendarDb(db);
          plan = planSlots({
            items: cal.items,
            ready,
            now: options.now ?? new Date(),
            timeZone: cal.timezone,
            seasons,
            manual: cal.manual,
          });
          if (!plan.slotted.length)
            throw new Error(
              plan.skipped.map((row) => row.reason).join("; ") ||
                "No available slot after concurrent scheduling",
            );
        }
      }
      for (const d of reserved ?? []) {
        const slot = plan.slotted.find((row) => row.channel === d.channel)!;
        try {
          const sent = await sendPieceDelivery(db, d.id, cal);
          if (sent && ["scheduled", "published"].includes(sent.state))
            result.scheduled.push({
              ...slot,
              zernioPostId: sent.provider_id ?? undefined,
              zernioStatus: sent.state,
            });
          else if (sent)
            result.failed.push({
              id: slot.id,
              error: sent.error ?? `Channel delivery ${sent.state}`,
            });
        } catch (e) {
          result.failed.push({
            id: slot.id,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    } catch (e) {
      result.failed.push({
        id: storyId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return result;
}
/** A failed provider post retries in place. A definitive no-post rejection may get a new future slot. */
export async function retryPieceDelivery(
  db: SupabaseClient,
  deliveryId: string,
  options: { provider?: NonNullable<Parameters<typeof sendPieceDelivery>[3]>["provider"] } = {},
) {
  let d = (await loadPieceDeliveries(db)).find((row) => row.id === deliveryId);
  if (!d) throw new Error("Delivery not found");
  if (d.state !== "failed")
    throw new Error(
      "Reconcile this delivery before retrying; its outcome is not a definitive failure",
    );
  let cal = await loadCalendarDb(db);
  if (!d.provider_id) {
    const ready = {
      id: d.calendar_id,
      story_id: d.story_id,
      title: "Frozen delivery",
      format: "video",
      pillar: cal.items.find((i) => i.id === d!.calendar_id)?.pillar ?? "",
      week: 1,
      date: d.slot_date,
      time: d.slot_time.slice(0, 5),
      channels: [d.channel],
      status: "approved",
    } as Item;
    const seasons = await readPages<Season>(
      (from, to) =>
        db
          .from("gtm_seasons")
          .select("id,starts_on,ends_on")
          .order("id")
          .range(from, to),
      "publishing season rules",
    );
    const plan = planSlots({
      items: cal.items.filter((i) => i.id !== d!.calendar_id),
      ready: [ready],
      now: new Date(),
      timeZone: cal.timezone,
      seasons,
      manual: cal.manual,
    });
    if (!plan.slotted[0])
      throw new Error(
        plan.skipped[0]?.reason ?? "No publishing slot available",
      );
    const slot = plan.slotted[0],
      r = await db.rpc("gtm_replan_unsent_delivery", {
        p_id: d.id,
        p_date: slot.date,
        p_time: slot.time,
        p_timezone: cal.timezone,
      });
    if (r.error) throw new Error(r.error.message);
    d = r.data;
    cal = await loadCalendarDb(db);
  }
  try {
    return await sendPieceDelivery(db, deliveryId, cal, { retry: true, provider: options.provider });
  } catch (e) {
    // A definitive rejection retried after John changed the piece: release it; it schedules again from the approved versions.
    if (!(e instanceof Error && PIECE_CHANGED.test(e.message)) || d?.provider_id) throw e;
    await releaseUnsentDelivery(db, deliveryId);
    throw new Error("The piece changed since this channel was reserved: released it. It schedules again from the approved versions once both parts are approved.");
  }
}
