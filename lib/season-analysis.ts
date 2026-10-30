// Season analysis: pure functions over a normalized Season. No database, no clock (pass `today`).
// `analyzeSeason` answers four questions for the review screen and `gtm season`:
//   pipeline  what is approved, which version each asset is on, how much is left
//   cadence   the date range, pieces per week against the 3 a week target, gaps, Orion/Coherence spacing
//   pillars   the mix against the Content Guide shares (content/guide/pillars.json)
//   checks    format-mix and guardrail rules from gtm/content/STRATEGY.md that a machine can verify
// Rules a machine cannot verify (a list of people with no gender recorded) come back as findings with
// status "review" rather than a guess. lib/seasons.ts builds the input from the database.
import { findAgentNotes, findBritishSpellings } from "./copy-guard";
import { findUrls } from "./channel-rules";
import { splitFrontmatter } from "./render-copy";
import { mondayOf, seasonWeek, seasonWeekCount, seasonWeekStart } from "./week";

export type PieceFormat = "video" | "carousel" | "text" | "image" | "other";
/** A part (a card's text, or its media) as the owner sees it. `none` = the card has no such part. */
export type PartState = "approved" | "needs-approval" | "needs-changes" | "none";
export type Person = { name: string; gender?: "woman" | "man" | "nonbinary" | "unknown" | null };

export type VersionInput = { assetId: string; kind: "copy" | "video" | "image" | "link"; label: string; revision: number; versions: number };
export type CardInput = {
  platform: string;
  itemId?: string | null;
  itemStatus?: string | null;
  date: string; // YYYY-MM-DD, the platform post's slot
  time?: string | null;
  format: PieceFormat;
  /** False when the calendar item has no Story behind it yet, so there is nothing to approve. */
  staged: boolean;
  text: PartState;
  asset: PartState;
  /** Approvals that no longer match the staged bytes (counted in needs-approval, flagged separately). */
  staleApprovals?: number;
  versions: VersionInput[];
  openNotes: number;
  /** The platform's copy file as staged (frontmatter allowed). */
  copy?: string | null;
};
export type PieceInput = {
  id: string;
  title: string;
  slot?: string;
  date: string;
  pillar: string | null;
  format: PieceFormat;
  platforms: string[];
  cards: CardInput[];
  storyId?: string | null;
  /** Named people on a list of people, with gender when known. Absent when nobody recorded it. */
  people?: Person[] | null;
  /** Date the piece's facts (GitHub stars) were pulled, YYYY-MM-DD, when the copy says so. */
  factsAsOf?: string | null;
  /** How many women the copy says a list of people includes ("Five of them are women"); the check still wants names for the record. */
  womenStated?: number | null;
  mentionsStars?: boolean;
  inSeasonStories?: boolean;
};
export type SeasonRecord = { id: string; title: string; description: string; starts_on: string; ends_on: string; pillars: string[] };
export type SeasonInput = { season: SeasonRecord; pieces: PieceInput[] };

export type Severity = "block" | "warn" | "info";
export type Check = {
  id: string;
  severity: Severity;
  /** fail = a rule is broken; review = a machine cannot decide, a person must. */
  status: "fail" | "review";
  message: string;
  pieceId?: string;
  platform?: string;
  /** The Story behind the piece, when it has one: the finding links to it in /content. */
  storyId?: string;
};

