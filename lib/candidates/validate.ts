// Validation for `gtm candidates put` and for John's inline edits (VIB-420). A put is all or nothing: one
// failing candidate stops the whole write, so a half-checked week never lands in the cockpit.
//
// Errors: shape (slug, format, lens, pillar, channels), the payload a format needs (slides.json in the
// vibrana-carousel schema, a video hook and at least three beats), at least one http(s) source, and the
// voice guard: no em or en dashes anywhere, no banned word or phrase from content/guide/voice.json, no link
// in the post text (LinkedIn links go in the first comment, Instagram never has one).
// Warnings: British spellings, hashtags over LinkedIn's two, slide counts outside 6 to 10, a missing rubric.
// [JOHN: ...] slots are counted, not refused (an idea promoted from the backlog carries one). Agent drafts no longer
// write them (John, 2026-10-13): the routine makes the call or cuts the line and asks in its report instead.
import { findUrls } from "../channel-rules";
import { findAgentNotes, findBritishSpellings } from "../copy-guard";
import { splitFrontmatter } from "../frontmatter";
import { VOICE } from "../guide/content";
import { CANDIDATE_CHANNELS, CANDIDATE_PILLARS, FORMATS, LENSES, type CandidateFormat, type CandidatePillar, type Lens, type Source } from "./select";

export type SlideDeck = { template: string; slides: Record<string, unknown>[]; [k: string]: unknown };
export type VideoScript = { hook: string; beats: string[]; lines?: string };
export type Rubric = { overall?: "pass" | "fail"; rounds?: number; fails?: string[]; criteria?: Record<string, unknown>; persona_review?: string; [k: string]: unknown };

export type CandidateInput = {
  slug: string; title: string; format: CandidateFormat; lens: Lens; pillar: CandidatePillar; channels?: string[];
  body: string; instagram?: string | null; slides?: SlideDeck | null; video?: VideoScript | null;
  sources: Source[]; rubric?: Rubric | null; score?: number | null; playbook?: { hook?: string; story?: string; cta?: string } | null;
  signal_id?: string | null; report_action_id?: string | null; position?: number;
};
export type Problems = { errors: string[]; warnings: string[]; john_slots: number };

