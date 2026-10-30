// Moving a calendar item to another day, and keeping Zernio in step with the calendar.
//
// gtm_content_items is the plan John looks at; Zernio is what actually publishes. Moving a card in the calendar must
// move the Zernio post too, or the calendar says one thing and the world sees another (the drift `gtm calendar
// reconcile` finds and fixes). Published and skipped items never move: they already happened (or never will).
import type { SupabaseClient } from "@supabase/supabase-js";
import { isValidTime, weekOfDate, zonedToUtc } from "./calendar";
import { calendarConfig, updateItemDb } from "./calendar-db";
import { must } from "./db";
import { getPost, zernio, ZernioError } from "./zernio";

import {
  loadPieceDeliveries,
  reconcilePieceDeliveries,
} from "./piece-delivery";
import { readPages } from "./db-read";

const LEAD_MS = 5 * 60_000;

type Row = {
  id: string;
  date: string;
  time: string | null;
  status: string;
  zernio_post_id: string | null;
};

export type MoveResult = {
  id: string;
  from: { date: string; time: string | null };
  to: { date: string; time: string | null };
  zernio: "moved" | "none";
};

/** Local wall time in the calendar's zone, as the ISO string Zernio takes together with `timezone`. */
const wall = (date: string, time: string) => `${date}T${time}:00`;

/**
 * Moves one item to `date` (and `time`, when given). A scheduled item's Zernio post is moved first; the calendar row
 * changes only after Zernio accepted it, so a refused move leaves both where they were.
 */
export async function moveCalendarItem(
  db: SupabaseClient,
  id: string,
  to: { date: string; time?: string | null },
  opts: { now?: Date } = {},
): Promise<MoveResult> {
  const { timezone } = calendarConfig();
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(to.date) ||
    Number.isNaN(Date.parse(`${to.date}T12:00:00Z`))
  )
    throw new Error(
      `bad date ${JSON.stringify(to.date)} (expected YYYY-MM-DD)`,
    );
  if (to.time != null && !isValidTime(to.time))
    throw new Error(`bad time ${JSON.stringify(to.time)} (expected HH:MM)`);
  const row = must(
    await db
      .from("gtm_content_items")
      .select("id,date,time,status,zernio_post_id")
      .eq("id", id)
      .maybeSingle(),
    `item ${id}`,
  ) as Row | null;
  if (!row) throw new Error(`no calendar item ${id}`);
  if (row.status === "published")
    throw new Error(`${id} already went out; it cannot move`);
  if (row.status === "skipped")
    throw new Error(`${id} is skipped; un-skip it before moving it`);
  const frozen = must(
    await db
      .from("gtm_piece_deliveries")
      .select("id")
      .eq("calendar_id", id)
      .maybeSingle(),
    "frozen delivery check",
  );
  if (frozen)
    throw new Error(
      "This channel has a frozen delivery. Its queued version and slot are retained; use the shared review delivery controls for an unsent failure.",
    );
  const from = { date: String(row.date).slice(0, 10), time: row.time };
  const time = to.time === undefined ? row.time : to.time;
  const now = (opts.now ?? new Date()).getTime();
  const linked =
    row.zernio_post_id && row.zernio_post_id !== "pending"
      ? row.zernio_post_id
      : null;

  if (row.status === "scheduled" || linked) {
    const when = zonedToUtc(to.date, time ?? "08:30", timezone);
    if (when.getTime() < now + LEAD_MS)
      throw new Error(
        `${to.date} ${time ?? "08:30"} is in the past (or under 5 minutes away): Zernio would publish it at once. Pick a later slot.`,
      );
  }
  let zernioMoved = false;
  if (linked) {
    try {
      const post = await getPost(linked);
      if (post.status === "published")
        throw new Error(
          `${id} already went out on Zernio; refresh the calendar`,
        );
      await zernio(`/posts/${linked}`, {
        method: "PUT",
        body: { scheduledFor: wall(to.date, time ?? "08:30"), timezone },
      });
      zernioMoved = true;
    } catch (e) {
      if (!(e instanceof ZernioError && e.status === 404)) throw e;
      // Deleted on Zernio: the calendar item is just a plan again.
      await db
        .from("gtm_content_items")
        .update({ zernio_post_id: null, status: "approved" })
        .eq("id", id);
    }
  }
  await updateItemDb(db, id, {
    date: to.date,
    ...(to.time !== undefined ? { time: to.time } : {}),
  } as never);
  return {
    id,
    from,
    to: { date: to.date, time },
    zernio: zernioMoved ? "moved" : "none",
  };
}

export type Drift = {
  id: string;
  zernioPostId: string;
  calendar: string;
  zernio: string;
  fixed: boolean;
  error?: string;
};
export type Reconciled = {
  checked: number;
  drift: Drift[];
  published: Array<{ id: string; publishedAt: string; date: string }>;
  failed: Array<{ id: string; zernioPostId: string; error: string }>;
};