export type PartCounts = { approved: number; needsApproval: number; needsChanges: number; none: number };
export type PlatformCounts = { cards: number; text: PartCounts; asset: PartCounts };
export type PiecePipeline = {
  id: string; title: string; slot: string; date: string; pillar: string | null; format: PieceFormat; platforms: string[];
  state: "approved" | "needs-changes" | "in-review" | "not-staged";
  percentComplete: number;
  /** Current version of each asset, e.g. "image v1.1 x11" (eleven slides at v1.1), "video v1". */
  versionLabels: string[];
  versions: { assetId: string; kind: string; label: string; versions: number }[];
  openNotes: number;
  cards: { platform: string; format: PieceFormat; staged: boolean; text: PartState; asset: PartState; versions: { assetId: string; kind: string; label: string }[]; openNotes: number }[];
};
export type RemainingStep = {
  pieceId: string; platform: string; date: string; part: "text" | "asset" | "notes";
  state: "not-staged" | "needs-approval" | "needs-changes" | "approval-stale" | "open-notes"; detail: string;
};
export type WeekCadence = {
  index: number; start: string; end: string; pieces: string[]; socialPieces: number; linkedinSlots: number; target: number;
  delta: number; status: "gap" | "under" | "on-target" | "over";
};
export type PillarRow = {
  slug: string; name: string; selected: boolean; target: number; count: number; share: number; delta: number;
  expectedForSeason: number; toGo: number; status: "over" | "under" | "on-target";
};

export type SeasonAnalysis = {
  seasonId: string;
  today: string | null;
  pipeline: {
    pieces: number; piecesFullyApproved: number; cards: number; unstagedCards: number;
    parts: { total: number; approved: number; needsApproval: number; needsChanges: number };
    percentComplete: number; openNotes: number; staleApprovals: number;
    byPlatform: Record<string, PlatformCounts>;
    pieceRows: PiecePipeline[];
    remaining: RemainingStep[];
  };
  dateRange: {
    startsOn: string; endsOn: string; days: number; weeks: number; firstSlot: string | null; lastSlot: string | null;
    phase: "before" | "during" | "after" | "unknown"; currentWeek: number | null; outsideRange: string[];
  };
  cadence: {
    targetPerWeek: number; plannedSlots: number; targetSlots: number; openSlots: number; weeks: WeekCadence[]; gaps: number[];
  };
  pillars: { total: number; rows: PillarRow[]; unselectedUsed: string[]; missing: string[] };
  formats: {
    byFormat: Record<string, number>;
    byPlatform: Record<string, Record<string, number>>;
    weeksWithoutCarousel: { platform: string; week: number }[];
  };
  checks: Check[];
  ran: string[];
  summary: { block: number; warn: number; info: number };
};

export type AnalyzeOptions = {
  /** YYYY-MM-DD. Without it phase and currentWeek are unknown. */
  today?: string;
  targetPerWeek?: number;
  /** Guide shares by pillar slug (content/guide/pillars.json). Required: the library does not read files. */
  pillars: { slug: string; name: string; share: number }[];
  /** Percentage points either side of target still counted on target. */
  tolerance?: number;
};

// ---- dates -------------------------------------------------------------------------------------------

const DAY = 86_400_000;
const isoDate = /^\d{4}-\d{2}-\d{2}$/;
export const parseDay = (d: string) => { const [y, m, dd] = d.split("-").map(Number); return Date.UTC(y, m - 1, dd); };
const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const daysBetween = (a: string, b: string) => Math.round((parseDay(b) - parseDay(a)) / DAY);
/** Monday of the week containing `d`. */
export const weekStart = (d: string) => mondayOf(d);
const addDays = (d: string, n: number) => fmt(parseDay(d) + n * DAY);

/** "as of 2026-10-05", "pulled 5 Oct 2026", "as of early Oct 2026" -> YYYY-MM-DD. early/mid/late = the 5th/15th/25th. */
export function extractAsOfDate(text: string): string | null {
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const iso = /\b(?:as of|pulled|retrieved|checked)[^0-9\n]{0,12}(\d{4}-\d{2}-\d{2})\b/i.exec(text);
  if (iso) return iso[1];
  const monthRe = months.map((m) => m).join("|");
  const words = new RegExp(`\\bas of\\s+(?:(early|mid|late)\\s+)?(?:(\\d{1,2})\\s+)?(${monthRe})[a-z]*\\.?(?:\\s+(\\d{1,2})(?:st|nd|rd|th)?)?,?\\s+(\\d{4})\\b`, "i").exec(text);
  if (!words) return null;
  const month = months.indexOf(words[3].toLowerCase().slice(0, 3)) + 1;
  const day = words[2] ?? words[4] ?? ({ early: "5", mid: "15", late: "25" } as Record<string, string>)[(words[1] ?? "").toLowerCase()] ?? "15";
  return `${words[5]}-${String(month).padStart(2, "0")}-${day.padStart(2, "0")}`;
}

