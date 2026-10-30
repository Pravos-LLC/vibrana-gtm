import { loadContent } from "../lib/content-overlay.mjs";
// Approval schedules (John, 2026-10-11): once a piece is approved for a platform in /content, its calendar item
// goes to Zernio in the best open slot. There is no second approval. A slot is the item's own planned date and
// time when that is still ahead and free (no other piece that day); otherwise (a missed date, or the day already has a
// piece) the next day the weekly rhythm gives its pillar (lib/rhythm.ts, John 2026-10-17: Mon Perspective, Tue Proof,
// Wed Build, Thu Voices, Fri Lists, Sat IG and YouTube reels), then a day that takes it as a fallback, never one that
// breaks the house rules, at the channel's guide time (content/guide/channels.json).
// Imported, not read from disk: inside the Next.js server bundle a file URL built from import.meta.url is not a
// path readFileSync accepts ("Received an instance of URL"), so the after-approval auto-schedule pass threw in a
// `next build` server before it read a single row.
const season1 = loadContent("config/season1.json") as typeof import("../content/sample/config/season1.json");
import publishingMetadata from "../config/publishing-metadata.json";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseCopy, zonedToUtc, type Calendar, type Item } from "./calendar";
import { calendarFromDb, loadCalendarDb, PILLARS, rowToItem, updateItemDb, validateRow, type ContentRow } from "./calendar-db";
import { must } from "./db";
import { sendCalendarItem } from "./publish-item";
import { checkChannelLength } from "./channel-rules";
import type { StoryAsset, StoryChannel } from "./story";
import { weekOfDate } from "./calendar";
import { holdHeadline, nonFinal, notFinalReason } from "./stage";
import { storyHolds, type Hold, type HoldAsset, type HoldStory, type ThirdPartyDecision } from "./third-party";
import { loadFixNotes } from "./approve-note-db";
import type { FixNote } from "./approve-note";
import { contentVisibility } from "./content-visibility-db";
import { isHandPublished } from "./hand-published";
import { channelAllowed, fitRank, lanesOf, lintCalendar, lookOf, pieceKeyOf, type Issue, type LintPost } from "./rhythm";
import { addDays, mondayOf } from "./week";

/** A held Story, or one whose third party has not approved the final, is never auto-scheduled (lib/third-party.ts). */
export type { Hold } from "./third-party";
export type Season = { id: string; starts_on: string; ends_on: string };
export type Slotted = { id: string; storyId: string | null; channel: string; date: string; time: string; from: { date: string; time: string | null }; moved: boolean };
/** An item (or approved channel) left off Zernio, with its Story when it has one (the /content link). */
export type Skipped = { id: string; reason: string; storyId?: string | null };

/** A missed piece looks this far ahead for its primary day, then (as far again) for a fallback day, then takes the earliest open day. */
export const PRIMARY_WINDOW_DAYS = 14;
/** A slot must be at least this far ahead, so Zernio never publishes it immediately. */
export const LEAD_MS = 30 * 60_000;
const HORIZON_DAYS = 120;

/** The guide time per channel: LinkedIn 08:30 for text and documents, 14:00 for video; YouTube 17:00; Instagram 18:00. */
export function channelTime(channel: string, format: string): string {
  if (channel === "linkedin") return /video|reel|short/.test(format) ? "14:00" : "08:30";
  if (channel === "youtube") return "17:00";
  if (channel === "instagram") return "18:00";
  return "08:30";
}

/**
 * The Stories that may not publish yet: held (gtm_stories.held_at), or naming a third party who has not approved the
 * final at its current bytes (gtm_stories.third_party_who and the decision log).
 */
export async function loadHolds(db: SupabaseClient, storyId?: string): Promise<Hold[]> {
  const query = db.from("gtm_stories").select("id,hold_who,hold_note,held_at,third_party_who").or("held_at.not.is.null,third_party_who.not.is.null");
  const stories = must(await (storyId ? query.eq("id", storyId) : query), "story holds") as HoldStory[];
  const gated = stories.filter((s) => s.third_party_who).map((s) => s.id);
  if (!gated.length) return storyHolds(stories, [], new Set(), []);
  const assets = must(await db.from("gtm_story_assets").select("id,story_id,kind,sha256,stage").in("story_id", gated), "gated assets") as HoldAsset[];
  const media = assets.filter((a) => a.kind === "video" || a.kind === "image").map((a) => a.id);
  const bound = media.length ? must(await db.from("gtm_story_asset_channels").select("asset_id").in("asset_id", media), "gated channels") as { asset_id: string }[] : [];
  const decisions = must(await db.from("gtm_story_stage_decisions").select("story_id,stage,party,decision,assets,decided_at").in("story_id", gated).eq("party", "third_party"), "third-party decisions") as ThirdPartyDecision[];
  return storyHolds(stories, assets, new Set(bound.map((b) => b.asset_id)), decisions);
}

/** One Story's hold, or undefined when it is not held. */
export async function holdFor(db: SupabaseClient, storyId: string): Promise<Hold | undefined> {
  return (await loadHolds(db, storyId))[0];
}

/**
 * A hold only an agent clears: fix = an approve-with-note not applied yet; rework = not the final John directed. A fix
 * hold names the platforms its note covers and holds only those (a note on the newsletter header never holds the
 * LinkedIn post); without `channels` a hold covers every platform of the Story.
 */
export type AgentHold = Omit<Hold, "kind"> & { kind: "fix" | "rework"; channels?: string[] };
/** Anything that keeps an approved piece off Zernio. */
export type ScheduleHold = Hold | AgentHold;

