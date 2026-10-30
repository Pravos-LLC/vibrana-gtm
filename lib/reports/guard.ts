// The weekly report's guard (VIB-418), the report's version of checkBrief: the model may only say what the
// input pack supports. Mechanically:
// - every number in the text must be a number in the pack (a fact, a date part, a number in a title);
// - every post ref, calendar item id, signal id and pillar must exist in the pack;
// - every piece of evidence must name a real fact with its real value;
// - an entry that breaks a rule is dropped whole (and listed in `dropped`), never repaired into a new claim;
// - em and en dashes become commas or hyphens, and banned words (content/guide/voice.json) are struck out.
// Proposed actions must be applicable: real upcoming or reserve items, a real date in range, a known
// format, channel and pillar. They never approve, schedule or publish anything.
import { findBritishSpellings } from "../copy-guard";
import { VOICE } from "../guide/content";
import { addDays } from "../week";
import { CTAS, HOOKS, STORYLINES } from "../playbook/taxonomy";
import { SLOT_CHANNELS, SLOT_FORMATS, type Pack } from "./pack";

export type Evidence = { fact: string; value: number };
export type ActionType = "move" | "swap" | "replace" | "new_story" | "change_format";
export type ReportAction = {
  type: ActionType; item_id: string | null; other_item_id: string | null; new_date: string | null; new_format: string | null;
  new_title: string | null; new_pillar: string | null; new_channels: string[]; signal_id: string | null;
  proposal: string; rationale: string; evidence: Evidence[];
};
export type Verdict = "on_track" | "behind" | "too_early";
export type Report = {
  headline: string; lede: string;
  went_out: { ref: string; note: string }[];
  did_well: { ref: string; why: string; evidence: Evidence[] }[];
  underperformed: { ref: string; why: string; evidence: Evidence[] }[];
  patterns: { observation: string; evidence: Evidence[] }[];
  against_playbook: { observation: string; evidence: Evidence[] }[];
  pillars: { pillar: string; verdict: Verdict; note: string; evidence: Evidence[] }[];
  actions: ReportAction[];
};
export type Dropped = { section: string; index: number; reason: string; text: string };
export type GuardResult = { report: Report; dropped: Dropped[]; cleaned: { section: string; removed: string }[]; warnings: string[] };

const MONTHS = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const NUM = /(?<![\p{L}\p{N}_.])[-+]?\d[\d,]*(?:\.\d+)?/gu;
const canon = (x: number) => String(Math.round(Math.abs(x) * 100) / 100);
const parse = (s: string) => Number(s.replace(/[,+-]/g, ""));

/** Numbers the model may write: each fact (as is, to 1 dp, to a whole number), and numbers inside the pack's own text. */
export function allowedNumbers(pack: Pack): Set<string> {
  const ok = new Set<string>();
  const add = (v: number) => { ok.add(canon(v)); ok.add(canon(Math.round(v * 10) / 10)); ok.add(canon(Math.round(v))); };
  for (const v of Object.values(pack.facts)) add(v);
  // Titles, previews and ids can carry numbers ("Example campaign title 7"); restating them is not inventing.
  const walk = (x: unknown) => {
    if (typeof x === "string") {
      for (const m of x.matchAll(NUM)) add(parse(m[0]));
      for (const m of x.matchAll(SPELLED)) add(WORDS[m[0].toLowerCase()]); // "Seven agentic patterns"
    }
    else if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === "object") Object.values(x).forEach(walk);
  };
  walk({ posts: pack.posts.map((p) => [p.title, p.preview]), upcoming: pack.upcoming.map((u) => u.title), reserve: pack.reserve.map((r) => r.title), signals: pack.signals.map((s) => s.title), unmeasured: pack.unmeasured.map((u) => u.title), pushback: (pack.pushback ?? []).map((r) => [r.title, r.objection]) });
  return ok;
}

/** The ids, refs and dates a text may name; stripped before numbers are checked. */
function knownTokens(pack: Pack): string[] {
  const ids = [...pack.posts.flatMap((p) => [p.ref, p.item_id ?? ""]), ...pack.upcoming.map((u) => u.id), ...pack.reserve.map((r) => r.id), ...pack.unmeasured.map((u) => u.item_id), ...pack.signals.map((s) => s.id), ...Object.keys(pack.facts)];
  return [...new Set(ids.filter(Boolean))].sort((a, b) => b.length - a.length);
}