// ---- pipeline ----------------------------------------------------------------------------------------

const zeroCounts = (): PartCounts => ({ approved: 0, needsApproval: 0, needsChanges: 0, none: 0 });
function bump(c: PartCounts, s: PartState) {
  if (s === "approved") c.approved++; else if (s === "needs-approval") c.needsApproval++; else if (s === "needs-changes") c.needsChanges++; else c.none++;
}
const latest = (v: VersionInput) => `${v.kind} ${v.label}`;

/** The parts of a card that need approval. An unstaged card counts as one text part still to do. */
function cardParts(card: CardInput): { part: "text" | "asset"; state: PartState }[] {
  if (!card.staged) return [{ part: "text", state: "needs-approval" }];
  const parts: { part: "text" | "asset"; state: PartState }[] = [];
  if (card.text !== "none") parts.push({ part: "text", state: card.text });
  if (card.asset !== "none") parts.push({ part: "asset", state: card.asset });
  return parts;
}

/** A post that already went out, or was skipped, has nothing left to approve or stage. */
const finished = (card: CardInput) => card.itemStatus === "published" || card.itemStatus === "skipped";
const settled = (card: CardInput): CardInput => !finished(card) ? card : { ...card, staged: true, text: card.text === "none" ? "none" : "approved", asset: card.asset === "none" ? "none" : "approved", openNotes: 0, staleApprovals: 0 };

function pipeline(input: SeasonInput) {
  const byPlatform: Record<string, PlatformCounts> = {};
  const remaining: RemainingStep[] = [];
  let total = 0, approved = 0, needsApproval = 0, needsChanges = 0, openNotes = 0, stale = 0, cards = 0, unstaged = 0, fully = 0;
  const pieceRows: PiecePipeline[] = [];
  for (const piece of [...input.pieces].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))) {
    let pTotal = 0, pApproved = 0, pChanges = 0, pNotes = 0;
    for (const raw of piece.cards) {
      const card = settled(raw);
      cards++;
      if (!card.staged) unstaged++;
      const c = (byPlatform[card.platform] ??= { cards: 0, text: zeroCounts(), asset: zeroCounts() });
      c.cards++;
      bump(c.text, card.staged ? card.text : "none");
      bump(c.asset, card.staged ? card.asset : "none");
      if (!card.staged) bump(c.text, "needs-approval"), c.text.none--;
      stale += card.staleApprovals ?? 0;
      pNotes += card.openNotes;
      for (const { part, state } of cardParts(card)) {
        pTotal++;
        if (state === "approved") pApproved++;
        else {
          if (state === "needs-changes") pChanges++;
          const isStale = (card.staleApprovals ?? 0) > 0 && state === "needs-approval";
          remaining.push({
            pieceId: piece.id, platform: card.platform, date: card.date, part,
            state: !card.staged ? "not-staged" : isStale ? "approval-stale" : state === "needs-changes" ? "needs-changes" : "needs-approval",
            detail: !card.staged ? "no Story staged for this calendar item" : state === "needs-changes" ? `${part} needs changes` : isStale ? `${part} changed after approval` : `${part} waiting for approval`,
          });
        }
      }
      if (card.openNotes > 0) remaining.push({ pieceId: piece.id, platform: card.platform, date: card.date, part: "notes", state: "open-notes", detail: `${card.openNotes} open note${card.openNotes === 1 ? "" : "s"}` });
    }
    total += pTotal; approved += pApproved; needsChanges += pChanges; needsApproval += pTotal - pApproved - pChanges; openNotes += pNotes;
    const done = pTotal > 0 && pApproved === pTotal;
    if (done) fully++;
    const assets = new Map<string, VersionInput>();
    for (const card of piece.cards) for (const v of card.versions) assets.set(v.assetId, v);
    const grouped = new Map<string, number>();
    for (const v of assets.values()) grouped.set(latest(v), (grouped.get(latest(v)) ?? 0) + 1);
    pieceRows.push({
      id: piece.id, title: piece.title, slot: piece.slot ?? "", date: piece.date, pillar: piece.pillar, format: piece.format, platforms: piece.platforms,
      state: piece.cards.every((c) => !c.staged) ? "not-staged" : done ? "approved" : pChanges > 0 ? "needs-changes" : "in-review",
      percentComplete: pTotal ? Math.round((100 * pApproved) / pTotal) : 0,
      versionLabels: [...grouped].map(([label, n]) => (n > 1 ? `${label} x${n}` : label)),
      versions: [...assets.values()].map((v) => ({ assetId: v.assetId, kind: v.kind, label: v.label, versions: v.versions })),
      openNotes: pNotes,
      cards: piece.cards.map((c) => ({ platform: c.platform, format: c.format, staged: c.staged, text: c.text, asset: c.asset, versions: c.versions.map((v) => ({ assetId: v.assetId, kind: v.kind, label: v.label })), openNotes: c.openNotes })),
    });
  }
  const order = (s: RemainingStep) => (s.part === "text" ? 0 : s.part === "asset" ? 1 : 2);
  remaining.sort((a, b) => a.date.localeCompare(b.date) || a.platform.localeCompare(b.platform) || order(a) - order(b) || a.pieceId.localeCompare(b.pieceId));
  return {
    pieces: input.pieces.length, piecesFullyApproved: fully, cards, unstagedCards: unstaged,
    parts: { total, approved, needsApproval, needsChanges },
    percentComplete: total ? Math.round((100 * approved) / total) : 0, openNotes, staleApprovals: stale,
    byPlatform, pieceRows, remaining,
  };
}