/**
 * Holds only the agent can clear, read fresh on every auto-schedule pass: an approve-with-note whose fix has not landed
 * (John approved it with a note; it waits for `gtm story resolve`), and a final withdrawn by an agent or staged before
 * John's latest upstream approval (it is not the version he directed, lib/content-visibility.ts).
 */
export async function loadAgentHolds(db: SupabaseClient, storyId?: string): Promise<AgentHold[]> {
  const out: AgentHold[] = [];
  // One hold per note, scoped to the platforms the note covers (a note on the shared text lists every platform it goes to).
  for (const n of await loadFixNotes(db, storyId)) out.push(fixHold(n));
  for (const h of (await contentVisibility(db, storyId)).hidden) {
    if (h.reason === "changes") continue; // needs changes: not approved, so never ready anyway
    out.push({ storyId: h.storyId, who: "", note: h.detail, heldAt: null, kind: "rework", finalStaged: true });
  }
  return out;
}

/** The hold an open approve-with-note puts on its Story: only on the platforms the note covers. */
export function fixHold(n: Pick<FixNote, "id" | "storyId" | "channels" | "createdAt">): AgentHold {
  return { storyId: n.storyId, who: "", note: `John approved it with a note (${n.id}); the agent applies it, restages and runs gtm story resolve`, heldAt: n.createdAt, kind: "fix", finalStaged: true, channels: [...n.channels] };
}

/** "publishing blocked until example_approver / Example Series approves the final: <note>". A hold blocks publishing, not a version. */
export function holdReason(hold: ScheduleHold): string {
  if (hold.kind === "fix") return `waiting for the fix${"channels" in hold && hold.channels?.length ? ` (${hold.channels.join(", ")})` : ""}: ${hold.note}`;
  if (hold.kind === "rework") return `not the final John directed: ${hold.note}`;
  return `${holdHeadline(hold.who).replace(/^P/, "p")}${hold.note ? `: ${hold.note}` : ""}`;
}

/**
 * The hold on an item's Story. An item without a story_id matches a held Story by its id prefix (`<story>-<channel>`). A
 * hold scoped to some platforms (an approve-with-note) holds only an item on one of them.
 */
export function heldBy<H extends ScheduleHold>(item: Pick<Item, "id" | "story_id"> & { channels?: string[] }, holds: H[]): H | undefined {
  return holds.find((h) => (item.story_id ? item.story_id === h.storyId : item.id.startsWith(`${h.storyId}-`))
    && (!("channels" in h) || !h.channels || !item.channels || item.channels.some((c) => h.channels!.includes(c))));
}

type GateAsset = Pick<StoryAsset, "id" | "kind" | "sha256"> & { stage?: string | null; title?: string };
type GateApproval = Pick<StoryChannel, "asset_id" | "channel" | "status" | "approved_sha256">;

/** Every asset bound to this Story item is approved for its channel at the bytes staged now, whatever its stage. */
function approvedAtCurrentBytes(item: Item, assets: GateAsset[], approvals: GateApproval[]): boolean {
  if (!item.story_id || item.channels.length !== 1 || !item.story_assets?.length) return false;
  const channel = item.channels[0];
  const bound = assets.filter((a) => item.story_assets!.includes(a.id));
  if (bound.length !== new Set(item.story_assets).size) return false;
  return bound.every((a) => a.kind === "link" || approvals.some((r) => r.asset_id === a.id && r.channel === channel && r.status === "approved" && r.approved_sha256 === a.sha256));
}

/** The bound media assets short of their final stage (a rough cut): approved or not, the item is not ready. */
export function notFinalAssets<A extends GateAsset>(item: Pick<Item, "story_assets">, assets: A[]): A[] {
  return nonFinal(assets.filter((a) => item.story_assets?.includes(a.id)));
}

/**
 * True when every asset bound to this Story item is approved for its channel at the bytes staged now AND every bound
 * media asset is final (stage null or "final"). A rough-cut approval means "the edit is good", never "send it". A cheap
 * mirror of checkStoryApprovalDb (no downloads); sendCalendarItem still runs the full check, digests included.
 */
export function channelApproved(item: Item, assets: GateAsset[], approvals: GateApproval[]): boolean {
  return approvedAtCurrentBytes(item, assets, approvals) && notFinalAssets(item, assets).length === 0;
}

/** The Story asset a stored media key belongs to: keys are `stories/<story>/<asset-id>-<sha16>.<ext>`. */
export function assetIdFromKey(key: string): string | null {
  const name = key.split("/").pop() ?? "";
  const m = name.match(/^(.+)-[0-9a-f]{16}\.[a-z0-9]+$/i);
  return m ? m[1] : null;
}

type BindAsset = Pick<StoryAsset, "id" | "source" | "storage_path">;

/**
 * Restaging a Story asset gives it a new content-addressed storage key, but calendar rows imported earlier still name
 * the old key, so the publish gate (rightly) refuses them. Approval is always on an asset's current bytes, so the row
 * should point there: an old key of an asset the item is bound to becomes that asset's current key, and a key (and id)
 * of an asset since removed from the Story (a deck that shrank) is dropped. Anything else is left for the gate to refuse.
 */
export function rebindStoryItem(item: Item, assets: BindAsset[]): { media: string[]; story_assets: string[]; changed: boolean } {
  const media = item.media ?? [];
  const ids = item.story_assets ?? [];
  if (!item.story_id) return { media, story_assets: ids, changed: false };
  const byId = new Map(assets.map((a) => [a.id, a]));
  const next: string[] = [];
  for (const ref of media) {
    if (assets.some((a) => a.storage_path === ref || a.source === ref)) { next.push(ref); continue; }
    const id = assetIdFromKey(ref);
    const asset = id ? byId.get(id) : undefined;
    if (id && asset?.storage_path && ids.includes(id)) next.push(asset.storage_path);
    else if (id && !asset && ids.includes(id)) continue; // removed from the Story
    else next.push(ref);
  }
  const story_assets = ids.filter((id) => byId.has(id));
  const changed = next.length !== media.length || next.some((m, i) => m !== media[i]) || story_assets.length !== ids.length;
  return { media: next, story_assets, changed };
}