/** Every number in `text` that the pack does not support (after removing ids, fact keys, dates and times). */
export function unsupportedNumbers(text: string, pack: Pack, allowed = allowedNumbers(pack), tokens = knownTokens(pack)): string[] {
  let t = ` ${text} `;
  for (const id of tokens) t = t.split(id).join(" ");
  const lo = addDays(pack.week.from, -7 * (pack.rules.cohort_weeks + 1));
  const hi = addDays(pack.week.to, 60);
  t = t.replace(/\b(\d{4}-\d{2}-\d{2})\b/g, (m, d: string) => (d >= lo && d <= hi ? " " : m));
  t = t.replace(new RegExp(`\\b(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?\\b`, "gi"), " ");
  t = t.replace(new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:${MONTHS})\\b`, "gi"), " ");
  t = t.replace(/\b(?:[01]?\d|2[0-3]):[0-5]\d\b/g, " ");
  // "W2", "week 2", "Week 3": season weeks of the pack and the two weeks after it.
  const weeks = new Set([pack.week.number, pack.week.previous.number, pack.week.number + 1, pack.week.number + 2].map(String));
  t = t.replace(/\b(?:w|week\s+)(\d{1,2})\b/gi, (m, n: string) => (weeks.has(n) ? " " : m));
  const bad: string[] = [];
  // Scaled numbers ("1.2K", "12k", "3M", "1.2 thousand"): the expanded value must be in the pack, never just the prefix.
  t = t.replace(SCALED, (m, num: string, unit: string) => { if (!allowed.has(canon(parse(num) * SCALE[unit.toLowerCase()]))) bad.push(m.trim()); return " "; });
  // Multipliers ("3x", "10-fold") only when the pack's own text says the same thing.
  const mult = multipliersOf(pack);
  t = t.replace(MULTIPLIER, (m) => { if (!mult.has(m.toLowerCase().replace(/\s|-/g, ""))) bad.push(m.trim()); return " "; });
  // Relative quantities ("half", "doubled", "tripled", "twice") are computed claims the pack never states.
  t = t.replace(RELATIVE, (m) => { bad.push(m); return " "; });
  // Spelled-out cardinals ("twelve comments") are checked like digits.
  t = t.replace(SPELLED, (m) => { if (!allowed.has(canon(WORDS[m.toLowerCase()]))) bad.push(m); return " "; });
  return [...bad, ...[...t.matchAll(NUM)].map((m) => m[0]).filter((s) => !allowed.has(canon(parse(s))))];
}

const SCALE: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, mn: 1e6, million: 1e6, bn: 1e9, b: 1e9, billion: 1e9 };
const SCALED = /(?<![\p{L}\p{N}_.])(\d[\d,]*(?:\.\d+)?)\s*(k|mn|m|bn|b|thousand|million|billion)\b/giu;
const MULTIPLIER = /(?<![\p{L}\p{N}_.])\d+(?:\.\d+)?\s*(?:x|-?fold)\b/giu;
const RELATIVE = /\b(?:half|halved|halving|halves|doubled|doubles|doubling|double|twice|thrice|tripled|triples|tripling|triple|quadrupled|quadruple|(?:two|three|four|five|six|seven|eight|nine|ten|hundred)fold)\b/gi;
const WORDS: Record<string, number> = Object.fromEntries([
  ...["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"].map((w, i) => [w, i]),
  ["thirty", 30], ["forty", 40], ["fifty", 50], ["sixty", 60], ["seventy", 70], ["eighty", 80], ["ninety", 90], ["hundred", 100], ["dozen", 12],
]);
const SPELLED = new RegExp(`\\b(?:${Object.keys(WORDS).join("|")})\\b`, "gi");
const multCache = new WeakMap<Pack, Set<string>>();
/** "3x" style tokens already in the pack's own text (titles, previews, signals). */
function multipliersOf(pack: Pack): Set<string> {
  let set = multCache.get(pack);
  if (!set) {
    const text = [...pack.posts.flatMap((p) => [p.title ?? "", p.preview]), ...pack.upcoming.map((u) => u.title), ...pack.reserve.map((r) => r.title), ...pack.signals.map((x) => x.title)].join(" ");
    set = new Set([...text.matchAll(MULTIPLIER)].map((m) => m[0].toLowerCase().replace(/\s|-/g, "")));
    multCache.set(pack, set);
  }
  return set;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Banned words and phrases from voice.json, without their "(as filler)" style qualifiers. */
export const BANNED = [...VOICE.banned_phrases, ...VOICE.banned_words].map((w) => w.replace(/\s*\([^)]*\)\s*/g, "").trim()).filter(Boolean);

/** No em dashes (a dash between number-bearing tokens is a range and becomes a hyphen) and no banned words. */
export function cleanText(s: string, onRemove?: (w: string) => void): string {
  let out = s.replace(/(\w*\d\w*)[—–](\w*\d\w*)/g, "$1-$2").replace(/\s*[—–]\s*/g, ", ");
  for (const w of BANNED) {
    const re = new RegExp(`\\b${escape(w)}\\b`, "gi");
    if (re.test(out)) { onRemove?.(w); out = out.replace(re, ""); }
  }
  out = out.replace(/\s+([,.;:!?])/g, "$1").replace(/,\s*,/g, ",").replace(/\s{2,}/g, " ").trim().replace(/^[,;:]\s*/, "");
  // A struck word at the start of a sentence leaves it lower-case; restore the capital.
  return /^[A-Z]/.test(s.trim()) ? out.charAt(0).toUpperCase() + out.slice(1) : out;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const PLAYBOOK_FACT = /^(?:playbook\.|median\.(?:hook|storyline|cta)\.)/;
const PLATFORM_NAME: Record<string, string> = { linkedin: "LinkedIn", instagram: "Instagram", youtube: "YouTube" };

/** Checks one model answer against its pack. Pure: the same pack and answer always give the same result. */
export function checkReport(raw: Report, pack: Pack): GuardResult {
  const dropped: Dropped[] = [];
  const cleaned: GuardResult["cleaned"] = [];
  const warnings: string[] = [];
  const allowed = allowedNumbers(pack);
  const tokens = knownTokens(pack);
  const refs = new Map(pack.posts.map((p) => [p.ref, p]));
  const pillars = new Set(pack.pillars.map((p) => p.slug));
  const upcoming = new Set(pack.upcoming.map((u) => u.id));
  const reserve = new Set(pack.reserve.map((r) => r.id));
  const signals = new Set(pack.signals.map((s) => s.id));

  // Prose names a post by what it is; a leftover ref ("P6") becomes its title and platform.
  // Calendar ids in prose become their titles too ("regenera-ig-story" reads as "Regenera essay: Instagram Story").
  const titles = new Map<string, string>([...pack.upcoming, ...pack.reserve].map((i) => [i.id, i.title]));
  for (const u of pack.unmeasured) titles.set(u.item_id, u.title);
  for (const p of pack.posts) if (p.item_id && p.title) titles.set(p.item_id, p.title);
  const ids = [...titles.keys()].sort((a, b) => b.length - a.length);
  const named = (s: string) => {
    let out = s.replace(/\bP(\d+)\b/g, (m) => { const p = refs.get(m); return p ? `"${p.title ?? p.preview.slice(0, 40)}" (${PLATFORM_NAME[p.platform] ?? p.platform})` : m; });
    for (const id of ids) if (out.includes(id)) out = out.split(id).join(`"${titles.get(id)}"`);
    // Taxonomy ids in prose ("hook:news-peg", "cta:soft-link") read as their names.
    out = out.replace(/\b(hook|story|storyline|cta):([a-z0-9-]+)/g, (m, kind: string, id: string) => {
      const e = (kind === "hook" ? HOOKS : kind === "cta" ? CTAS : STORYLINES).get(id);
      return e ? `"${e.name}"` : m;
    });
    return out;
  };
  const clean = (section: string, s: string) => named(cleanText(String(s ?? ""), (w) => cleaned.push({ section, removed: w })));
  const badNumbers = (...texts: string[]) => texts.flatMap((t) => unsupportedNumbers(t, pack, allowed, tokens));
  /** Evidence that names a real fact with its real value (rounding to the value's own precision is fine). */
  const goodEvidence = (ev: Evidence[] | undefined) => (ev ?? []).filter((e) => {
    const v = pack.facts[e?.fact];
    if (typeof v !== "number" || typeof e.value !== "number") return false;
    const dp = (String(e.value).split(".")[1] ?? "").length;
    return Math.abs(Math.round(v * 10 ** dp) / 10 ** dp - e.value) < 1e-9;
  });
  const drop = (section: string, index: number, reason: string, text: string): never[] => { dropped.push({ section, index, reason, text: String(text ?? "").slice(0, 300) }); return []; };

  // Headline and lede: a sentence that cites an unsupported number falls back to a plain statement of fact.
  let headline = clean("headline", raw.headline);
  if (!headline || badNumbers(headline).length) {
    if (headline) drop("headline", 0, `unsupported numbers: ${badNumbers(headline).join(", ")}`, headline);
    headline = `Week ${pack.week.number}: ${pack.mix.pieces} ${pack.mix.pieces === 1 ? "piece" : "pieces"} went out across ${pack.posts.filter((p) => p.window === "this_week").length} platform posts.`;
  }
  let lede = clean("lede", raw.lede);
  if (lede && badNumbers(lede).length) { drop("lede", 0, `unsupported numbers: ${badNumbers(lede).join(", ")}`, lede); lede = ""; }

  const went_out = (raw.went_out ?? []).flatMap((e, i) => {
    const note = clean("went_out", e.note);
    if (!refs.has(e.ref)) return drop("went_out", i, `unknown post ref ${e.ref}`, note);
    const bad = badNumbers(note);
    if (bad.length) return drop("went_out", i, `unsupported numbers: ${bad.join(", ")}`, note);
    return [{ ref: e.ref, note }];
  });

  const judged = (section: "did_well" | "underperformed") => (raw[section] ?? []).flatMap((e, i) => {
    const why = clean(section, e.why);
    const post = refs.get(e.ref);
    if (!post) return drop(section, i, `unknown post ref ${e.ref}`, why);
    if (post.stage === "maturing") return drop(section, i, `${e.ref} is still maturing; it is not ranked`, why);
    const bad = badNumbers(why);
    if (bad.length) return drop(section, i, `unsupported numbers: ${bad.join(", ")}`, why);
    const evidence = goodEvidence(e.evidence);
    if (!evidence.length) return drop(section, i, "no evidence that matches the pack", why);
    return [{ ref: e.ref, why, evidence }];
  });

  const observations = (section: "patterns" | "against_playbook") => (raw[section] ?? []).flatMap((e, i) => {
    const observation = clean(section, e.observation);
    const bad = badNumbers(observation);
    if (bad.length) return drop(section, i, `unsupported numbers: ${bad.join(", ")}`, observation);
    const evidence = goodEvidence(e.evidence);
    if (!evidence.length) return drop(section, i, "no evidence that matches the pack", observation);
    // A playbook claim rests on the tags: at least one fact from the playbook read (CTA flags, or a hook,
    // storyline or CTA median). A claim backed only by a pillar or channel number is not about the playbook.
    if (section === "against_playbook" && !evidence.some((x) => PLAYBOOK_FACT.test(x.fact))) return drop(section, i, "no playbook fact in its evidence (playbook.* or a hook, storyline or CTA median)", observation);
    return [{ observation, evidence }];
  });
  // Without playbook tags there is nothing to grade against; anything here would be invented.
  const hasTags = !!pack.playbook && pack.posts.some((p) => p.playbook_tags != null);
  const againstPlaybook = hasTags ? observations("against_playbook") : [];
  if (!hasTags && raw.against_playbook?.length) raw.against_playbook.forEach((e, i) => drop("against_playbook", i, "no playbook tags in the pack yet", e.observation ?? ""));

  const pillarVerdicts = (raw.pillars ?? []).flatMap((e, i) => {
    const note = clean("pillars", e.note);
    if (!pillars.has(e.pillar as never)) return drop("pillars", i, `unknown pillar ${e.pillar}`, note);
    if (!["on_track", "behind", "too_early"].includes(e.verdict)) return drop("pillars", i, `unknown verdict ${e.verdict}`, note);
    const bad = badNumbers(note);
    if (bad.length) return drop("pillars", i, `unsupported numbers: ${bad.join(", ")}`, note);
    const evidence = goodEvidence(e.evidence);
    if (e.verdict !== "too_early" && !evidence.length) return drop("pillars", i, "a verdict needs evidence from the pack", note);
    return [{ pillar: e.pillar, verdict: e.verdict, note, evidence }];
  });

  const editable = (id: string | null) => !!id && (upcoming.has(id) || reserve.has(id));
  const lo = pack.week.today;
  const hi = addDays(pack.week.to, 63);
  const actions = (raw.actions ?? []).flatMap((a, i) => {
    const proposal = clean("actions", a.proposal);
    const rationale = clean("actions", a.rationale);
    const no = (reason: string): ReportAction[] => drop("actions", i, reason, proposal);
    const bad = badNumbers(proposal, rationale);
    if (bad.length) return no(`unsupported numbers: ${bad.join(", ")}`);
    const evidence = goodEvidence(a.evidence);
    if (!evidence.length) return no("no evidence that matches the pack");
    const date = a.new_date && ISO.test(a.new_date) ? a.new_date : null;
    const dateOk = !!date && date >= lo && date <= hi;
    switch (a.type) {
      case "move":
        if (!upcoming.has(a.item_id ?? "")) return no(`move needs an upcoming item id (got ${a.item_id})`);
        if (!dateOk) return no(`move needs a new date from ${lo} to ${hi} (got ${a.new_date})`);
        break;
      case "swap":
        if (!upcoming.has(a.item_id ?? "") || !editable(a.other_item_id) || a.item_id === a.other_item_id) return no("swap needs two different upcoming or reserve item ids");
        break;
      case "replace":
        if (!upcoming.has(a.item_id ?? "") || !editable(a.other_item_id) || a.item_id === a.other_item_id) return no("replace needs an upcoming item and a reserve or upcoming replacement");
        break;
      case "change_format":
        if (!upcoming.has(a.item_id ?? "")) return no(`change_format needs an upcoming item id (got ${a.item_id})`);
        if (!(SLOT_FORMATS as readonly string[]).includes(a.new_format ?? "")) return no(`unknown format ${a.new_format}`);
        break;
      case "new_story":
        if (!a.new_title?.trim()) return no("new_story needs a working title");
        if (!pillars.has(a.new_pillar as never)) return no(`new_story needs a known pillar (got ${a.new_pillar})`);
        if (!dateOk) return no(`new_story needs a date from ${lo} to ${hi} (got ${a.new_date})`);
        if (!(SLOT_FORMATS as readonly string[]).includes(a.new_format ?? "")) return no(`unknown format ${a.new_format}`);
        if (!a.new_channels?.length || a.new_channels.some((c) => !SLOT_CHANNELS.includes(c))) return no(`new_story channels must be among ${SLOT_CHANNELS.join(", ")}`);
        if (a.signal_id && !signals.has(a.signal_id)) return no(`unknown signal ${a.signal_id}`);
        if (badNumbers(a.new_title).length) return no("the working title cites an unsupported number");
        break;
      default:
        return no(`unknown action type ${a.type}`);
    }
    return [{
      type: a.type, item_id: a.type === "new_story" ? null : a.item_id, other_item_id: a.type === "swap" || a.type === "replace" ? a.other_item_id : null,
      new_date: a.type === "move" || a.type === "new_story" ? date : null, new_format: a.type === "change_format" || a.type === "new_story" ? a.new_format : null,
      new_title: a.type === "new_story" ? clean("actions", a.new_title!) : null, new_pillar: a.type === "new_story" ? a.new_pillar : null,
      new_channels: a.type === "new_story" ? a.new_channels : [], signal_id: a.type === "new_story" ? a.signal_id : null,
      proposal, rationale, evidence,
    }];
  }).slice(0, 6);

  const report: Report = {
    headline, lede, went_out, did_well: judged("did_well"), underperformed: judged("underperformed"),
    patterns: observations("patterns"), against_playbook: againstPlaybook, pillars: pillarVerdicts, actions,
  };
  const british = findBritishSpellings(JSON.stringify(report));
  if (british.length) warnings.push(`British spellings in the report: ${british.join(", ")}`);
  return { report, dropped, cleaned, warnings };
}