// ---- analysis ----------------------------------------------------------------------------------------

const SOCIAL = ["linkedin", "instagram", "youtube"];
const isSocial = (p: PieceInput) => p.platforms.some((x) => SOCIAL.includes(x));
const PEOPLE_TITLE = /\b(engineers|people|follow|practitioners|builders|voices|researchers|creators|founders|leaders|experts)\b/i;
export const isPeopleList = (p: PieceInput) => !!p.people?.length || !!p.womenStated || (p.pillar === "lists" && PEOPLE_TITLE.test(p.title));

export function analyzeSeason(input: SeasonInput, opts: AnalyzeOptions): SeasonAnalysis {
  const { season, pieces } = input;
  const target = opts.targetPerWeek ?? 3;
  const tolerance = opts.tolerance ?? 5;
  const checks: Check[] = [];
  const ran: string[] = [];
  const add = (c: Check) => checks.push(c);
  const run = (id: string) => { ran.push(id); };

  // ---- date range and cadence
  const weekCount = seasonWeekCount(season.starts_on, season.ends_on);
  const weeks: WeekCadence[] = Array.from({ length: weekCount }, (_, i) => {
    const start = seasonWeekStart(season.starts_on, i + 1);
    return { index: i + 1, start, end: addDays(start, 6), pieces: [], socialPieces: 0, linkedinSlots: 0, target, delta: 0, status: "gap" as const };
  });
  const weekOf = (date: string) => weeks[seasonWeek(season.starts_on, date) - 1];
  const outsideRange: string[] = [];
  const inRange = (date: string) => date >= season.starts_on && date <= season.ends_on;
  for (const p of pieces) {
    const w = weekOf(p.date);
    if (!inRange(p.date)) outsideRange.push(p.id);
    if (!w) continue;
    w.pieces.push(p.id);
    if (isSocial(p)) w.socialPieces++;
    if (p.platforms.includes("linkedin")) w.linkedinSlots++;
  }
  for (const w of weeks) {
    w.delta = w.socialPieces - target;
    w.status = w.socialPieces === 0 ? "gap" : w.delta < 0 ? "under" : w.delta > 0 ? "over" : "on-target";
  }
  run("date-range");
  for (const id of outsideRange) {
    const p = pieces.find((x) => x.id === id)!;
    // Posts that already went out (or were skipped) are history, not a slot to fix: only a card still to go counts.
    const stray = p.cards.filter((c) => !finished(c) && !inRange(c.date));
    if (p.cards.length && !stray.length) continue;
    add({ id: "date-range", severity: "warn", status: "fail", pieceId: id, message: `${p.title} is slotted ${stray[0]?.date ?? p.date}, outside the season (${season.starts_on} to ${season.ends_on}).` });
  }
  run("cadence");
  // More than the target is fine (John, 2026-10-16), and a week that is over cannot be filled: only upcoming weeks can be short.
  for (const w of weeks.filter((x) => !opts.today || x.end >= opts.today)) {
    if (w.status === "gap") add({ id: "cadence", severity: "warn", status: "fail", message: `Week ${w.index} (${w.start}) has no posts; the target is ${target}.` });
    else if (w.status === "under") add({ id: "cadence", severity: "info", status: "fail", message: `Week ${w.index} (${w.start}) has ${w.socialPieces} of ${target} posts.` });
  }
  const planned = weeks.reduce((n, w) => n + w.socialPieces, 0);

  // ---- pillar mix
  const selected = season.pillars.length ? season.pillars : opts.pillars.map((p) => p.slug);
  const selectedShare = opts.pillars.filter((p) => selected.includes(p.slug)).reduce((n, p) => n + p.share, 0) || 100;
  const counted = pieces.filter((p) => p.pillar);
  const rows: PillarRow[] = opts.pillars.map((p) => {
    const isSel = selected.includes(p.slug);
    const targetShare = isSel ? Math.round((1000 * p.share) / selectedShare) / 10 : 0;
    const count = counted.filter((x) => x.pillar === p.slug).length;
    const share = counted.length ? Math.round((1000 * count) / counted.length) / 10 : 0;
    const delta = Math.round((share - targetShare) * 10) / 10;
    const expectedForSeason = Math.round((targetShare * weekCount * target) / 100);
    return {
      slug: p.slug, name: p.name, selected: isSel, target: targetShare, count, share, delta, expectedForSeason, toGo: Math.max(0, expectedForSeason - count),
      status: Math.abs(delta) <= tolerance ? "on-target" : delta > 0 ? "over" : "under",
    };
  });
  const unselectedUsed = [...new Set(counted.map((p) => p.pillar!).filter((s) => !selected.includes(s)))];
  const missing = pieces.filter((p) => !p.pillar).map((p) => p.id);
  run("pillar-mix"); // measured in `pillars.rows` and shown in the season panel; never a finding (more of one pillar is fine)
  run("pillar-selected");
  for (const slug of unselectedUsed) add({ id: "pillar-selected", severity: "warn", status: "fail", message: `Pieces use the ${slug} pillar, which this season does not select (${pieces.filter((p) => p.pillar === slug).map((p) => p.id).join(", ")}).` });
  run("pillar-set");
  for (const id of missing) add({ id: "pillar-set", severity: "warn", status: "fail", pieceId: id, ...(pieces.find((p) => p.id === id)?.storyId ? { storyId: pieces.find((p) => p.id === id)!.storyId! } : {}), message: `${id} has no pillar; the cockpit files it under untracked.` });
  run("week-pillars");
  for (const w of weeks.filter((x) => !opts.today || x.end >= opts.today)) {
    const ps = pieces.filter((p) => w.pieces.includes(p.id));
    if (!ps.length) continue;
    const pillarsHere = new Set(ps.map((p) => p.pillar).filter(Boolean));
    if (selected.some((s) => s === "proof" || s === "build") && !pillarsHere.has("proof") && !pillarsHere.has("build")) {
      add({ id: "week-pillars", severity: "warn", status: "fail", message: `Week ${w.index} has no Proof or Build slot: a week of opinions with nothing underneath them.` });
    }
  }

  // ---- format mix
  run("format-weekly-carousel");
  const weeksWithoutCarousel: { platform: string; week: number }[] = [];
  for (const platform of ["linkedin", "instagram"]) {
    const missing: number[] = [];
    for (const w of weeks.filter((x) => !opts.today || x.end >= opts.today)) {
      if (!w.pieces.length) continue;
      if (!pieces.some((p) => w.pieces.includes(p.id) && p.cards.some((c) => c.platform === platform && c.format === "carousel"))) missing.push(w.index);
    }
    for (const week of missing) weeksWithoutCarousel.push({ platform, week });
    if (missing.length) add({ id: "format-weekly-carousel", severity: "warn", status: "fail", platform, message: `No carousel on ${platform} in week${missing.length === 1 ? "" : "s"} ${missing.join(", ")}; there should be at least one a week.` });
  }
  const byFormat: Record<string, number> = {};
  const fmtByPlatform: Record<string, Record<string, number>> = {};
  for (const p of pieces) byFormat[p.format] = (byFormat[p.format] ?? 0) + 1;
  for (const p of pieces) for (const c of p.cards) {
    const m = (fmtByPlatform[c.platform] ??= {});
    m[c.format] = (m[c.format] ?? 0) + 1;
  }

  // ---- guardrails, per card
  for (const id of ["placeholder", "dash", "british-spelling", "hashtags", "channel-link", "not-staged"]) run(id);
  for (const piece of pieces) for (const raw of piece.cards) {
    const card = settled(raw);
    const where = { pieceId: piece.id, platform: card.platform, ...(piece.storyId ? { storyId: piece.storyId } : {}) };
    if (!card.staged) { add({ id: "not-staged", severity: "info", status: "fail", ...where, message: `${piece.id} on ${card.platform} has no Story staged, so there is nothing to review yet.` }); continue; }
    if (card.copy == null) continue;
    const { prose } = splitFrontmatter(card.copy);
    const notes = findAgentNotes(card.copy);
    if (notes.length) add({ id: "placeholder", severity: "block", status: "fail", ...where, message: `${notes.length} unresolved note${notes.length === 1 ? "" : "s"} to John in the ${card.platform} copy: ${notes.slice(0, 3).map((n) => n.slice(0, 70)).join(" | ")}` });
    if (/[—–]/.test(card.copy)) add({ id: "dash", severity: "block", status: "fail", ...where, message: `The ${card.platform} copy has an em or en dash; John's copy never does.` });
    const british = findBritishSpellings(card.copy);
    if (british.length) add({ id: "british-spelling", severity: "warn", status: "fail", ...where, message: `British spelling in the ${card.platform} copy (John writes American): ${british.join(", ")}` });
    const tags = (prose.match(/(?:^|\s)#[\p{L}][\p{L}\p{N}_]*/gu) ?? []).length;
    if (card.platform === "linkedin" && tags > 2) add({ id: "hashtags", severity: "warn", status: "fail", ...where, message: `${tags} hashtags on LinkedIn; the limit is 2.` });
    // Advice for a draft: once John has approved the text it is final, and he approves exactly what he wants posted.
    if (card.platform === "instagram" && card.text !== "approved" && (tags < 3 || tags > 5)) add({ id: "hashtags", severity: "warn", status: "fail", ...where, message: `${tags} hashtags on Instagram; use 3 to 5 keyword tags.` });
    if (card.platform === "linkedin" || card.platform === "instagram") {
      const urls = findUrls(prose);
      if (urls.length) add({ id: "channel-link", severity: "block", status: "fail", ...where, message: card.platform === "linkedin"
        ? `The LinkedIn body has a link (${urls.slice(0, 2).join(", ")}); move it to the first comment.`
        : `The Instagram caption has a link (${urls.slice(0, 2).join(", ")}); captions never carry links.` });
    }
  }

  // ---- representation and stale facts, per piece
  run("representation");
  for (const piece of pieces.filter(isPeopleList)) {
    const people = piece.people ?? [];
    if (!people.length && (piece.womenStated ?? 0) > 0) continue; // the piece states how many women it lists
    if (!people.length) {
      add({ id: "representation", severity: "info", status: "review", pieceId: piece.id, ...(piece.storyId ? { storyId: piece.storyId } : {}), message: `Needs human review: ${piece.title} looks like a list of people, and no names with genders were supplied. Every list of people must include women.` });
      continue;
    }
    const women = people.filter((x) => x.gender === "woman").length;
    const unknown = people.filter((x) => !x.gender || x.gender === "unknown").length;
    if (women > 0) continue;
    if (unknown > 0) add({ id: "representation", severity: "info", status: "review", pieceId: piece.id, ...(piece.storyId ? { storyId: piece.storyId } : {}), message: `Needs human review: ${unknown} of ${people.length} names in ${piece.title} have no gender recorded and none is a woman.` });
    else add({ id: "representation", severity: "block", status: "fail", pieceId: piece.id, ...(piece.storyId ? { storyId: piece.storyId } : {}), message: `${piece.title} lists ${people.length} people and none is a woman. Never publish a list of people that is all men.` });
  }
  run("stale-facts");
  for (const piece of pieces) {
    if (piece.factsAsOf) {
      if (!isoDate.test(piece.factsAsOf)) { add({ id: "stale-facts", severity: "info", status: "review", pieceId: piece.id, ...(piece.storyId ? { storyId: piece.storyId } : {}), message: `Needs human review: ${piece.id} has an unreadable as-of date (${piece.factsAsOf}).` }); continue; }
      const age = daysBetween(piece.factsAsOf, piece.date);
      if (age > 14) add({ id: "stale-facts", severity: "warn", status: "fail", pieceId: piece.id, ...(piece.storyId ? { storyId: piece.storyId } : {}), message: `${piece.title}: facts (stars) are as of ${piece.factsAsOf}, ${age} days before the ${piece.date} slot; refresh within 14 days of posting.` });
    } else if (piece.mentionsStars) {
      add({ id: "stale-facts", severity: "info", status: "review", pieceId: piece.id, ...(piece.storyId ? { storyId: piece.storyId } : {}), message: `Needs human review: ${piece.title} quotes GitHub stars but states no as-of date.` });
    }
  }

  const summary = { block: 0, warn: 0, info: 0 };
  for (const c of checks) summary[c.severity]++;
  const rank = { block: 0, warn: 1, info: 2 };
  checks.sort((a, b) => rank[a.severity] - rank[b.severity] || a.id.localeCompare(b.id) || (a.pieceId ?? "").localeCompare(b.pieceId ?? ""));

  const slots = pieces.map((p) => p.date).sort();
  const today = opts.today ?? null;
  const week = today ? weekOf(today) : undefined;
  return {
    seasonId: season.id, today,
    pipeline: pipeline(input),
    dateRange: {
      startsOn: season.starts_on, endsOn: season.ends_on, days: daysBetween(season.starts_on, season.ends_on) + 1, weeks: weekCount,
      firstSlot: slots[0] ?? null, lastSlot: slots.at(-1) ?? null,
      phase: !today ? "unknown" : today < season.starts_on ? "before" : today > season.ends_on ? "after" : "during",
      currentWeek: week?.index ?? null, outsideRange,
    },
    cadence: {
      targetPerWeek: target, plannedSlots: planned, targetSlots: weekCount * target, openSlots: Math.max(0, weekCount * target - planned),
      weeks, gaps: weeks.filter((w) => w.status === "gap").map((w) => w.index),
    },
    pillars: { total: counted.length, rows, unselectedUsed, missing },
    formats: { byFormat, byPlatform: fmtByPlatform, weeksWithoutCarousel },
    checks, ran, summary,
  };
}