/** A season piece from config/season*.json, enough to put an approved Story on the calendar. */
export type SeasonPiece = { storyId: string; title: string; date: string; pillar: string; kind: string };

export function loadSeasonPieces(): SeasonPiece[] {
  const cfg = season1 as { pieces: Array<{ n: number; slug: string; name: string; date: string; pillar: string; kind: string }> };
  return cfg.pieces.map((p) => ({ storyId: `s1-${String(p.n).padStart(2, "0")}-${p.slug}`, title: p.name, date: p.date, pillar: p.pillar, kind: p.kind }));
}

type MaterialAsset = Pick<StoryAsset, "id" | "story_id" | "kind" | "sha256" | "source" | "storage_path" | "body">;
/** The Story row, for the title of a piece that has no season entry. */
export type StoryHead = { id: string; title: string | null };

/**
 * What an approved Story channel goes on the calendar as. A season piece keeps its season entry. Any other Story (a
 * one-off, a kb narrative, a short staged outside season1.json) is described by itself: title and pillar from the
 * channel's copy front matter (`title:`, `pillar:`), else the Story title (the name after "<slot> | ") and another
 * copy's pillar; the date from the front matter `date:`, else the earliest rhythm day for its pillar after today (nextSlotDay).
 */
export function pieceFor(storyId: string, channel: string, assets: MaterialAsset[], rows: Pick<StoryChannel, "asset_id" | "channel">[], season: SeasonPiece | undefined, story: StoryHead | undefined, today: string, seasonEnd?: string, busy?: Set<string>): SeasonPiece | { error: string } {
  if (season) return season;
  const copies = assets.filter((a) => a.story_id === storyId && a.kind === "copy");
  const own = copies.filter((a) => rows.some((r) => r.asset_id === a.id && r.channel === channel));
  const metas = [...own, ...copies.filter((a) => !own.includes(a))].map((a) => parseCopy(a.body ?? "").meta);
  // Classification is operational metadata: repairing it must not rewrite already-approved post text.
  const configured = (publishingMetadata as Record<string, { pillar: string }>)[storyId]?.pillar;
  const pillar = [...metas.map((m) => m.pillar?.trim()), configured].find((x) => x && (PILLARS as readonly string[]).includes(x));
  if (!pillar) return { error: `approved, but its text has no pillar: add "pillar:" (${PILLARS.join(", ")}) to the ${channel} copy front matter and restage it` };
  const named = story?.title?.includes(" | ") ? story.title.split(" | ").slice(1).join(" | ") : story?.title;
  const title = metas[0]?.title?.trim() || named?.trim() || storyId;
  const planned = metas[0]?.date?.trim();
  // Every platform of the piece gets the same day (one piece, one day): a day all of them may post on.
  const channels = [...new Set(rows.map((r) => r.channel))].filter((c) => ["linkedin", "instagram", "youtube"].includes(c));
  return { storyId, title, date: planned && /^\d{4}-\d{2}-\d{2}$/.test(planned) ? planned : nextSlotDay(today, { pillar, channels: channels.length ? channels : [channel], seasonEnd, busy }), pillar, kind: "story" };
}

/**
 * The day a Story with no planned date is given: the earliest rhythm day for its pillar strictly after `today`
 * (lib/rhythm.ts; within PRIMARY_WINDOW_DAYS), else a day that takes its pillar as a fallback, else the earliest day
 * every one of its platforms may post on, all inside the season (`seasonEnd`). Never today itself: the planner keeps a
 * planned slot that is still ahead, so "today" would post within hours when John approves before the guide time. From
 * here the planner keeps it if the channel is free that day, or moves it under its own rules. With nothing open inside
 * the season it returns the first rhythm day after it, which the planner then parks in the reserve bank (reported).
 * `busy` is every day another piece already holds (scheduled, published or hand-placed and not yet sent): a computed
 * day is never one of them, so a new Story never lands beside a piece John placed and later bumps it.
 */
export function nextSlotDay(today: string, opts: { pillar?: string | null; channels?: string[]; seasonEnd?: string; busy?: Set<string> } = {}): string {
  const lanes = lanesOf(opts.pillar ?? null, []);
  const channels = opts.channels?.length ? opts.channels : ["linkedin"];
  const days = Array.from({ length: 120 }, (_, d) => addDays(today, d + 1)).filter((date) => channels.every((c) => channelAllowed(date, c)) && !opts.busy?.has(date));
  const inSeason = days.filter((date) => !opts.seasonEnd || date <= opts.seasonEnd);
  const window = inSeason.slice(0, PRIMARY_WINDOW_DAYS);
  const pick = window.find((date) => fitRank(date, lanes) === 0) ?? window.find((date) => fitRank(date, lanes) > 0) ?? inSeason[0] ?? days[0];
  if (!pick) throw new Error(`no posting day after ${today}`);
  return pick;
}

/** Path segments of a copy path without its leading `../` or `./` hops. */
const segments = (path: string) => path.split("/").filter((s) => s && s !== "." && s !== "..");
/** Same copy file under a different root: one path is a suffix of the other, at least three segments long (`posts/<slug>/linkedin.md`). */
function sameCopyPath(a: string, b: string): boolean {
  const [x, y] = [segments(a), segments(b)].sort((p, q) => p.length - q.length);
  return x.length >= 3 && x.every((s, i) => s === y[y.length - x.length + i]);
}