/**
 * Compares every linked calendar item with its Zernio post.
 *   scheduled, but on another day/time in Zernio   -> Zernio is moved to the calendar's slot (the calendar is the plan)
 *   published on Zernio                            -> status, url and the real publish date are written back
 *   failed on Zernio                               -> reported (needs a new slot; see `gtm calendar reslot`)
 * `fix: false` only reports.
 */
export async function reconcileCalendar(
  db: SupabaseClient,
  opts: { fix?: boolean; now?: Date } = {},
): Promise<Reconciled> {
  const { timezone } = calendarConfig();
  const frozen =
    opts.fix === false
      ? await loadPieceDeliveries(db)
      : await reconcilePieceDeliveries(db);
  const frozenIds = new Set(frozen.map((d) => d.calendar_id));
  const rows = (
    await readPages<Row & { published_at: string | null }>(
      (from, to) =>
        db
          .from("gtm_content_items")
          .select("id,date,time,status,zernio_post_id,published_at")
          .not("zernio_post_id", "is", null)
          .order("date")
          .order("id")
          .range(from, to),
      "linked calendar items",
    )
  ).filter((row) => !frozenIds.has(row.id));
  const out: Reconciled = { checked: 0, drift: [], published: [], failed: [] };
  for (const d of frozen) {
    out.checked++;
    if (d.state === "published")
      out.published.push({
        id: d.calendar_id,
        publishedAt: "",
        date: d.slot_date,
      });
    if (d.error)
      out.failed.push({
        id: d.calendar_id,
        zernioPostId: d.provider_id ?? "pending",
        error: d.error,
      });
  }
  const now = (opts.now ?? new Date()).getTime();
  for (const row of rows) {
    if (!row.zernio_post_id || row.zernio_post_id === "pending") continue;
    out.checked++;
    let post;
    try {
      post = await getPost(row.zernio_post_id);
    } catch (e) {
      if (e instanceof ZernioError && e.status === 404) {
        out.failed.push({
          id: row.id,
          zernioPostId: row.zernio_post_id,
          error: "post no longer exists on Zernio",
        });
        continue;
      }
      throw e;
    }
    const date = String(row.date).slice(0, 10);
    if (post.status === "published") {
      const urls: Record<string, string> = {};
      let at: string | undefined;
      for (const p of post.platforms ?? []) {
        if (p.platformPostUrl) urls[p.platform] = p.platformPostUrl;
        if (p.publishedAt && (!at || p.publishedAt < at)) at = p.publishedAt;
      }
      const day = at
        ? new Intl.DateTimeFormat("en-CA", {
            timeZone: timezone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }).format(new Date(at))
        : date;
      if (row.status !== "published" || day !== date) {
        out.published.push({ id: row.id, publishedAt: at ?? "", date: day });
        if (opts.fix !== false)
          must(
            await db
              .from("gtm_content_items")
              .update({
                status: "published",
                date: day,
                week: weekOfDate(day),
                ...(at ? { published_at: at } : {}),
                ...(Object.keys(urls).length ? { urls } : {}),
                updated_at: new Date().toISOString(),
              })
              .eq("id", row.id),
            `published ${row.id}`,
          );
      }
      continue;
    }
    if (post.status === "failed" || post.status === "partial") {
      const error = (post.platforms ?? [])
        .map((p) => `${p.platform}: ${p.errorMessage ?? post.status}`)
        .join("; ");
      out.failed.push({ id: row.id, zernioPostId: row.zernio_post_id, error });
      if (row.status !== "failed" && opts.fix !== false)
        must(
          await db
            .from("gtm_content_items")
            .update({ status: "failed", updated_at: new Date().toISOString() })
            .eq("id", row.id),
          `failed ${row.id}`,
        );
      continue;
    }
    if (row.status !== "scheduled" || !post.scheduledFor) continue;
    const want = zonedToUtc(date, row.time ?? "08:30", timezone);
    const have = new Date(post.scheduledFor);
    if (Math.abs(want.getTime() - have.getTime()) < 60_000) continue;
    const drift: Drift = {
      id: row.id,
      zernioPostId: row.zernio_post_id,
      calendar: `${date} ${row.time ?? "08:30"} ${timezone}`,
      zernio: have.toISOString(),
      fixed: false,
    };
    if (opts.fix !== false) {
      if (want.getTime() < now + LEAD_MS)
        drift.error = "the calendar slot is already past; give it a new one";
      else {
        try {
          await zernio(`/posts/${row.zernio_post_id}`, {
            method: "PUT",
            body: { scheduledFor: wall(date, row.time ?? "08:30"), timezone },
          });
          drift.fixed = true;
        } catch (e) {
          drift.error = e instanceof Error ? e.message : String(e);
        }
      }
    }
    out.drift.push(drift);
  }
  return out;
}
