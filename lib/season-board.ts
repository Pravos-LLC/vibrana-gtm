// Which Stories /content lists. A season piece (`s<N>-...`) or a Story a season claims is always on the board; so is any
// Story with a calendar item still to go out. Without that last rule a Signal Desk post (`signal-...`, no season) could
// wait for approval where John could never see it (the Ultramarine post, 2026-10-16). A killed piece (`gtm piece kill`,
// Kill piece) leaves the board, season piece or not. Killed means a kill recorded it, never that its rows happen to be
// skipped: a reconcile also skips placeholders, and inferring a kill from that hid pieces waiting on John (review #151
// N3, s1-01-example-record-1 on 2026-10-17). Every read is complete and fails loudly: an empty set would silently drop
// Signal Desk Stories, or bring killed pieces back, as if the calendar said so.
import type { SupabaseClient } from "@supabase/supabase-js";
import { onSeasonBoard } from "./season-id";
import { readPages, readChunks } from "./db-read";
import { must } from "./db";

export type BoardIds = { live: Set<string>; killed: Set<string> };

/** gtm_sync_state key of the kill record: `{ [storyId]: { at, reason } }`, written by killPiece. */
export const KILLED_KEY = "pieces.killed";
/** The resolution killPiece writes on a killed piece's open notes (the record of kills made before KILLED_KEY existed). */
export const KILLED_NOTE = /^Killed[:\s]/;

/**
 * From calendar rows and the kill record: Stories with a post still to go (`live`), and killed Stories (`killed`): those a
 * kill recorded, while every row they have is skipped or published (a piece staged again after a kill has a live row and
 * comes back).
 */
export function boardSets(rows: { story_id: string; status: string }[], recorded: Set<string> = new Set()): BoardIds {
  const byStory = new Map<string, string[]>();
  for (const r of rows) byStory.set(r.story_id, [...(byStory.get(r.story_id) ?? []), r.status]);
  const live = new Set<string>(), killed = new Set<string>();
  for (const [id, statuses] of byStory) {
    if (statuses.some((s) => s !== "published" && s !== "skipped")) live.add(id);
    else if (recorded.has(id)) killed.add(id);
  }
  return { live, killed };
}

/** The Stories a kill recorded: the kill record, and pieces whose notes a kill resolved. */
export async function recordedKills(db: SupabaseClient): Promise<Set<string>> {
  const state = must(await db.from("gtm_sync_state").select("value").eq("key", KILLED_KEY).maybeSingle(), "kill record") as { value: Record<string, unknown> } | null;
  const out = new Set(Object.keys(state?.value ?? {}));
  const notes = await readPages<{ asset_id: string }>((from, to) => db.from("gtm_story_feedback").select("id,asset_id", { count: "exact" }).like("resolution", "Killed%").order("id").range(from, to), "kill notes");
  if (notes.length) {
    const assets = await readChunks<{ story_id: string }>(notes.map((n) => n.asset_id), (ids, from, to) => db.from("gtm_story_assets").select("id,story_id", { count: "exact" }).in("id", ids).order("id").range(from, to), "killed pieces");
    for (const a of assets) out.add(a.story_id);
  }
  return out;
}

/** The live and killed Story ids, from every calendar row that belongs to a Story and the kill record. */
export async function boardStoryIds(db: SupabaseClient): Promise<BoardIds> {
  const [rows, recorded] = await Promise.all([
    readPages<{ story_id: string; status: string }>((from, to) => db.from("gtm_content_items").select("id,story_id,status", { count: "exact" }).not("story_id", "is", null).order("id").range(from, to), "board calendar items"),
    recordedKills(db),
  ]);
  return boardSets(rows, recorded);
}

/** Story ids that have a calendar item not yet published or skipped (a complete read; a failed one throws). */
export async function liveStoryIds(db: SupabaseClient): Promise<Set<string>> {
  const rows = await readPages<{ story_id: string }>((from, to) => db.from("gtm_content_items").select("id,story_id", { count: "exact" })
    .not("story_id", "is", null).not("status", "in", "(published,skipped)").order("id").range(from, to), "live calendar items");
  return new Set(rows.map((r) => r.story_id));
}

export const onBoard = (story: { id: string; season_id?: string | null }, live: Set<string>, killed: Set<string> = new Set()) =>
  !killed.has(story.id) && (onSeasonBoard(story) || live.has(story.id));