/**
 * A calendar row on this channel that is not bound to this Story but already carries it: it names one of the Story's
 * assets, posts the same media (the same storage key, or a content-addressed key with the same sha256 prefix: calendar
 * imports store `calendar/<item>/<sha16>-<name>`, Stories `stories/<story>/<asset>-<sha16>.<ext>`), points at the same
 * copy file, or holds the same text. Pieces published before Stories existed (s1-13 "AI: power vs. purpose" went out on
 * 2026-10-07 as `power-vs-purpose-*`, with no story_id) look exactly like this. Making a second item for one of them
 * would publish the same post twice, so the channel is reported instead, whatever the row's status.
 */
export function alreadyOnCalendar(storyId: string, channel: string, assets: MaterialAsset[], items: Item[]): Item | undefined {
  const mine = assets.filter((a) => a.story_id === storyId && a.kind !== "link");
  const ids = new Set(mine.map((a) => a.id));
  const media = mine.filter((a) => a.kind === "video" || a.kind === "image");
  const keys = new Set(media.flatMap((a) => [a.storage_path, a.source].filter((x): x is string => !!x)));
  const prints = media.map((a) => a.sha256?.slice(0, 16).toLowerCase()).filter((x) => x && x.length === 16);
  const texts = new Set(mine.filter((a) => a.kind === "copy").map((a) => parseCopy(a.body ?? "").base).filter((t) => t.length >= 40));
  const sources = mine.filter((a) => a.kind === "copy" && a.source).map((a) => a.source);
  return items.find((i) => i.story_id !== storyId && i.channels.includes(channel) && (
    (i.story_assets ?? []).some((id) => ids.has(id))
    || (i.media ?? []).some((m) => keys.has(m) || prints.some((p) => m.toLowerCase().includes(p)))
    || (!!i.copy && sources.some((s) => sameCopyPath(i.copy!, s)))
    || (!!i.body && texts.has(parseCopy(i.body).base))
  ));
}

/** Channels that cannot take a post without an image or video. */
const NEEDS_MEDIA: Record<string, string> = { instagram: "Instagram needs an image or a video", youtube: "YouTube needs a video" };

/**
 * Pieces staged for review without a calendar item (approve first, John 2026-10-11) get one the moment a platform is
 * approved, so approval alone puts them on the calendar. The row binds exactly what was approved for the channel: its
 * text, and its video (any image beside a video is a cover, bound but not posted) or else its slides in order. A
 * LinkedIn post with no media is a text post.
 */
export function materializeItem(storyId: string, channel: string, assets: MaterialAsset[], rows: Pick<StoryChannel, "asset_id" | "channel">[], piece: SeasonPiece | undefined): { row: ContentRow } | { error: string } {
  if (!piece) return { error: "approved, but it has no calendar item and no season entry to make one from" };
  const mine = assets.filter((a) => a.story_id === storyId && rows.some((r) => r.asset_id === a.id && r.channel === channel));
  const copies = mine.filter((a) => a.kind === "copy");
  if (copies.length !== 1) return { error: `expected one ${channel} text, found ${copies.length}` };
  const videos = mine.filter((a) => a.kind === "video");
  const images = mine.filter((a) => a.kind === "image").sort((a, b) => a.id.localeCompare(b.id));
  if (videos.length > 1) return { error: `${videos.length} videos are assigned to ${channel}; bind one by hand` };
  const media = (videos.length ? videos : images).map((a) => a.storage_path).filter((x): x is string => !!x);
  if (!media.length && channel !== "linkedin") return { error: `no ${channel} media is staged: ${NEEDS_MEDIA[channel] ?? `${channel} cannot post text alone`}` };
  const format = videos.length ? "video" : !media.length ? "text" : channel === "linkedin" ? "document" : "carousel";
  const row: ContentRow = {
    id: `${storyId}-${channel}`, week: weekOfDate(piece.date), date: piece.date, time: channelTime(channel, format), pillar: piece.pillar, title: piece.title,
    format, channels: [channel], status: "drafted", link: null, cta: null, zernio_post_id: null, published_at: null, urls: {},
    story_id: storyId, story_assets: [copies[0].id, ...mine.filter((a) => a.kind !== "copy" && a.kind !== "link").map((a) => a.id)],
    publication: null, body: copies[0].body ?? null, media, approved_hash: null, copy_path: copies[0].source,
  };
  const problems = validateRow(row);
  return problems.length ? { error: problems.join("; ") } : { row };
}

/**
 * The text an item posts (its bound Story copy, else its own body) over a platform's length limit (lib/channel-rules.ts),
 * as a skip reason; null when it fits. The same rule refuses the send itself (buildPost) and fails `gtm check`.
 */
export function tooLong(item: Item, assets: Array<Pick<StoryAsset, "kind" | "source" | "body">>): string | null {
  const text = assets.find((a) => a.kind === "copy" && item.copy && a.source === item.copy)?.body ?? item.body ?? "";
  const errors = checkChannelLength(item.id, item.channels, parseCopy(text));
  return errors.length ? errors.map((e) => e.slice(item.id.length + 2)).join("; ") : null;
}

/**
 * Every approved channel of a staged Story that has no calendar item yet becomes one (materializeItem), or is reported
 * in `skipped` with the reason: never dropped silently. Pure. A channel is taken only when every asset assigned to it is
 * approved at the bytes staged now and final, the Story is not held, the channel is not published by hand, and no row
 * already carries the piece (alreadyOnCalendar). Not approved yet is not a skip: there is nothing to report.
 */
