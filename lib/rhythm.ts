import { loadContent } from "../lib/content-overlay.mjs";
// The weekly rhythm (John, 2026-10-17): every weekday has a pillar, a day takes a piece from its primary pillar or,
// when none is ready, from its fallback, and the house rules keep the week varied. Pure and client-safe: the
// calendar headers, the week's lint strip, `gtm calendar lint` and auto-schedule all read it.
//   Mon Perspective (fb Lists)  Tue Proof (fb Build)  Wed Build (fb Proof)  Thu Voices (fb Proof)
//   Fri Lists (fb Build, Proof)  Sat Reels, IG and YouTube only  Sun off
// The day map lives in content/guide/channels.json ("rhythm"); looks and topics per Story in config/piece-traits.json.
const channelsJson = loadContent("guide/channels.json") as typeof import("../content/sample/guide/channels.json");
const traitsJson = loadContent("config/piece-traits.json") as typeof import("../content/sample/config/piece-traits.json");
import { addDays, mondayOf } from "./week";

export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];
/** A pillar, or one of the two format lanes: voices (a podcast talking head) and reels (a footage or voiceover reel). */
export type Lane = "perspective" | "proof" | "build" | "lists" | "voices" | "reels";
export type RhythmDay = { day: Weekday; primary: Lane | null; fallback: Lane[]; channels: string[]; note: string };
export type Look = "prism" | "voiceover" | "talking-head" | "footage" | "text";
export type Traits = { look?: Look; topic?: string };

export const RHYTHM = (channelsJson as unknown as { rhythm: { days: RhythmDay[]; rules: string[]; summary: string } }).rhythm;
const TRAITS = (traitsJson as { pieces: Record<string, Traits> }).pieces;

export const LANE_LABEL: Record<Lane, string> = { perspective: "Perspective", proof: "Proof", build: "Build", lists: "Lists", voices: "Voices", reels: "Reels" };
export const LOOK_LABEL: Record<Look, string> = { prism: "Prism Light", voiceover: "voiceover reel", "talking-head": "talking head", footage: "footage", text: "text" };

/** "Mon".."Sun" of an ISO date. */
export function weekdayOf(iso: string): Weekday {
  return WEEKDAYS[(new Date(`${iso}T12:00:00Z`).getUTCDay() + 6) % 7];
}

export function rhythmDay(isoOrWeekday: string): RhythmDay {
  const day = (WEEKDAYS as readonly string[]).includes(isoOrWeekday) ? isoOrWeekday : weekdayOf(isoOrWeekday);
  return RHYTHM.days.find((d) => d.day === day)!;
}

/** The labels a day header shows: its primary pillar and its fallbacks. Sunday is "Off". */
export function dayLabels(isoOrWeekday: string): { primary: string; fallback: string[] } {
  const d = rhythmDay(isoOrWeekday);
  return { primary: d.primary ? LANE_LABEL[d.primary] : "Off", fallback: d.fallback.map((l) => LANE_LABEL[l]) };
}

/** The talking-head Stories: Example Series, Coherence, and John's own podcast clips (season pieces 13 to 17). */
const TALKING_HEAD = /^(s1-\d+-sn-|sn-|coherence-|s1-1[3-7]-)/;

/** A piece's look on a given leg: carousels and documents are Prism Light, text and image posts are text; video reads the traits file. */
export function lookOf(storyId: string | null, format: string): Look {
  if (/carousel|document/.test(format)) return "prism";
  if (format === "text" || format === "image") return "text";
  const set = storyId ? TRAITS[storyId]?.look : undefined;
  if (set) return set;
  return storyId && TALKING_HEAD.test(storyId) ? "talking-head" : "footage";
}

export function topicOf(storyId: string | null): string | null {
  return (storyId && TRAITS[storyId]?.topic) || null;
}

/** The lanes a piece can fill: its pillar, plus voices for a talking head and reels for a footage or voiceover reel. */
export function lanesOf(pillar: string | null, looks: Look[]): Lane[] {
  const out: Lane[] = [];
  if (pillar && ["perspective", "proof", "build", "lists"].includes(pillar)) out.push(pillar as Lane);
  if (looks.includes("talking-head")) out.push("voices");
  if (looks.some((l) => l === "voiceover" || l === "footage")) out.push("reels");
  return out;
}

