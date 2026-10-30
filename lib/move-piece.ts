// Moving a piece, not a post (John, 2026-10-17: "the same piece of content go out on all platforms on or around the same
// day"). Dragging one card moves every leg of its Story that has not gone out; each leg keeps its own time (LinkedIn 14:00,
// YouTube 17:00, Instagram 18:00). A time typed in the sheet applies to the leg it was typed on. The legs come from the
// database, not the screen, and every leg moved is reported back, so a leg in another week never moves unseen.
import type { SupabaseClient } from "@supabase/supabase-js";
import { must } from "./db";
import { moveCalendarItem, type MoveResult } from "./reschedule";

export type Leg = { id: string; story_id: string | null; status: string; date: string; time?: string | null; channels?: string[] | null };

const FIXED = ["published", "skipped"];

/**
 * The siblings a whole-piece move takes along: the Story's other legs that can still move. A failed leg stays where it is:
 * its Zernio post is dead, and moving it would re-arm the old text there (retry it from its own sheet instead).
 */
export function siblingLegs(legs: Leg[], id: string): { move: Leg[]; failed: Leg[] } {
  const chosen = legs.find((l) => l.id === id);
  if (!chosen?.story_id) return { move: [], failed: [] };
  const others = legs.filter((l) => l.id !== id && l.story_id === chosen.story_id && !FIXED.includes(l.status));
  return { move: others.filter((l) => l.status !== "failed"), failed: others.filter((l) => l.status === "failed") };
}

/** The moves for one drag or sheet edit: the chosen post, plus (when `all`) its Story's siblings (siblingLegs). */
export function planPieceMove(legs: Leg[], id: string, to: { date: string; time?: string | null }, all = true): Array<{ id: string; date: string; time?: string | null }> {
  if (!legs.some((l) => l.id === id)) throw new Error(`no calendar item ${id}`);
  const plan: Array<{ id: string; date: string; time?: string | null }> = [{ id, date: to.date, ...(to.time !== undefined ? { time: to.time } : {}) }];
  if (!all) return plan;
  for (const l of siblingLegs(legs, id).move) plan.push({ id: l.id, date: to.date });
  return plan;
}

/** Rows that hold their channel on a day, as the scheduler counts them (lib/auto-schedule.ts): approved or further along. */
const HOLDS = ["approved", "scheduled", "published"];

/**
 * Channels already taken on the target day by another piece (one post per channel per day). Only approved, scheduled and
 * published rows hold a channel; a draft, an idea or a failed post does not. `moving` are the legs that move; `onDay` the
 * rows already on that day.
 */
export function channelClashes(moving: Leg[], onDay: Leg[]): string[] {
  const ids = new Set(moving.map((l) => l.id));
  const clashes: string[] = [];
  for (const m of moving) {
    for (const ch of m.channels ?? []) {
      const other = onDay.find((o) => !ids.has(o.id) && HOLDS.includes(o.status) && (o.channels ?? []).includes(ch) && (o.story_id === null || o.story_id !== m.story_id));
      if (other) clashes.push(`${ch} already has ${other.id} that day`);
    }
  }
  return [...new Set(clashes)];
}

/** A move onto a day another piece holds: a warning John can override ("Move anyway"), so two pieces can swap days. */
export class ClashError extends Error {
  constructor(public date: string, public clashes: string[]) {
    super(`${date} already has another piece: ${clashes.join("; ")}.`);
  }
}

/** What the calendar's move action returns for a refused move: a clash is flagged so the board offers "Move anyway". */
export function moveRefusal(error: unknown): { ok: false; error: string; clash?: true } {
  if (error instanceof ClashError) return { ok: false, clash: true, error: error.message };
  return { ok: false, error: error instanceof Error ? error.message : "Could not move the post." };
}

const LEG_COLUMNS = "id,story_id,status,date,time,channels";

/** The legs of the piece `id` belongs to, from the database (for the sheet's "Move all N platforms" and the move itself). */
export async function pieceLegsDb(db: SupabaseClient, id: string): Promise<{ chosen: Leg; legs: Leg[] }> {
  const row = must(await db.from("gtm_content_items").select(LEG_COLUMNS).eq("id", id).maybeSingle(), `item ${id}`) as Leg | null;
  if (!row) throw new Error(`no calendar item ${id}`);
  const legs = row.story_id
    ? must(await db.from("gtm_content_items").select(LEG_COLUMNS).eq("story_id", row.story_id).order("date").order("time"), `legs of ${row.story_id}`) as Leg[]
    : [row];
  return { chosen: row, legs: legs.map((l) => ({ ...l, date: String(l.date).slice(0, 10) })) };
}

export type PieceMove = { moved: MoveResult[]; failed: Array<{ id: string; error: string }> };

/**
 * Moves the piece. Stops before moving anything when a channel is already taken that day by another piece (ClashError),
 * unless `force` (John chose "Move anyway", e.g. to swap two pieces). The chosen
 * post moves first and its refusal stops everything; a sibling's refusal is reported, and so is a failed sibling left behind.
 */
export async function movePiece(db: SupabaseClient, id: string, to: { date: string; time?: string | null }, opts: { all?: boolean; force?: boolean } = {}): Promise<PieceMove> {
  const all = opts.all !== false;
  const { legs } = await pieceLegsDb(db, id);
  const plan = planPieceMove(legs, id, to, all);
  const moving = plan.map((p) => legs.find((l) => l.id === p.id)!);
  const onDay = must(await db.from("gtm_content_items").select(LEG_COLUMNS).eq("date", to.date), `posts on ${to.date}`) as Leg[];
  const clashes = channelClashes(moving, onDay);
  if (clashes.length && !opts.force) throw new ClashError(to.date, clashes);
  const [first, ...rest] = plan;
  const out: PieceMove = { moved: [await moveCalendarItem(db, first.id, first)], failed: [] };
  for (const m of rest) {
    try { out.moved.push(await moveCalendarItem(db, m.id, m)); }
    catch (e) { out.failed.push({ id: m.id, error: e instanceof Error ? e.message : String(e) }); }
  }
  if (all) for (const l of siblingLegs(legs, id).failed) out.failed.push({ id: l.id, error: "failed on Zernio: not moved; retry it from its own sheet" });
  return out;
}