export function materializeApproved(input: { assets: Array<MaterialAsset & { stage?: string | null; title?: string }>; approvals: GateApproval[]; items: Item[]; manual: string[]; holds: ScheduleHold[]; pieces: SeasonPiece[]; stories: StoryHead[]; today: string; seasonEnd?: string }): { rows: ContentRow[]; skipped: Skipped[] } {
  const { assets, approvals, manual, holds, pieces, stories, today, seasonEnd } = input;
  const items = [...input.items];
  const rows: ContentRow[] = [];
  const skipped: Skipped[] = [];
  for (const storyId of [...new Set(assets.map((a) => a.story_id))]) {
    const storyAssets = assets.filter((a) => a.story_id === storyId);
    const storyRows = approvals.filter((r) => storyAssets.some((a) => a.id === r.asset_id));
    for (const channel of [...new Set(storyRows.map((r) => r.channel))]) {
      if (items.some((i) => i.story_id === storyId && i.channels.includes(channel))) continue;
      const channelRows = storyRows.filter((r) => r.channel === channel);
      const approved = channelRows.every((r) => r.status === "approved" && r.approved_sha256 === storyAssets.find((a) => a.id === r.asset_id)?.sha256);
      if (!approved) continue;
      const id = `${storyId}-${channel}`;
      // A newsletter (or website) approval is John's go-ahead to publish it by hand: it never becomes a calendar item.
      if (isHandPublished(channel) || manual.includes(channel)) { skipped.push({ id, storyId, reason: `${channel} is published by hand` }); continue; }
      // A rough cut approved for the channel ("the edit is good") never becomes a calendar item to schedule.
      const early = nonFinal(storyAssets.filter((a) => channelRows.some((r) => r.asset_id === a.id)));
      if (early.length) { skipped.push({ id, storyId, reason: notFinalReason(early.map((a) => ({ title: a.title ?? a.id, stage: a.stage }))) }); continue; }
      const hold = heldBy({ id, story_id: storyId, channels: [channel] }, holds);
      if (hold) { skipped.push({ id, storyId, reason: `held: ${holdReason(hold)}` }); continue; }
      const twin = alreadyOnCalendar(storyId, channel, storyAssets, items);
      if (twin) { skipped.push({ id, storyId, reason: `approved, but ${twin.id} (${twin.status}${twin.zernio_post_id ? ", on Zernio" : ""}) already carries this piece on ${channel} without being bound to the Story, so no second post is made: bind that row to ${storyId} if it is the same post` }); continue; }
      const piece = pieceFor(storyId, channel, storyAssets, storyRows, pieces.find((p) => p.storyId === storyId), stories.find((s) => s.id === storyId), today, seasonEnd,
        new Set(items.filter((i) => i.status !== "skipped" && pieceKeyOf(i.story_id, i.id) !== storyId).map((i) => i.date)));
      if ("error" in piece) { skipped.push({ id, storyId, reason: piece.error }); continue; }
      const made = materializeItem(storyId, channel, storyAssets, storyRows, piece);
      if ("error" in made) { skipped.push({ id, storyId, reason: made.error }); continue; }
      rows.push(made.row);
      items.push(rowToItem(made.row));
    }
  }
  return { rows, skipped };
}

const dayParts = (at: Date, timeZone: string) => Object.fromEntries(
  new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(at).map((p) => [p.type, p.value]));

/** Calendar days from today (in the calendar's zone), with their weekday. */
function* daysFrom(now: Date, timeZone: string) {
  for (let d = 0; d <= HORIZON_DAYS; d++) {
    const p = dayParts(new Date(now.getTime() + d * 86_400_000), timeZone);
    yield { date: `${p.year}-${p.month}-${p.day}`, weekday: p.weekday as string };
  }
}

const LIVE = new Set(["scheduled", "published"]);

const toLint = (i: Item, date = i.date): LintPost => ({ id: i.id, date, channels: i.channels, status: i.status, pillar: i.pillar ?? null, format: i.format, storyId: i.story_id ?? null, title: i.title });
const keyOfItem = (i: Pick<Item, "id" | "story_id">) => pieceKeyOf(i.story_id, i.id);

/** The last day a move may land on: the end of the season holding today, else of the next season to start. */
export function seasonEndFor(seasons: Season[], today: string): string | undefined {
  const sorted = [...seasons].sort((a, b) => a.starts_on.localeCompare(b.starts_on));
  return (sorted.find((s) => s.starts_on <= today && today <= s.ends_on) ?? sorted.find((s) => s.starts_on > today))?.ends_on;
}
/** The rules a moved piece must not break (pillar fit is the ranking; caption length is the send gate's job). */
const PLACEMENT_RULES = new Set<Issue["rule"]>(["one-piece", "voiceover", "look-adjacent", "prism-cap", "topic", "channel-day"]);
const placementIssues = (posts: LintPost[], date: string) =>
  lintCalendar(posts.filter((p) => p.date >= addDays(date, -14) && p.date <= addDays(date, 21)), mondayOf(date), 2).flatMap((w) => w.issues).filter((i) => PLACEMENT_RULES.has(i.rule)).map((i) => `${i.rule}|${i.date}|${i.message}`);

/**
 * Picks a slot for every ready item. Pure: `ready` are the items to schedule, `items` the whole calendar (to see which
 * days are already taken). Siblings from one piece move together so a piece keeps its channels on one day.
 * - A planned slot that is still ahead with its channel free that day is kept, even when another piece holds the day:
 *   John placed it, and the lint warns instead (code review F3, 2026-10-17).
 * - A missed or clashing piece moves: to its primary rhythm day within PRIMARY_WINDOW_DAYS, else a fallback day within
 *   the same window, else the earliest open day (Saturday only for an Instagram and YouTube piece; never Sunday)
 *   (John: "drops back to whatever is available"). A day is open when no other piece holds it, every leg may post
 *   that day, and the move adds no house-rule problem (lib/rhythm.ts).
 * - Never after the current season ends: a piece with no open day before then stays as it is and is reported
 *   ("doesn't fit this season"), for John to place by hand.
 */