const TEMPLATES = ["listicle", "case-study", "framework"] as const;
const SLIDE_TYPES = new Set(["cover", "item", "text", "quote", "cta", "context", "stat", "stats", "approach", "image", "overview", "step"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DASH = /[\u2014\u2013]/;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Entries with a qualifier ("landscape (as metaphor)") need judgment, so only the writers room's rubric carries them.
const plain = (list: string[]) => list.filter((w) => !w.includes("(")).map((w) => w.trim().toLowerCase());
const BANNED: [string, RegExp][] = [
  ...plain(VOICE.banned_words).map((w): [string, RegExp] => [w, new RegExp(w.includes(" ") || w.includes("-") ? `\\b${esc(w)}\\b` : `\\b${esc(w)}(?:s|d|ed|es|ing|r|rs)?\\b`, "i")]),
  ...plain(VOICE.banned_phrases).map((p): [string, RegExp] => [p, new RegExp(`\\b${esc(p)}\\b`, "i")]),
];

/** Every string inside a JSON value, so a deck's slides are checked as thoroughly as the post text. */
export function stringsOf(x: unknown): string[] {
  if (typeof x === "string") return [x];
  if (Array.isArray(x)) return x.flatMap(stringsOf);
  if (x && typeof x === "object") return Object.values(x).flatMap(stringsOf);
  return [];
}

/** The voice guard on one piece of text: dashes and banned words are errors, British spellings warnings. */
export function voiceProblems(where: string, text: string, p: Problems) {
  if (DASH.test(text)) p.errors.push(`${where}: has an em or en dash ("${text.match(new RegExp(`.{0,24}${DASH.source}.{0,24}`))?.[0] ?? ""}"); use a comma, a colon or two sentences`);
  for (const [word, re] of BANNED) if (re.test(text)) p.errors.push(`${where}: uses the banned "${word}" (content/guide/voice.json)`);
  const british = findBritishSpellings(text);
  if (british.length) p.warnings.push(`${where}: British spelling (${british.join(", ")}); John writes American`);
}

export function slidesProblems(where: string, deck: unknown, p: Problems) {
  if (!deck || typeof deck !== "object" || Array.isArray(deck)) return void p.errors.push(`${where}: slides.json must be an object {template, slides}`);
  const d = deck as Partial<SlideDeck>;
  if (!(TEMPLATES as readonly string[]).includes(String(d.template))) p.errors.push(`${where}: template must be one of ${TEMPLATES.join(", ")} (vibrana-carousel)`);
  if (!Array.isArray(d.slides) || d.slides.length < 3) return void p.errors.push(`${where}: slides must be an array of at least 3 slides`);
  if (d.slides.length > 20) p.errors.push(`${where}: ${d.slides.length} slides; a carousel holds at most 20`);
  if (d.slides.length < 6 || d.slides.length > 10) p.warnings.push(`${where}: ${d.slides.length} slides; the guide asks for 6 to 10`);
  if ((d as { sample?: unknown }).sample === true) p.errors.push(`${where}: "sample": true puts a SAMPLE badge on every slide; drop it`);
  d.slides.forEach((s, i) => {
    const at = `${where} slide ${i + 1}`;
    if (!s || typeof s !== "object") return void p.errors.push(`${at}: must be an object`);
    if (!SLIDE_TYPES.has(String(s.type))) p.errors.push(`${at}: unknown type "${String(s.type)}"`);
    if (s.type === "item" && (typeof s.n !== "number" || typeof s.title !== "string" || !s.title.trim())) p.errors.push(`${at}: a list item needs a number n and a title`);
    if (s.type === "step" && (typeof s.name !== "string" || typeof s.title !== "string")) p.errors.push(`${at}: a framework step needs a name and a title`);
    if (s.type !== "image" && !stringsOf(s).some((t) => t.trim() && t !== s.type)) p.errors.push(`${at}: has no text`);
  });
  if (d.slides[0]?.type !== "cover") p.errors.push(`${where}: the first slide must be the cover`);
  if (d.slides.at(-1)?.type !== "cta") p.warnings.push(`${where}: the last slide is usually the cta`);
}

export function videoProblems(where: string, v: unknown, p: Problems) {
  const s = v as Partial<VideoScript> | null;
  if (!s || typeof s !== "object") return void p.errors.push(`${where}: a video candidate needs {hook, beats}`);
  if (typeof s.hook !== "string" || !s.hook.trim()) p.errors.push(`${where}: the video needs its hook line`);
  if (!Array.isArray(s.beats) || s.beats.filter((b) => typeof b === "string" && b.trim()).length < 3) p.errors.push(`${where}: the video needs at least 3 beats`);
  if (s.lines !== undefined && typeof s.lines !== "string") p.errors.push(`${where}: lines must be the video-lines.md text`);
}

/** Checks one candidate. `index` names it in messages when the slug itself is the problem. */
export function candidateProblems(c: Partial<CandidateInput>, index = 0): Problems {
  const p: Problems = { errors: [], warnings: [], john_slots: 0 };
  const name = typeof c.slug === "string" && c.slug ? c.slug : `candidate ${index + 1}`;
  if (typeof c.slug !== "string" || !SLUG.test(c.slug)) p.errors.push(`${name}: slug must be lowercase letters, digits and dashes (at most 64)`);
  if (typeof c.title !== "string" || !c.title.trim() || c.title.length > 300) p.errors.push(`${name}: needs a title (at most 300 characters)`);
  if (!(FORMATS as readonly string[]).includes(String(c.format))) p.errors.push(`${name}: format must be ${FORMATS.join(", ")}`);
  if (!(LENSES as readonly string[]).includes(String(c.lens))) p.errors.push(`${name}: lens must be ${LENSES.join(", ")}`);
  if (!(CANDIDATE_PILLARS as readonly string[]).includes(String(c.pillar))) p.errors.push(`${name}: pillar must be ${CANDIDATE_PILLARS.join(", ")}`);
  if (c.channels !== undefined && (!Array.isArray(c.channels) || !c.channels.length || c.channels.some((ch) => !(CANDIDATE_CHANNELS as readonly string[]).includes(ch)) || new Set(c.channels).size !== c.channels.length)) {
    p.errors.push(`${name}: channels must be some of ${CANDIDATE_CHANNELS.join(", ")}`);
  }
  if (typeof c.body !== "string" || !c.body.trim()) p.errors.push(`${name}: needs the post text (linkedin.md)`);
  if (c.signal_id != null && !UUID.test(String(c.signal_id))) p.errors.push(`${name}: signal_id must be a Signal Desk story id`);
  if (c.report_action_id != null && !UUID.test(String(c.report_action_id))) p.errors.push(`${name}: report_action_id must be a report action id`);
  if (c.score != null && !(typeof c.score === "number" && c.score >= 0 && c.score <= 100)) p.errors.push(`${name}: score is 0 to 100`);
  if (c.format === "carousel") slidesProblems(`${name} slides.json`, c.slides, p);
  else if (c.slides != null) p.errors.push(`${name}: slides belong to a carousel, not a ${c.format}`);
  if (c.format === "video") videoProblems(`${name} video`, c.video, p);
  else if (c.video != null) p.errors.push(`${name}: a video script belongs to a video, not a ${c.format}`);

  if (!Array.isArray(c.sources) || !c.sources.length) p.errors.push(`${name}: needs at least one source (the links the draft's facts come from)`);
  else c.sources.forEach((s, i) => { if (!s || typeof s.url !== "string" || !/^https?:\/\/\S+$/.test(s.url)) p.errors.push(`${name}: source ${i + 1} needs an http(s) url`); });

  // The voice guard, on everything a reader sees.
  const texts: [string, string][] = [["title", c.title ?? ""], ["linkedin.md", c.body ?? ""]];
  if (c.instagram) texts.push(["instagram.md", c.instagram]);
  for (const s of stringsOf(c.slides ?? null)) texts.push(["slides.json", s]);
  if (c.video) for (const s of stringsOf(c.video)) texts.push(["video-lines.md", s]);
  for (const [where, text] of texts) voiceProblems(`${name} ${where}`, text, p);
  const prose = splitFrontmatter(c.body ?? "").prose;
  const links = findUrls(prose);
  if (links.length) p.errors.push(`${name} linkedin.md: a link in the post text (${links[0]}); it goes in first_comment frontmatter`);
  if (c.instagram && findUrls(splitFrontmatter(c.instagram).prose).length) p.errors.push(`${name} instagram.md: Instagram captions never carry a link`);
  const tags = (prose.match(/(^|\s)#[A-Za-z]\w*/g) ?? []).length;
  if (tags > 2) p.warnings.push(`${name} linkedin.md: ${tags} hashtags; LinkedIn takes 2 at most`);
  p.john_slots = texts.reduce((n, [, t]) => n + findAgentNotes(t).filter((x) => /^\[JOHN\b/i.test(x)).length, 0);
  if (!c.rubric || typeof c.rubric !== "object") p.warnings.push(`${name}: no rubric report; the writers room grades every draft`);
  if (c.pillar === "proof" && c.rubric && !c.rubric.persona_review) p.warnings.push(`${name}: a Proof piece needs persona-review (record it as rubric.persona_review)`);
  if (c.rubric && typeof c.rubric === "object" && c.rubric.overall === "fail") p.warnings.push(`${name}: the rubric judge failed it (${(c.rubric.fails ?? []).join(", ") || "see rubric"}); it goes to John with the report on top`);
  return p;
}

/** All candidates of one put: each checked, plus duplicate slugs and the week's 5 to 7 and format mix. */
export function putProblems(list: Partial<CandidateInput>[], opts: { min?: number; max?: number } = {}): Problems & { per: Problems[] } {
  const per = list.map((c, i) => candidateProblems(c, i));
  const out: Problems & { per: Problems[] } = { errors: per.flatMap((p) => p.errors), warnings: per.flatMap((p) => p.warnings), john_slots: per.reduce((n, p) => n + p.john_slots, 0), per };
  const slugs = list.map((c) => c.slug);
  const dup = slugs.filter((s, i) => s && slugs.indexOf(s) !== i);
  if (dup.length) out.errors.push(`duplicate slug: ${[...new Set(dup)].join(", ")}`);
  if (!list.length) out.warnings.push("no candidates to put: nothing is written and no email is sent");
  const { min = 5, max = 7 } = opts;
  if (list.length && (list.length < min || list.length > max)) out.warnings.push(`${list.length} candidates; the week wants ${min} to ${max}`);
  if (list.length && !list.some((c) => c.format === "carousel")) out.warnings.push("no carousel this week; the guide asks for at least one");
  if (list.length && !list.some((c) => c.format === "video")) out.warnings.push("no video script this week; the plan asks for at least one");
  return out;
}

/** Fields John may change inline before sending a candidate to review. */
export const EDITABLE = ["title", "body", "instagram", "slides", "video"] as const;
export type Editable = (typeof EDITABLE)[number];