/** How well a piece fits a day: 0 primary, 1+ fallback position, -1 not at all (and Sunday never). */
export function fitRank(isoOrWeekday: string, lanes: Lane[]): number {
  const d = rhythmDay(isoOrWeekday);
  if (!d.primary) return -1;
  if (lanes.includes(d.primary)) return 0;
  const i = d.fallback.findIndex((l) => lanes.includes(l));
  return i < 0 ? -1 : i + 1;
}

/** The piece a row belongs to: its Story, or for a row with no Story its id without the channel suffix (like heldBy). */
export function pieceKeyOf(storyId: string | null | undefined, id: string): string {
  return storyId ?? id.replace(/-(linkedin|instagram|youtube|newsletter|website)$/, "");
}

/** `--weeks` for `gtm calendar lint`: a whole number from 1 to 52, else an error that says so. */
export function parseWeeks(raw: string | undefined, fallback = 4): number {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 52) throw new Error(`--weeks must be a whole number from 1 to 52 (got ${JSON.stringify(raw)})`);
  return Number(raw);
}

/** A YYYY-MM-DD that names a day on the calendar (2026-13-01 and 2026-02-30 do not). */
export function isRealDate(raw: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const t = Date.parse(`${raw}T12:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === raw;
}

/** May this channel post on that day? LinkedIn is weekdays only, Saturday is IG and YouTube, Sunday is off. */
export function channelAllowed(isoOrWeekday: string, channel: string): boolean {
  return rhythmDay(isoOrWeekday).channels.includes(channel);
}

// ---- lint ----------------------------------------------------------------------------------------------------

/** The fields the lint needs from a calendar row (lib/posts Post and lib/calendar Item both fit). */
export type LintPost = {
  id: string; date: string; channels: string[]; status: string; pillar: string | null; format: string;
  storyId: string | null; title: string; caption?: string | null;
};
export type Severity = "error" | "warn";
export type Rule = "one-piece" | "split" | "channel-day" | "pillar-fit" | "talking-heads" | "voiceover" | "look-adjacent" | "prism-cap" | "topic" | "caption";
export type Issue = { severity: Severity; rule: Rule; date: string; message: string; ids: string[] };
/** One piece on one day: a Story's (or loose item's) legs that share a date. */
export type DayPiece = { key: string; storyId: string | null; date: string; title: string; pillar: string | null; channels: string[]; looks: Look[]; topic: string | null; lanes: Lane[]; ids: string[]; published: boolean };
export type WeekReport = {
  monday: string; pieces: number; issues: Issue[];
  counts: { talkingHeads: number; voiceoverReels: number; prism: number };
};

const live = (p: LintPost) => p.status !== "skipped";
const days = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const short = (iso: string) => `${weekdayOf(iso)} ${Number(iso.slice(8))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;
/** Legs of one Story further apart than this are separate posts (an essay a month before its clip), not a split piece. */
const SPLIT_WINDOW_DAYS = 14;

/** Groups calendar rows into pieces per day. Skipped rows (killed or dropped legs) are not on the calendar. */
export function piecesByDay(posts: LintPost[]): DayPiece[] {
  const map = new Map<string, DayPiece>();
  for (const p of posts.filter(live)) {
    const key = `${pieceKeyOf(p.storyId, p.id)}|${p.date}`;
    const look = lookOf(p.storyId, p.format);
    const piece = map.get(key) ?? { key, storyId: p.storyId, date: p.date, title: p.title, pillar: p.pillar, channels: [], looks: [], topic: topicOf(p.storyId), lanes: [], ids: [], published: true };
    piece.channels.push(...p.channels.filter((c) => !piece.channels.includes(c)));
    if (!piece.looks.includes(look)) piece.looks.push(look);
    piece.ids.push(p.id);
    piece.published &&= p.status === "published";
    map.set(key, piece);
  }
  for (const piece of map.values()) piece.lanes = lanesOf(piece.pillar, piece.looks);
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key));
}

/** The look a piece shows on the grids that matter (LinkedIn and Instagram), or null when it is on neither. */
const gridLooks = (piece: DayPiece, posts: LintPost[]) => {
  const legs = posts.filter((p) => live(p) && piece.ids.includes(p.id) && p.channels.some((c) => c === "linkedin" || c === "instagram"));
  return [...new Set(legs.map((p) => lookOf(p.storyId, p.format)))];
};

/**
 * Lints `weeks` Monday-to-Sunday weeks from `from` (any date; snapped to its Monday) against the house rules.
 * `posts` may reach past the range: the neighbours are what the topic and adjacent-look rules compare against.
 */
export function lintCalendar(posts: LintPost[], from: string, weeks = 1): WeekReport[] {
  const pieces = piecesByDay(posts);
  const start = mondayOf(from);
  const reports: WeekReport[] = [];
  for (let w = 0; w < weeks; w++) {
    const monday = addDays(start, w * 7);
    const sunday = addDays(monday, 6);
    const inWeek = pieces.filter((p) => p.date >= monday && p.date <= sunday);
    const issues: Issue[] = [];
    const add = (i: Issue) => issues.push(i);

    // 1. One piece a day, every channel of a piece the same day, each channel on a day it posts.
    for (let d = 0; d < 7; d++) {
      const date = addDays(monday, d);
      const today = inWeek.filter((p) => p.date === date);
      if (today.length > 1) add({ severity: "error", rule: "one-piece", date, ids: today.flatMap((p) => p.ids), message: `${short(date)} has ${today.length} pieces: ${today.map((p) => p.title).join(" / ")}` });
      for (const p of today) {
        const off = p.channels.filter((c) => !channelAllowed(date, c) && ["linkedin", "instagram", "youtube"].includes(c));
        if (off.length && !p.published) add({ severity: "warn", rule: "channel-day", date, ids: p.ids, message: `${p.title}: ${off.join(", ")} does not post on ${weekdayOf(date)}` });
        const noPillar = !p.pillar || !["perspective", "proof", "build", "lists"].includes(p.pillar);
        if (!p.published && (fitRank(date, p.lanes) < 0 || noPillar) && rhythmDay(date).primary) {
          const l = dayLabels(date);
          const missing = !p.pillar || !["perspective", "proof", "build", "lists"].includes(p.pillar);
          add({ severity: "warn", rule: "pillar-fit", date, ids: p.ids, message: missing
            ? `${p.title} has ${p.pillar ? `an unknown pillar (${p.pillar})` : "no pillar"}; set one of perspective, proof, build, lists`
            : `${short(date)} is ${l.primary}${l.fallback.length ? ` (fallback ${l.fallback.join(", ")})` : ""}; ${p.title} is ${p.lanes.map((x) => LANE_LABEL[x]).join("/")}` });
        }
      }
    }
    const storiesHere = [...new Set(inWeek.map((p) => p.storyId).filter((s): s is string => !!s))];
    for (const s of storiesHere) {
      for (const here of inWeek.filter((p) => p.storyId === s && !p.published)) {
        // The other legs of this piece within the window, on another day, that were not already reported from an earlier week.
        const near = pieces.filter((p) => p.storyId === s && p.date !== here.date && Math.abs(days(p.date, here.date)) <= SPLIT_WINDOW_DAYS);
        if (!near.length || near.some((p) => p.date < here.date && p.date >= monday && !p.published)) continue;
        const dates = [...new Set([here.date, ...near.map((p) => p.date)])].sort();
        if (days(dates[0], dates.at(-1)!) <= 1) continue;
        add({ severity: "warn", rule: "split", date: here.date, ids: [here, ...near].flatMap((p) => p.ids), message: `${here.title} goes out on ${dates.map(short).join(", ")}; keep its channels on one day` });
      }
    }

    // 2. Two talking heads a week. 3. At most one voiceover reel. 4b. At most two Prism Light pieces.
    const talkingHeads = inWeek.filter((p) => p.looks.includes("talking-head")).length;
    const voiceoverReels = new Set(inWeek.filter((p) => p.looks.includes("voiceover")).map((p) => p.storyId ?? p.key)).size;
    const prism = inWeek.filter((p) => gridLooks(p, posts).includes("prism")).length;
    if (inWeek.length && (talkingHeads < 1 || talkingHeads > 3)) add({ severity: "warn", rule: "talking-heads", date: monday, ids: [], message: `${talkingHeads} talking heads this week; the rhythm wants 2 (Mon and Thu)` });
    if (voiceoverReels > 1) add({ severity: "error", rule: "voiceover", date: monday, ids: inWeek.filter((p) => p.looks.includes("voiceover")).flatMap((p) => p.ids), message: `${voiceoverReels} voiceover reels this week; at most 1` });
    if (prism > 2) add({ severity: "warn", rule: "prism-cap", date: monday, ids: [], message: `${prism} Prism Light pieces this week; at most 2` });

    // 4a. No two days in a row with the same look on LinkedIn or Instagram (Sunday before the week counts).
    for (let d = 0; d < 7; d++) {
      const date = addDays(monday, d);
      const prev = addDays(date, -1);
      const look = (iso: string) => pieces.filter((p) => p.date === iso).flatMap((p) => gridLooks(p, posts));
      const shared = look(date).filter((l) => look(prev).includes(l));
      if (shared.length) add({ severity: "warn", rule: "look-adjacent", date, ids: pieces.filter((p) => p.date === date || p.date === prev).flatMap((p) => p.ids), message: `${short(prev)} and ${short(date)} both look like ${shared.map((l) => LOOK_LABEL[l]).join(", ")}` });
    }

    // 5. Same topic: at least one clear day between; Orion a week.
    for (const p of inWeek) {
      if (!p.topic) continue;
      const gap = ["orion", "sample-featured-topic"].includes(p.topic) ? 7 : 2;
      const near = pieces.filter((q) => q.topic === p.topic && q.storyId !== p.storyId && q.date < p.date && days(q.date, p.date) < gap);
      for (const q of near) add({ severity: "warn", rule: "topic", date: p.date, ids: [...q.ids, ...p.ids], message: `${p.title} (${short(p.date)}) is ${days(q.date, p.date)} day${days(q.date, p.date) === 1 ? "" : "s"} after ${q.title}, same topic (${p.topic}); keep ${gap === 7 ? "a week" : "a clear day"} between` });
    }

    // 6. LinkedIn caption length.
    for (const p of posts.filter((x) => live(x) && x.date >= monday && x.date <= sunday && x.channels.includes("linkedin") && x.status !== "published" && x.caption)) {
      const n = p.caption!.length;
      if (n > 4000) add({ severity: "error", rule: "caption", date: p.date, ids: [p.id], message: `${p.title}: LinkedIn caption is ${n} characters; LinkedIn rejects over 4,000` });
      else if (n > 3000) add({ severity: "warn", rule: "caption", date: p.date, ids: [p.id], message: `${p.title}: LinkedIn caption is ${n} characters; keep it under 3,000` });
    }

    issues.sort((a, b) => a.date.localeCompare(b.date) || (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1));
    reports.push({ monday, pieces: inWeek.length, issues, counts: { talkingHeads, voiceoverReels, prism } });
  }
  return reports;
}

/** Weekdays in [from, to] with nothing on them, and what each one wants. Saturday is optional and Sunday is off. */
export function gapsFor(posts: LintPost[], from: string, to: string): Array<{ date: string; day: Weekday; wants: string }> {
  const taken = new Set(posts.filter(live).map((p) => p.date));
  const out: Array<{ date: string; day: Weekday; wants: string }> = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const day = weekdayOf(date);
    if (day === "Sat" || day === "Sun" || taken.has(date)) continue;
    const l = dayLabels(date);
    out.push({ date, day, wants: [l.primary, ...l.fallback].join(", then ") });
  }
  return out;
}