export function planSlots(input: { items: Item[]; ready: Item[]; now: Date; timeZone: string; seasons?: Season[]; holds?: ScheduleHold[]; manual?: string[] }): { slotted: Slotted[]; skipped: Skipped[] } {
  const { items, ready, now, timeZone } = input;
  const holds = input.holds ?? [];
  const manual = new Set(input.manual ?? []);
  const lastSeasonDay = (input.seasons ?? []).map((s) => s.ends_on).sort().at(-1);
  const today = dayParts(now, timeZone);
  const seasonEnd = seasonEndFor(input.seasons ?? [], `${today.year}-${today.month}-${today.day}`);
  const taken = new Set(items.filter((i) => LIVE.has(i.status) || i.zernio_post_id).flatMap((i) => i.channels.map((ch) => `${ch}|${i.date}`)));
  const ahead = (date: string, time: string) => zonedToUtc(date, time, timeZone).getTime() >= now.getTime() + LEAD_MS;
  const slotted: Slotted[] = [];
  const skipped: Skipped[] = [];

  const eligible: Item[] = [];
  for (const item of ready) {
    const hold = heldBy(item, holds);
    if (hold) { skipped.push({ id: item.id, reason: `held: ${holdReason(hold)}` }); continue; }
    if (item.channels.length !== 1) { skipped.push({ id: item.id, reason: "needs exactly one channel" }); continue; }
    if (manual.has(item.channels[0]) || isHandPublished(item.channels[0])) { skipped.push({ id: item.id, reason: `${item.channels[0]} is published by hand` }); continue; }
    if (lastSeasonDay && item.date > lastSeasonDay) { skipped.push({ id: item.id, reason: `parked in the reserve bank (${item.date}, after the last season ends ${lastSeasonDay}); give it a slot inside a season to schedule it` }); continue; }
    eligible.push(item);
  }

  // What already holds its day: everything on the calendar except the pieces being placed now (and killed legs).
  const placing = new Set(eligible.map((i) => i.id));
  const board: LintPost[] = items.filter((i) => i.status !== "skipped" && !placing.has(i.id) && !manual.has(i.channels[0]) && !isHandPublished(i.channels[0] ?? "")).map((i) => toLint(i));
  const dayHasOther = (date: string, key: string) => board.some((p) => p.date === date && pieceKeyOf(p.storyId, p.id) !== key);

  // One group per Story and planned date (a piece), earliest first, so earlier pieces claim the earlier open days.
  const groups = new Map<string, Item[]>();
  for (const item of eligible) {
    const key = `${keyOfItem(item)}|${item.date}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const ordered = [...groups.values()].sort((a, b) => (a[0].date + (a[0].time ?? "")).localeCompare(b[0].date + (b[0].time ?? "")));
  const keyOf = (group: Item[]) => keyOfItem(group[0]);
  const claim = (group: Item[], date: string, moved: boolean) => {
    for (const i of group) {
      taken.add(`${i.channels[0]}|${date}`);
      board.push(toLint(i, date));
      const time = moved ? channelTime(i.channels[0], i.format) : i.time ?? channelTime(i.channels[0], i.format);
      slotted.push({ id: i.id, storyId: i.story_id ?? null, channel: i.channels[0], date, time, from: { date: i.date, time: i.time ?? null }, moved });
    }
  };
  // Planned slots that are still ahead claim their days before anything is moved.
  const toMove: Item[][] = [];
  for (const group of ordered) {
    const keeps = group.every((i) => ahead(i.date, i.time ?? channelTime(i.channels[0], i.format)) && !taken.has(`${i.channels[0]}|${i.date}`));
    if (keeps) claim(group, group[0].date, false);
    else toMove.push(group);
  }
  for (const group of toMove) {
    const key = keyOf(group);
    const lanes = lanesOf(group[0].pillar ?? null, [...new Set(group.map((i) => lookOf(i.story_id ?? null, i.format)))]);
    const opens = (date: string) => !dayHasOther(date, key)
      && group.every((i) => channelAllowed(date, i.channels[0]) && !taken.has(`${i.channels[0]}|${date}`) && ahead(date, channelTime(i.channels[0], i.format)))
      && (() => {
        const before = new Set(placementIssues(board, date));
        return placementIssues([...board, ...group.map((i) => toLint(i, date))], date).every((x) => before.has(x));
      })();
    const days = [...new Set([...daysFrom(now, timeZone)].map((d) => d.date))].filter((date) => !seasonEnd || date <= seasonEnd);
    const window = days.slice(0, PRIMARY_WINDOW_DAYS + 1);
    const pick = window.find((date) => fitRank(date, lanes) === 0 && opens(date))
      ?? window.find((date) => fitRank(date, lanes) > 0 && opens(date))
      ?? days.find((date) => opens(date));
    if (pick) claim(group, pick, true);
    else for (const i of group) skipped.push({ id: i.id, reason: seasonEnd
      ? `doesn't fit this season: no open day before it ends on ${seasonEnd}; place it by hand`
      : `no open day in the next ${HORIZON_DAYS} days for ${i.channels[0]}` });
  }
  slotted.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  return { slotted, skipped };
}

