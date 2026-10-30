// Seasons: the dated runs of content the review screen and `gtm season` work on. A Season row (gtm_seasons)
// holds the title, description, dates and the pillars in play; Stories belong to it through
// gtm_stories.season_id. This file loads a Season with everything the analysis needs and normalizes it into
// lib/season-analysis.ts's input. The loader only reads; every transform after the fetch is pure.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Item } from "./calendar";
import { activeCalendar } from "./calendar-db";
import { must } from "./db";
import { PILLARS } from "./guide/content";
import { parsePieceTitle } from "./season";
import {
  analyzeSeason, extractAsOfDate, type AnalyzeOptions, type CardInput, type PartState, type PieceFormat, type PieceInput,
  type SeasonAnalysis, type SeasonInput, type SeasonRecord, type VersionInput,
} from "./season-analysis";
import type { StoryAsset, StoryChannel } from "./story";

export type SeasonRow = SeasonRecord & { created_at: string; updated_at: string };
export type StoryRow = { id: string; title: string; season_id: string | null };
export type VersionRow = { asset_id: string; revision: number; label: string; created_at?: string };
export type FeedbackRow = { asset_id: string; channel: string | null; resolved_at: string | null };

/** Everything fetched for one Season, as rows. `buildSeasonInput` turns it into the analysis input. */
export type SeasonRaw = {
  season: SeasonRow;
  stories: StoryRow[];
  assets: StoryAsset[];
  reviews: StoryChannel[];
  versions: VersionRow[];
  feedback: FeedbackRow[];
  items: Item[];
};

// ---- fields and validation (shared by the server action and the CLI) ------------------------------------

export const KNOWN_PILLARS: string[] = PILLARS.map((p) => p.slug);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const realDate = (d: string) => {
  const ms = Date.parse(`${d}T00:00:00Z`);
  return DATE.test(d) && !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === d;
};

export type SeasonFields = { title: string; description: string; starts_on: string; ends_on: string; pillars: string[] };

/** "proof, lists" or ["proof","lists"] -> sorted, de-duplicated slugs. Unknown slugs are kept so validation can name them. */
export function parsePillars(input: string | string[] | undefined): string[] {
  const list = Array.isArray(input) ? input : (input ?? "").split(",");
  return [...new Set(list.map((s) => s.trim().toLowerCase()).filter(Boolean))].sort();
}

/** Every reason these fields cannot be saved, in plain words. Empty when they can. */
export function validateSeasonFields(f: Partial<SeasonFields>): string[] {
  const errors: string[] = [];
  const title = f.title?.trim() ?? "";
  if (!title) errors.push("The season needs a title.");
  else if (title.length > 200) errors.push("The title is over 200 characters.");
  if ((f.description ?? "").length > 5000) errors.push("The description is over 5000 characters.");
  const startOk = !!f.starts_on && realDate(f.starts_on);
  const endOk = !!f.ends_on && realDate(f.ends_on);
  if (!startOk) errors.push(`The start date must be a real date as YYYY-MM-DD (got ${JSON.stringify(f.starts_on ?? "")}).`);
  if (!endOk) errors.push(`The end date must be a real date as YYYY-MM-DD (got ${JSON.stringify(f.ends_on ?? "")}).`);
  if (startOk && endOk && f.ends_on! < f.starts_on!) errors.push("The season cannot end before it starts.");
  const unknown = (f.pillars ?? []).filter((p) => !KNOWN_PILLARS.includes(p));
  if (unknown.length) errors.push(`Unknown pillar${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}. Choose from ${KNOWN_PILLARS.join(", ")}.`);
  return errors;
}

// ---- normalization ----------------------------------------------------------------------------------------

export function normalizeFormat(format: string | undefined): PieceFormat {
  if (format === "video") return "video";
  if (format === "carousel" || format === "document") return "carousel";
  if (format === "text" || format === "post" || format === "essay") return "text";
  if (format === "image") return "image";
  return "other";
}

const PLATFORM_SUFFIX = /-(linkedin|instagram|youtube|website|newsletter|substack|document|ig-story|ig-carousel|li-document)$/;

/** Counts per part: no rows = none; any rejection = needs changes; approved only while the staged bytes still match. */
export function partState(assets: StoryAsset[], reviews: StoryChannel[], channel: string): { state: PartState; stale: number } {
  const rows = reviews.filter((r) => r.channel === channel && assets.some((a) => a.id === r.asset_id));
  if (!rows.length) return { state: "none", stale: 0 };
  const stale = rows.filter((r) => r.status === "approved" && r.approved_sha256 !== assets.find((a) => a.id === r.asset_id)!.sha256).length;
  if (rows.some((r) => r.status === "rejected")) return { state: "needs-changes", stale };
  return { state: rows.every((r) => r.status === "approved") && stale === 0 ? "approved" : "needs-approval", stale };
}

