// Which Stories /content lists. A season piece (`s<N>-...`) or a Story a season claims is always on the board; so is any
// Story with a calendar item still to go out, and any Story with no calendar row yet whose review is still open.
// Without those rules a Signal Desk post (`signal-...`, no season) could wait for approval where John could never see it
// (the Ultramarine post, 2026-10-16). The calendar rule alone was not enough: approval is what puts a Story without a
// season on the calendar (lib/auto-schedule.ts materializeItem), so a freshly staged one had no row, never showed, and
// could never be approved (signal-pax-silica-aeta, 2026-11-17: its slot passed unseen). A killed piece (`gtm piece kill`,
// Kill piece) leaves the board, season piece or not. Killed means a kill recorded it, never that its rows happen to be
// skipped: a reconcile also skips placeholders, and inferring a kill from that hid pieces waiting on John (review #151
// N3, s1-01-example-record-1 on 2026-10-17). Every read is complete and fails loudly: an empty set would silently drop
// Signal Desk Stories, or bring killed pieces back, as if the calendar said so.
import type { SupabaseClient } from "@supabase/supabase-js";
import { isSeasonStory, onSeasonBoard } from "./season-id";
import { readPages, readChunks } from "./db-read";
import { must } from "./db";
import { withoutAlternatives } from "./newsletter-card";

export type BoardIds = { live: Set<string>; killed: Set<string> };

/** gtm_sync_state key of the kill record: `{ [storyId]: { at, reason } }`, written by killPiece. */
export const KILLED_KEY = "pieces.killed";
/** The resolution killPiece writes on a killed piece's open notes (the record of kills made before KILLED_KEY existed). */
export const KILLED_NOTE = /^Killed[:\s]/;

/**
 * From calendar rows, open reviews and the kill record: Stories with a post still to go or a review still open (`live`),
 * and killed Stories (`killed`): those a kill recorded, while every row they have is skipped or published, or they have
 * none (a piece staged again after a kill has a live row and comes back). An open review (`reviewing`) counts only for a
 * Story with no calendar row at all: it never brings back a killed, banked, published or skipped piece, whose review rows
 * a kill, a bank or a publish leaves as they were.
 */
export function boardSets(rows: { story_id: string; status: string }[], recorded: Set<string> = new Set(), reviewing: Set<string> = new Set()): BoardIds {
  const byStory = new Map<string, string[]>();
  for (const r of rows) byStory.set(r.story_id, [...(byStory.get(r.story_id) ?? []), r.status]);
  const live = new Set<string>(), killed = new Set<string>();
  for (const [id, statuses] of byStory) {
    if (statuses.some((s) => s !== "published" && s !== "skipped" && s !== "banked")) live.add(id);
    else if (recorded.has(id)) killed.add(id);
  }
  // A piece killed before it was ever scheduled has no rows to loop over, and is still killed.
  for (const id of recorded) if (!live.has(id)) killed.add(id);
  // An open review lists a Story only before it has any calendar row (approval is what makes one, lib/auto-schedule.ts).
  for (const id of reviewing) if (!byStory.has(id) && !killed.has(id)) live.add(id);
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

// PostgREST embeds the many-to-one asset as an object; the client's types call it an array, so both are read.
type OpenRow = { asset_id: string; channel: string; status: string; gtm_story_assets?: { story_id: string } | { story_id: string }[] | null };
const storyOf = (r: OpenRow) => { const a = r.gtm_story_assets; return (Array.isArray(a) ? a[0] : a)?.story_id; };
type ReviewAsset = { id: string; story_id: string; kind: string; source: string; body: string | null; metadata: Record<string, unknown> | null };

/**
 * Stories with a review still open (a channel pending or sent back) among those the calendar and the kill record do not
 * already decide (`decided`). Rows that decide nothing are set aside first, as /content does: a published essay and
 * header images no essay names (withoutAlternatives). Every read is complete; a failed one throws.
 */
export async function reviewingStoryIds(db: SupabaseClient, decided: Set<string> = new Set(), open?: OpenRow[]): Promise<Set<string>> {
  const rows0 = open ?? await openReviewRows(db);
  const candidates = [...new Set(rows0.map(storyOf).filter((id): id is string => !!id && !decided.has(id)))];
  if (!candidates.length) return new Set();
  const assets = await readChunks<ReviewAsset>(candidates, (ids, from, to) => db.from("gtm_story_assets").select("id,story_id,kind,source,body,metadata", { count: "exact" })
    .in("story_id", ids).order("id").range(from, to), "stories in review");
  const rows = await readChunks<OpenRow>(assets.map((a) => a.id), (ids, from, to) => db.from("gtm_story_asset_channels").select("asset_id,channel,status", { count: "exact" })
    .in("asset_id", ids).order("asset_id").order("channel").range(from, to), "reviews of stories in review");
  return new Set(candidates.filter((id) => {
    const own = assets.filter((a) => a.story_id === id);
    const mine = rows.filter((r) => own.some((a) => a.id === r.asset_id));
    return withoutAlternatives(own, mine).some((r) => r.status === "pending" || r.status === "rejected");
  }));
}

/** Every review row still open (pending or sent back), with its Story: one paged read. */
function openReviewRows(db: SupabaseClient): Promise<OpenRow[]> {
  return readPages<OpenRow>((from, to) => db.from("gtm_story_asset_channels").select("asset_id,channel,status,gtm_story_assets!inner(story_id)", { count: "exact" })
    .in("status", ["pending", "rejected"]).order("asset_id").order("channel").range(from, to), "open reviews");
}

/** The live and killed Story ids, from every calendar row that belongs to a Story, the kill record and the open reviews. */
export async function boardStoryIds(db: SupabaseClient): Promise<BoardIds> {
  const [rows, recorded, open] = await Promise.all([
    readPages<{ story_id: string; status: string }>((from, to) => db.from("gtm_content_items").select("id,story_id,status", { count: "exact" }).not("story_id", "is", null).order("id").range(from, to), "board calendar items"),
    recordedKills(db),
    openReviewRows(db),
  ]);
  // Only a Story with no calendar row at all is decided by its reviews: a banked, published or skipped row says what
  // became of it, and a recorded kill always wins. Season pieces are listed by name anyway. Usually nothing is left to
  // read in full, so this adds no round trip.
  const decided = new Set([...rows.map((r) => r.story_id), ...recorded, ...(open.map(storyOf).filter((id): id is string => !!id && isSeasonStory(id)))]);
  return boardSets(rows, recorded, await reviewingStoryIds(db, decided, open));
}

/** Story ids that have a calendar item not yet published or skipped (a complete read; a failed one throws). */
export async function liveStoryIds(db: SupabaseClient): Promise<Set<string>> {
  const rows = await readPages<{ story_id: string }>((from, to) => db.from("gtm_content_items").select("id,story_id", { count: "exact" })
    .not("story_id", "is", null).not("status", "in", "(published,skipped)").order("id").range(from, to), "live calendar items");
  return new Set(rows.map((r) => r.story_id));
}

export const onBoard = (story: { id: string; season_id?: string | null }, live: Set<string>, killed: Set<string> = new Set()) =>
  !killed.has(story.id) && (onSeasonBoard(story) || live.has(story.id));