export type AutoScheduleResult = {
  dryRun: boolean;
  scheduled: Array<Slotted & { rebound?: boolean; zernioPostId?: string; zernioStatus?: string }>;
  skipped: Skipped[];
  failed: Array<{ id: string; error: string; storyId?: string | null }>;
  created?: string[]; // calendar items made for approved platforms that had none
  held: ScheduleHold[]; // every Story on hold (in scope), approved or not, so a dry run shows what is waiting on a third party
  notFinal: NotFinal[]; // every Story (in scope) with media short of its final stage: approved or not, never scheduled
};

/** A Story whose media is not final yet (a rough cut). */
export type NotFinal = { storyId: string; assets: Array<{ id: string; title: string; stage: string }> };

/** Never change a slot or roll it back after another sender has claimed or completed this item. */
export async function updateUnclaimedItem(db: SupabaseClient, item: Item, patch: Partial<ContentRow>): Promise<boolean> {
  let q = db.from("gtm_content_items").update({ ...patch, ...(patch.date ? { week: weekOfDate(patch.date) } : {}), updated_at: new Date().toISOString() })
    .eq("id", item.id).eq("status", item.status).eq("date", item.date).is("zernio_post_id", null);
  q = item.time == null ? q.is("time", null) : q.eq("time", item.time);
  q = item.body == null ? q.is("body", null) : q.eq("body", item.body);
  const changed = must(await q.eq("media", JSON.stringify(item.media ?? []))
    .select("id"), `prepare schedule ${item.id}`);
  return Boolean(changed?.length);
}

/** Two approval callbacks may materialize the same platform at once. Keep the winner's row and schedule state intact. */
export async function addMissingCalendarItem(db: SupabaseClient, row: ContentRow): Promise<boolean> {
  const added = must(await db.from("gtm_content_items").upsert({ ...row, updated_at: new Date().toISOString() },
    { onConflict: "id", ignoreDuplicates: true }).select("id"), `add ${row.id}`);
  return Boolean(added?.length);
}

/**
 * Schedules every approved, unscheduled calendar item (or only one Story's) into its best open slot. Story items count
 * as approved when their assets are approved for the item's channel in /content; other items need status: approved.
 * A failure on one item never stops the rest; it is returned in `failed` with Zernio's reason.
 */