const isMedia = (a: StoryAsset) => a.kind === "video" || a.kind === "image";

/**
 * Pieces of a season. A piece is a Story that belongs to the season (its calendar items are its cards), or a
 * calendar item inside the season's dates that is not part of one (the Orion and Coherence clips, a carousel
 * waiting for its Story), grouped with its sibling platforms by base id and slot date. Skipped items are not
 * pieces. One card per item and channel.
 */
export function buildSeasonInput(raw: SeasonRaw): SeasonInput {
  const { season } = raw;
  const seasonStories = new Map(raw.stories.map((s) => [s.id, s]));
  const live = raw.items.filter((i) => i.status !== "skipped" && ((i.date >= season.starts_on && i.date <= season.ends_on) || (i.story_id && seasonStories.has(i.story_id))));
  const groups = new Map<string, Item[]>();
  for (const item of live) {
    const own = item.story_id && seasonStories.has(item.story_id);
    const key = own ? item.story_id! : `${item.id.replace(PLATFORM_SUFFIX, "")}@${item.date}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const assetById = new Map(raw.assets.map((a) => [a.id, a]));
  const latestVersion = (assetId: string) => {
    const mine = raw.versions.filter((v) => v.asset_id === assetId).sort((a, b) => a.revision - b.revision);
    return { label: mine.at(-1)?.label ?? "v1", revision: mine.at(-1)?.revision ?? assetById.get(assetId)?.revision ?? 1, count: Math.max(mine.length, 1) };
  };

  const pieces: PieceInput[] = [];
  for (const [key, items] of groups) {
    const sorted = [...items].sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? "") || a.id.localeCompare(b.id));
    const story = seasonStories.get(key);
    const cards: CardInput[] = [];
    const copies: string[] = [];
    for (const item of sorted) for (const channel of item.channels) {
      const ids = item.story_assets ?? [];
      const assets = ids.map((id) => assetById.get(id)).filter((a): a is StoryAsset => !!a);
      const copy = assets.find((a) => a.kind === "copy" && raw.reviews.some((r) => r.asset_id === a.id && r.channel === channel)) ?? assets.find((a) => a.kind === "copy");
      const media = assets.filter((a) => isMedia(a) && raw.reviews.some((r) => r.asset_id === a.id && r.channel === channel));
      const text = copy ? partState([copy], raw.reviews, channel) : { state: "none" as PartState, stale: 0 };
      const asset = partState(media, raw.reviews, channel);
      const versions: VersionInput[] = [...(copy ? [copy] : []), ...media].map((a) => {
        const v = latestVersion(a.id);
        return { assetId: a.id, kind: a.kind, label: v.label, revision: v.revision, versions: v.count };
      });
      const body = copy?.body ?? item.body ?? null;
      if (body) copies.push(body);
      cards.push({
        platform: channel, itemId: item.id, itemStatus: item.status, date: item.date, time: item.time ?? null,
        format: normalizeFormat(item.format), staged: assets.length > 0 && (text.state !== "none" || asset.state !== "none"),
        text: text.state, asset: asset.state, staleApprovals: text.stale + asset.stale, versions,
        openNotes: raw.feedback.filter((f) => !f.resolved_at && assets.some((a) => a.id === f.asset_id) && (f.channel === null || f.channel === channel)).length,
        copy: body,
      });
    }
    const first = sorted[0];
    const parsed = story ? parsePieceTitle(story.title) : null;
    const all = copies.join("\n\n");
    const pillar = first.pillar || null;
    const primary = cards.find((c) => c.platform === "linkedin") ?? cards[0];
    pieces.push({
      id: story?.id ?? key.split("@")[0], title: parsed?.name ?? first.title, slot: parsed?.slot ?? "",
      date: first.date, pillar, format: primary?.format ?? "other",
      platforms: [...new Set(cards.map((c) => c.platform))], cards, storyId: first.story_id ?? null,
      factsAsOf: extractAsOfDate(all), mentionsStars: pillar === "lists" && /\bstars?\b/i.test(all),
      womenStated: pillar === "lists" ? statedWomen(all) : null,
      inSeasonStories: !!story,
    });
  }
  pieces.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  return { season: { id: season.id, title: season.title, description: season.description, starts_on: season.starts_on, ends_on: season.ends_on, pillars: season.pillars }, pieces };
}

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };

/** "Five of them are women" in a list's copy: how many women the piece itself says it lists, else null. */
export function statedWomen(text: string): number | null {
  const m = /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:of\s+(?:them|these|the\s+(?:ten|\d+|names))\s+)?(?:are|is)\s+women\b/i.exec(text);
  if (!m) return null;
  const n = /^\d+$/.test(m[1]) ? Number(m[1]) : NUMBER_WORDS[m[1].toLowerCase()];
  return n && n > 0 ? n : null;
}

/** The guide's pillar shares, the targets the analysis measures the mix against. */
export const analysisOptions = (today?: string): AnalyzeOptions => ({
  today, pillars: PILLARS.map((p) => ({ slug: p.slug, name: p.name, share: p.share })),
});

// ---- loading ------------------------------------------------------------------------------------------------

export const chunks = <T>(list: T[], n = 80) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));

async function inChunks<T>(db: SupabaseClient, table: string, column: string, ids: string[], what: string, order?: string): Promise<T[]> {
  const out: T[] = [];
  for (const part of chunks(ids)) {
    let q = db.from(table).select("*").in(column, part);
    if (order) q = q.order(order);
    out.push(...(must(await q, what) as T[]));
  }
  return out;
}

export async function listSeasons(db: SupabaseClient): Promise<SeasonRow[]> {
  return must(await db.from("gtm_seasons").select("*").order("starts_on"), "seasons") as SeasonRow[];
}

/** The season running on `today`; else the next one to start; else the latest one. Seasons sorted by starts_on. */
export function currentSeason<T extends { starts_on: string; ends_on: string }>(all: T[], today: string): T | undefined {
  return all.find((s) => s.starts_on <= today && today <= s.ends_on) ?? all.find((s) => s.starts_on > today) ?? all.at(-1);
}

/** A season by id, or the current one (see currentSeason). Throws plainly when there is none. */
export async function resolveSeason(db: SupabaseClient, id: string | undefined, today: string): Promise<SeasonRow> {
  if (id) {
    const season = must(await db.from("gtm_seasons").select("*").eq("id", id).maybeSingle(), "season") as SeasonRow | null;
    if (!season) throw new Error(`no season "${id}"`);
    return season;
  }
  const season = currentSeason(await listSeasons(db), today);
  if (!season) throw new Error("no seasons yet");
  return season;
}

/** Reads a Season and everything under it. Works with the owner's session (RLS) or the service role. */
export async function loadSeasonRaw(db: SupabaseClient, id: string): Promise<SeasonRaw> {
  const season = must(await db.from("gtm_seasons").select("*").eq("id", id).maybeSingle(), "season") as SeasonRow | null;
  if (!season) throw new Error(`no season "${id}"`);
  const stories = must(await db.from("gtm_stories").select("id,title,season_id").eq("season_id", id).order("id"), "season stories") as StoryRow[];
  const cal = await activeCalendar(db);
  const inSeason = new Set(stories.map((s) => s.id));
  const items = cal.items.filter((i) => (i.date >= season.starts_on && i.date <= season.ends_on) || (i.story_id && inSeason.has(i.story_id)));
  const wanted = new Set(items.flatMap((i) => i.story_assets ?? []));
  const byStory = stories.length ? await inChunks<StoryAsset>(db, "gtm_story_assets", "story_id", stories.map((s) => s.id), "season assets") : [];
  const byId = wanted.size ? await inChunks<StoryAsset>(db, "gtm_story_assets", "id", [...wanted], "item assets") : [];
  const assets = [...new Map([...byStory, ...byId].map((a) => [a.id, a])).values()];
  const ids = assets.map((a) => a.id);
  const [reviews, versions, feedback] = ids.length
    ? await Promise.all([
        inChunks<StoryChannel>(db, "gtm_story_asset_channels", "asset_id", ids, "approvals"),
        inChunks<VersionRow>(db, "gtm_story_asset_versions", "asset_id", ids, "versions", "revision"),
        inChunks<FeedbackRow>(db, "gtm_story_feedback", "asset_id", ids, "feedback", "created_at"),
      ])
    : [[], [], []];
  return { season, stories, assets, reviews, versions, feedback, items };
}

/** Load, normalize and analyze in one call: what the review screen and `gtm season` use. */
export async function loadSeason(db: SupabaseClient, id: string, today?: string): Promise<{ raw: SeasonRaw; input: SeasonInput; analysis: SeasonAnalysis }> {
  const raw = await loadSeasonRaw(db, id);
  const input = buildSeasonInput(raw);
  // Media that will not play or load (the daily audit, `gtm media audit`, or a player that failed in the browser) is a
  // BLOCK at the top of the findings, linked to its piece, whatever season it belongs to. A failed read never hides
  // the season analysis.
  const { loadUnplayable, withMediaChecks } = await import("./media-audit");
  const media = await loadUnplayable(db).catch(() => []);
  // Approved posts the last auto-schedule passes could not schedule, with the reason (lib/schedule-report.ts).
  const { loadScheduleReport, withScheduleChecks } = await import("./schedule-report");
  const report = await loadScheduleReport(db).catch(() => null);
  return { raw, input, analysis: withScheduleChecks(withMediaChecks(analyzeSeason(input, analysisOptions(today)), media), report) };
}

// ---- report -------------------------------------------------------------------------------------------------

const pad = (s: string | number, n: number) => String(s).padEnd(n);
const counts = (c: { approved: number; needsApproval: number; needsChanges: number }) => `${c.approved} approved, ${c.needsApproval} to approve, ${c.needsChanges} to change`;

/** A terminal-sized report of the analysis, for humans. `--json` prints the object itself. */
export function formatSeasonReport(input: SeasonInput, a: SeasonAnalysis): string {
  const { season } = input;
  const p = a.pipeline;
  const out: string[] = [];
  out.push(`${season.title}  (${season.id})`);
  out.push(`${season.starts_on} to ${season.ends_on}: ${a.dateRange.days} days, ${a.dateRange.weeks} weeks${a.dateRange.currentWeek ? `, now week ${a.dateRange.currentWeek}` : a.dateRange.phase !== "unknown" ? `, ${a.dateRange.phase}` : ""}`);
  out.push(`Pillars: ${season.pillars.join(", ") || "none selected"}`);
  if (season.description) out.push(season.description);
  out.push("", "PIPELINE");
  out.push(`${p.pieces} pieces, ${p.cards} platform cards (${p.unstagedCards} not staged), ${p.piecesFullyApproved} pieces fully approved, ${p.percentComplete}% of ${p.parts.total} parts approved`);
  out.push(`Parts: ${counts(p.parts)}. Open notes: ${p.openNotes}. Approvals gone stale: ${p.staleApprovals}.`);
  for (const [platform, c] of Object.entries(p.byPlatform)) {
    out.push(`  ${pad(platform, 11)} ${c.cards} cards | text: ${counts(c.text)} | asset: ${counts(c.asset)}, ${c.asset.none} without asset`);
  }
  out.push("", `${pad("slot date", 11)}${pad("piece", 44)}${pad("pillar", 12)}${pad("state", 14)}${pad("done", 6)}versions`);
  for (const r of p.pieceRows) out.push(`${pad(r.date, 11)}${pad(r.id.slice(0, 42), 44)}${pad(r.pillar ?? "-", 12)}${pad(r.state, 14)}${pad(`${r.percentComplete}%`, 6)}${r.versionLabels.join(", ")}`);
  out.push("", `LEFT TO DO (${p.remaining.length}, soonest first)`);
  for (const s of p.remaining.slice(0, 25)) out.push(`  ${s.date} ${pad(s.platform, 10)} ${pad(s.pieceId.slice(0, 40), 41)} ${s.detail}`);
  if (p.remaining.length > 25) out.push(`  ... and ${p.remaining.length - 25} more (--json for all)`);
  out.push("", "CADENCE");
  out.push(`${a.cadence.plannedSlots} of ${a.cadence.targetSlots} slots planned (${a.cadence.targetPerWeek} a week); ${a.cadence.openSlots} open. Gaps: ${a.cadence.gaps.length ? `week ${a.cadence.gaps.join(", ")}` : "none"}`);
  out.push(`  ${a.cadence.weeks.map((w) => `W${w.index}:${w.socialPieces}`).join("  ")}`);
  if (a.dateRange.outsideRange.length) out.push(`  Outside the season dates: ${a.dateRange.outsideRange.join(", ")}`);
  out.push("", "PILLAR MIX (share of pieces vs the Content Guide)");
  for (const r of a.pillars.rows) out.push(`  ${pad(r.name, 12)} ${pad(`${r.count} pieces`, 10)} ${pad(`${r.share}%`, 7)} target ${pad(`${r.target}%`, 7)} ${pad(`${r.delta > 0 ? "+" : ""}${r.delta}`, 6)} ${r.selected ? r.status : "not selected"}${r.toGo ? `, ${r.toGo} to go` : ""}`);
  out.push("", `FINDINGS: ${a.summary.block} block, ${a.summary.warn} warn, ${a.summary.info} info`);
  for (const c of a.checks) out.push(`  [${c.severity}${c.status === "review" ? ", needs review" : ""}] ${c.id}${c.pieceId ? ` ${c.pieceId}` : ""}${c.platform ? ` (${c.platform})` : ""}: ${c.message}`);
  return out.join("\n");
}