export async function autoSchedule(db: SupabaseClient, opts: { storyId?: string; dryRun?: boolean; now?: Date; holds?: Hold[]; pieces?: SeasonPiece[] } = {}): Promise<AutoScheduleResult> {
  if (!calendarFromDb()) throw new Error("auto-scheduling needs the database calendar (GTM_CALENDAR_SOURCE=db)");
  const now = opts.now ?? new Date();
  const {sharedPieceIds,scheduleSharedPieces}=await import("./piece-schedule");
  const sharedIds=await sharedPieceIds(db),sharedSet=new Set(sharedIds);
  const shared=await scheduleSharedPieces(db,{...opts,ids:sharedIds});
  if(opts.storyId&&sharedSet.has(opts.storyId))return shared;
  // Agent holds always apply, even when a caller passes its own holds (a release dry run passes none).
  const holds: ScheduleHold[] = [...(opts.holds ?? await loadHolds(db)), ...await loadAgentHolds(db, opts.storyId)];
  let cal = await loadCalendarDb(db);
  // Every Story at once is hundreds of assets: page the read (PostgREST caps a response) and chunk the id list
  // (a long `in (...)` overflows the URL and comes back "Bad Request", which stopped the 2-hourly pass entirely).
  const assets: StoryAsset[] = [];
  for (let from = 0; ; from += 500) {
    const assetQuery = db.from("gtm_story_assets").select("id,story_id,title,kind,sha256,source,storage_path,body,stage").order("id");
    const page = must(await (opts.storyId ? assetQuery.eq("story_id", opts.storyId) : assetQuery).range(from, from + 499), "story assets") as StoryAsset[];
    assets.push(...page.filter(a=>!sharedSet.has(a.story_id)));
    if (page.length < 500) break;
  }
  const approvals: StoryChannel[] = [];
  for (let i = 0; i < assets.length; i += 100) {
    approvals.push(...must(await db.from("gtm_story_asset_channels").select("asset_id,channel,status,approved_sha256").in("asset_id", assets.slice(i, i + 100).map((a) => a.id)), "story approvals") as StoryChannel[]);
  }
  const skippedEarly: Skipped[] = [];

  // Approved platforms of staged Stories that have no calendar item yet get one (see materializeApproved).
  const storyIds = [...new Set(assets.map((a) => a.story_id))];
  const stories: StoryHead[] = [];
  for (let i = 0; i < storyIds.length; i += 100) stories.push(...must(await db.from("gtm_stories").select("id,title").in("id", storyIds.slice(i, i + 100)), "stories") as StoryHead[]);
  const p = dayParts(now, cal.timezone);
  const today = `${p.year}-${p.month}-${p.day}`;
  // A failed seasons read fails the pass (BR-06): without the season ends a post could be placed in the reserve bank.
  const seasons = must(await db.from("gtm_seasons").select("id,starts_on,ends_on"), "publishing season rules");
  const made = materializeApproved({ assets, approvals, items: cal.items, manual: cal.manual, holds, pieces: opts.pieces ?? loadSeasonPieces(), stories, today, seasonEnd: seasonEndFor((seasons ?? []) as Season[], today) });
  skippedEarly.push(...made.skipped);
  const created: string[] = [];
  for (const row of made.rows) {
    if (!opts.dryRun) { if (await addMissingCalendarItem(db, row)) created.push(row.id); }
    else cal = { ...cal, items: [...cal.items, rowToItem(row)] };
    if (opts.dryRun) created.push(row.id);
  }
  if (made.rows.length && !opts.dryRun) cal = await loadCalendarDb(db);

  const open = cal.items.filter((i) => !sharedSet.has(i.story_id??"") && !i.zernio_post_id && (i.status === "drafted" || i.status === "approved") && (!opts.storyId || i.story_id === opts.storyId));
  // Point each Story item at its assets' current bytes before judging it (see rebindStoryItem).
  const rebound = new Map<string, { media: string[]; story_assets: string[] }>();
  const current = open.map((i) => {
    if (!i.story_id) return i;
    const r = rebindStoryItem(i, assets.filter((a) => a.story_id === i.story_id));
    if (!r.changed) return i;
    rebound.set(i.id, { media: r.media, story_assets: r.story_assets });
    return { ...i, media: r.media, story_assets: r.story_assets };
  });
  const ready: Item[] = [];
  for (const i of current) {
    if (!i.story_id) {
      if (i.status !== "approved") continue;
      const long = tooLong(i, []);
      if (long) skippedEarly.push({ id: i.id, storyId: null, reason: long }); else ready.push(i);
      continue;
    }
    const own = assets.filter((a) => a.story_id === i.story_id);
    if (!approvedAtCurrentBytes(i, own, approvals)) continue;
    // Approved, but at a stage before the final one: report it instead of scheduling a rough cut.
    const early = notFinalAssets(i, own);
    if (early.length) { skippedEarly.push({ id: i.id, storyId: i.story_id, reason: notFinalReason(early) }); continue; }
    // Over a platform's length limit: Zernio or the platform would refuse it at publish time, so it is not sent at all.
    const long = tooLong(i, own);
    if (long) { skippedEarly.push({ id: i.id, storyId: i.story_id, reason: long }); continue; }
    ready.push(i);
  }
  const plan = planSlots({ items: cal.items, ready, now, timeZone: cal.timezone, seasons: (seasons ?? []) as Season[], holds, manual: cal.manual });
  const held = holds.filter((h) => !opts.storyId || h.storyId === opts.storyId);
  const notFinal: NotFinal[] = [...new Set(assets.map((a) => a.story_id))].sort().flatMap((storyId) => {
    const early = nonFinal(assets.filter((a) => a.story_id === storyId));
    return early.length ? [{ storyId, assets: early.map((a) => ({ id: a.id, title: a.title, stage: a.stage! })) }] : [];
  });
  const result: AutoScheduleResult = { dryRun: Boolean(opts.dryRun), scheduled: [], skipped: [...skippedEarly, ...plan.skipped.map((k) => ({ ...k, storyId: cal.items.find((i) => i.id === k.id)?.story_id ?? null }))], failed: [], ...(created.length ? { created } : {}), held, notFinal };
  for (const slot of plan.slotted) {
    const item = cal.items.find((i) => i.id === slot.id)!;
    const binding = rebound.get(item.id);
    try {
      if (opts.dryRun) {
        const preview: Calendar = { ...cal, items: cal.items.map((i) => (i.id === item.id ? { ...i, ...binding, date: slot.date, time: slot.time, status: "approved" as const } : i)) };
        await sendCalendarItem(preview, item.id, { mode: "schedule", db, dry: true });
        result.scheduled.push({ ...slot, ...(binding ? { rebound: true } : {}) });
        continue;
      }
      const prior = { date: item.date, time: item.time ?? null, status: item.status };
      // The binding is written on its own first: the row trigger drops an item to drafted when its media change.
      let preparing = item;
      if (binding) {
        if (!await updateUnclaimedItem(db, preparing, binding)) throw new Error(`${item.id}: scheduling state changed; another sender may have claimed it`);
        preparing = (await loadCalendarDb(db)).items.find((i) => i.id === item.id)!;
      }
      if (!await updateUnclaimedItem(db, preparing, { date: slot.date, time: slot.time, status: "approved" }))
        throw new Error(`${item.id}: scheduling state changed; another sender may have claimed it`);
      try {
        const sent = await sendCalendarItem(await loadCalendarDb(db), item.id, { mode: "schedule", db });
        if ("dryRun" in sent) throw new Error("unexpected dry run");
        result.scheduled.push({ ...slot, ...(binding ? { rebound: true } : {}), zernioPostId: sent.zernioPostId, zernioStatus: sent.zernioStatus });
      } catch (error) {
        // Roll the slot back only when Zernio never got the post (a real id or "pending" means it may exist).
        const after = (await loadCalendarDb(db)).items.find((i) => i.id === item.id);
        if (after && !after.zernio_post_id && after.status === "approved" && after.date === slot.date && after.time === slot.time && after.body === item.body
          && JSON.stringify(after.media ?? []) === JSON.stringify(binding?.media ?? item.media ?? []))
          await updateUnclaimedItem(db, after, prior);
        throw error;
      }
    } catch (error) {
      if (!opts.dryRun) {
        const latest = (await loadCalendarDb(db)).items.find((i) => i.id === item.id);
        if (latest?.zernio_post_id && latest.zernio_post_id !== "pending" && (latest.status === "scheduled" || latest.status === "published")) {
          result.scheduled.push({ ...slot, date: latest.date, time: latest.time ?? slot.time, moved: latest.date !== item.date || latest.time !== item.time, zernioPostId: latest.zernio_post_id, zernioStatus: latest.status });
          continue;
        }
        if (latest?.zernio_post_id === "pending") {
          result.skipped.push({ id: slot.id, storyId: slot.storyId, reason: "scheduling in progress: another sender has claimed this post" });
          continue;
        }
      }
      result.failed.push({ id: slot.id, storyId: slot.storyId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  result.scheduled.push(...shared.scheduled);result.skipped.push(...shared.skipped);result.failed.push(...shared.failed);
  return result;
}
