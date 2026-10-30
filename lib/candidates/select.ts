// Sunday candidates (VIB-420): which 5 to 7 stories the writers room drafts for the coming week.
// Deterministic: the same signals, report actions and config always give the same set, in the same order.
//
//   1. Every queued signal (John asked for it) and every new_story action from the latest weekly report
//      that John has not dismissed. They are in the set before anything else, up to `total.max`.
//   2. The top briefed stories of the last `window_days` fill the set to `total.target`, one at a time,
//      always into the lens that has the fewest so far (Transformation / Thought leadership / Regenerative),
//      so the week stays balanced the way STRATEGY.md's three-lens split asks.
//   3. Each pick gets a pillar its lens can honestly lead with (the least used one first), and formats are
//      assigned last: a queued video stays a video, then at least one carousel and one video script, the rest
//      text posts.
// A signal that already became a candidate in another week is never picked again.
import type { SupabaseClient } from "@supabase/supabase-js";
import candidatesJson from "../../config/candidates.json";
import { must } from "../db";
import { localDate } from "../reports/week";
import type { Brief } from "../signals/config";
import { storyItems } from "../signals/pipeline";
import { addDays, mondayOf } from "../week";

export const FORMATS = ["text", "carousel", "video"] as const;
export type CandidateFormat = (typeof FORMATS)[number];
export const LENSES = ["transformation", "thought_leadership", "regenerative"] as const;
export type Lens = (typeof LENSES)[number];
export const CANDIDATE_PILLARS = ["proof", "perspective", "build", "lists"] as const;
export type CandidatePillar = (typeof CANDIDATE_PILLARS)[number];
export const CANDIDATE_CHANNELS = ["linkedin", "instagram", "youtube"] as const;

export type CandidatesConfig = {
  total: { min: number; target: number; max: number };
  window_days: number;
  /** Briefed stories below either floor are never drafted; the week is shortened instead. */
  min_audience_fit: number;
  min_score: number;
  /** At most this many picks per pillar, unless the pool leaves no other pillar to give (then a warning). */
  pillar_cap: Partial<Record<CandidatePillar, number>>;
  lenses: { slug: Lens; name: string; lanes: string[]; pillars: CandidatePillar[] }[];
  pillar_lens: Record<CandidatePillar, Lens>;
  formats: Record<CandidateFormat, { min: number; channels: string[]; prefer_pillars?: string[]; prefer_lenses?: string[] }>;
};
export const candidatesConfig = () => candidatesJson as CandidatesConfig;

export type Source = { title: string; url: string; source: string };
export type SignalRow = {
  id: string; title: string; lanes: string[]; score: number; status: string; requested_format: string | null;
  brief: Brief | null; last_seen: string; acted_at: string | null;
};
export type ReportActionRow = {
  id: string; report_id: string; position: number; status: string; proposal: string; rationale: string;
  change: { title?: string; pillar?: string; format?: string; channels?: string[]; date?: string; signal_id?: string | null };
};
export type SelectInput = {
  week_start: string;
  queued: SignalRow[];
  briefed: SignalRow[];
  actions: ReportActionRow[];
  /** Signal and report-action ids already used by candidates in other weeks. */
  taken: { signals: string[]; actions: string[] };
  sources: Record<string, Source[]>;
  report?: { id: string; week: number | null; period_start: string } | null;
  notes?: string[];
  /** Audience fit scored at selection time for briefs written before the brief carried it (lib/candidates/fit.ts). */
  fits?: Record<string, Fit>;
};
export type Fit = { audience_fit: number; audience_reason: string };

export type Origin = "queued" | "report" | "briefed";
export type Pick = {
  slug: string; position: number; origin: Origin;
  signal_id: string | null; report_action_id: string | null;
  title: string; lens: Lens; pillar: CandidatePillar; format: CandidateFormat; channels: string[];
  score: number | null; requested_format: string | null;
  brief: Brief | null; sources: Source[]; why: string;
  /** Would the STRATEGY reader act on it (0..1), and why. Null for a report story with no signal. */
  audience_fit: number | null; audience_reason: string | null;
  /** Selected date for a report action, if it proposed one. */
  date: string | null;
};
export type Selection = {
  week_start: string;
  candidates: Pick[];
  pool: { queued: number; report: number; briefed: number; excluded: number; gated: number };
  /** Briefed stories the audience-fit or score floor kept out, best first: what John would have seen without the gate. */
  gated: { signal_id: string; title: string; score: number; audience_fit: number | null; audience_reason: string | null; why: string }[];
  balance: { lens: Record<Lens, number>; pillar: Record<string, number>; format: Record<CandidateFormat, number> };
  warnings: string[];
};

type Entry = Omit<Pick, "slug" | "position" | "pillar" | "format" | "channels"> & {
  tier: number; order: number; pillar: CandidatePillar | null; format: CandidateFormat | null; channels: string[] | null;
};

/** A readable slug of at most 48 characters, cut at a word boundary. */
export function slugify(s: string): string {
  const full = s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f'\u2019]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (full.length <= 48) return full || "candidate";
  const cut = full.slice(0, 49);
  const at = cut.lastIndexOf("-");
  return (at > 20 ? cut.slice(0, at) : full.slice(0, 48)).replace(/-$/, "");
}

/** The lens a signal's lanes point to: the lens holding most of its lanes; a tie goes to the lens of its first lane. */
export function lensOfLanes(lanes: string[], cfg = candidatesConfig()): Lens | null {
  const count = new Map<Lens, number>();
  for (const lane of lanes) {
    const lens = cfg.lenses.find((l) => l.lanes.includes(lane))?.slug;
    if (lens) count.set(lens, (count.get(lens) ?? 0) + 1);
  }
  if (!count.size) return null;
  const best = Math.max(...count.values());
  const first = lanes.map((lane) => cfg.lenses.find((l) => l.lanes.includes(lane))?.slug).find((l) => l && count.get(l) === best);
  return first ?? null;
}

const asPillar = (p: string | undefined): CandidatePillar | null => (CANDIDATE_PILLARS as readonly string[]).includes(p ?? "") ? p as CandidatePillar : null;

/** A report action's or a queued signal's own format, when it names one. */
function fixedFormat(requested: string | null | undefined): CandidateFormat | null {
  if (requested === "video") return "video";
  if (requested === "carousel" || requested === "document") return "carousel";
  if (requested === "text" || requested === "image") return "text";
  return null; // "story" and "repost" leave the format to the balance
}

/** The deterministic selection. Pure: no clock, no database. */
export function selectCandidates(input: SelectInput, cfg = candidatesConfig()): Selection {
  const warnings: string[] = [...(input.notes ?? [])];
  const takenSignals = new Set(input.taken.signals);
  const takenActions = new Set(input.taken.actions);
  const bySignal = new Map<string, Entry>();
  const entries: Entry[] = [];
  let excluded = 0;
  const lensOf = (s: SignalRow) => lensOfLanes(s.lanes, cfg) ?? cfg.lenses[0].slug;
  const fitOf = (s: SignalRow): Fit | null => typeof s.brief?.audience_fit === "number" ? { audience_fit: s.brief.audience_fit, audience_reason: s.brief.audience_reason ?? "" } : input.fits?.[s.id] ?? null;
  const signalEntry = (s: SignalRow, origin: Origin, tier: number, order: number): Entry => ({
    origin, tier, order, signal_id: s.id, report_action_id: null, title: s.brief?.headline ?? s.title, lens: lensOf(s),
    pillar: null, format: origin === "queued" ? fixedFormat(s.requested_format) : null, channels: null,
    score: s.score, requested_format: s.requested_format, brief: s.brief, date: null,
    audience_fit: fitOf(s)?.audience_fit ?? null, audience_reason: fitOf(s)?.audience_reason ?? null,
    sources: dedupeSources([...(s.brief?.sources ?? []), ...(input.sources[s.id] ?? [])]),
    why: origin === "queued" ? `Queued on the Signal Desk${s.requested_format ? ` as a ${s.requested_format}` : ""}` : `Top briefed story of the last ${cfg.window_days} days (score ${Math.round(s.score)})`,
  });

  const queued = [...input.queued].sort((a, b) => (a.acted_at ?? "").localeCompare(b.acted_at ?? "") || b.score - a.score || a.id.localeCompare(b.id));
  for (const [i, s] of queued.entries()) {
    if (takenSignals.has(s.id)) { excluded++; continue; }
    const e = signalEntry(s, "queued", 0, i);
    bySignal.set(s.id, e);
    entries.push(e);
  }
  const actions = [...input.actions].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  for (const [i, a] of actions.entries()) {
    if (takenActions.has(a.id) || a.status === "dismissed") { excluded++; continue; }
    const sig = a.change.signal_id ? bySignal.get(a.change.signal_id) : undefined;
    if (sig) { // the report backs a signal John already queued: one candidate, both links
      sig.report_action_id = a.id;
      sig.why += `; the weekly report proposes it too`;
      sig.pillar ??= asPillar(a.change.pillar);
      continue;
    }
    if (a.change.signal_id && takenSignals.has(a.change.signal_id)) { excluded++; continue; }
    const fromSignal = a.change.signal_id ? [...input.queued, ...input.briefed].find((s) => s.id === a.change.signal_id) : undefined;
    const pillar = asPillar(a.change.pillar);
    const e: Entry = {
      origin: "report", tier: 1, order: i, signal_id: a.change.signal_id ?? null, report_action_id: a.id,
      title: a.change.title ?? fromSignal?.brief?.headline ?? a.proposal.slice(0, 120),
      lens: fromSignal ? lensOf(fromSignal) : pillar ? cfg.pillar_lens[pillar] : cfg.lenses[0].slug,
      pillar, format: fixedFormat(a.change.format), channels: a.change.channels?.filter((c) => (CANDIDATE_CHANNELS as readonly string[]).includes(c)) ?? null,
      score: fromSignal?.score ?? null, requested_format: fromSignal?.requested_format ?? null, brief: fromSignal?.brief ?? null,
      sources: fromSignal ? dedupeSources([...(fromSignal.brief?.sources ?? []), ...(input.sources[fromSignal.id] ?? [])]) : [],
      why: `The weekly report proposes it: ${a.proposal}`, date: a.change.date ?? null,
      audience_fit: fromSignal ? fitOf(fromSignal)?.audience_fit ?? null : null, audience_reason: fromSignal ? fitOf(fromSignal)?.audience_reason ?? null : null,
    };
    if (e.signal_id) bySignal.set(e.signal_id, e);
    entries.push(e);
  }
  // Tier 2 is gated: only stories the reader would act on (audience fit) and that still rank (score floor).
  // Queued signals and report stories were chosen by John or the report, so they bypass the gate.
  // Ranked by score times fit, so a fresh off-audience story cannot outrank an older one the reader needs.
  const gated: Selection["gated"] = [];
  const rankOf = (s: SignalRow) => s.score * (fitOf(s)?.audience_fit ?? 0);
  const briefed = [...input.briefed].filter((s) => s.brief).sort((a, b) => rankOf(b) - rankOf(a) || b.score - a.score || a.id.localeCompare(b.id));
  for (const [i, s] of briefed.entries()) {
    if (bySignal.has(s.id)) continue;
    if (takenSignals.has(s.id) || s.status === "dismissed" || s.status === "drafted") { excluded++; continue; }
    const fit = fitOf(s);
    const why = !fit ? "no audience fit scored" : fit.audience_fit < cfg.min_audience_fit ? `audience fit ${fit.audience_fit} under ${cfg.min_audience_fit}` : s.score < cfg.min_score ? `score ${Math.round(s.score)} under ${cfg.min_score}` : null;
    if (why) { gated.push({ signal_id: s.id, title: s.brief?.headline ?? s.title, score: s.score, audience_fit: fit?.audience_fit ?? null, audience_reason: fit?.audience_reason ?? null, why }); continue; }
    const e = signalEntry(s, "briefed", 2, i);
    bySignal.set(s.id, e);
    entries.push(e);
  }

  // 1. what John asked for, 2. lens-balanced fill from the briefed stories.
  const forced = entries.filter((e) => e.tier < 2);
  if (forced.length > cfg.total.max) warnings.push(`${forced.length} queued signals and report stories, more than the ${cfg.total.max} a week can take: the oldest ${cfg.total.max} are drafted, the rest wait for next Sunday`);
  const picked: Entry[] = forced.slice(0, cfg.total.max);
  const rest = entries.filter((e) => e.tier === 2);
  const lensOrder = cfg.lenses.map((l) => l.slug);
  while (picked.length < Math.max(cfg.total.target, cfg.total.min) && picked.length < cfg.total.max && rest.length) {
    const count = (l: Lens) => picked.filter((p) => p.lens === l).length;
    const lenses = [...lensOrder].sort((a, b) => count(a) - count(b) || lensOrder.indexOf(a) - lensOrder.indexOf(b));
    const lens = lenses.find((l) => rest.some((e) => e.lens === l));
    if (!lens) break;
    const i = rest.findIndex((e) => e.lens === lens);
    picked.push(rest.splice(i, 1)[0]);
  }
  if (picked.length < cfg.total.min) warnings.push(`only ${picked.length} stories to draft (the week wants ${cfg.total.min} to ${cfg.total.max}; ${gated.length} briefed stories were under the audience-fit or score floor): queue more on the Signal Desk rather than draft off-audience news`);
  for (const lens of lensOrder) if (picked.length && !picked.some((p) => p.lens === lens)) warnings.push(`no ${cfg.lenses.find((l) => l.slug === lens)!.name} story in the pool this week`);

  // 3. pillars: within the cap, a lens's least-used pillar first (ties go to the lens's own order).
  const pillarCount = (p: string) => picked.filter((e) => e.pillar === p).length;
  const full = (p: CandidatePillar) => pillarCount(p) >= (cfg.pillar_cap[p] ?? Infinity);
  for (const e of picked) {
    if (e.pillar) continue;
    const options = cfg.lenses.find((l) => l.slug === e.lens)!.pillars;
    e.pillar = [...options].sort((a, b) => Number(full(a)) - Number(full(b)) || pillarCount(a) - pillarCount(b) || options.indexOf(a) - options.indexOf(b))[0];
  }
  for (const [p, cap] of Object.entries(cfg.pillar_cap)) if (pillarCount(p) > cap!) warnings.push(`${pillarCount(p)} ${p} picks, over the cap of ${cap}: the queued and report stories leave no other pillar`);
  // Formats: fixed ones stay; then the carousel and video minimums; the rest are text posts.
  const formatCount = (f: CandidateFormat) => picked.filter((e) => e.format === f).length;
  const fixed = new Set(picked.filter((e) => e.format).map((e) => e));
  const rank = (prefs: string[] | undefined, value: string) => { const i = (prefs ?? []).indexOf(value); return i < 0 ? 99 : i; };
  for (const f of ["carousel", "video"] as const) {
    const rule = cfg.formats[f];
    while (formatCount(f) < rule.min) {
      const free = picked.filter((e) => !e.format && !fixed.has(e));
      if (!free.length) { warnings.push(`no free story left to make the week's ${f}: every pick has a format John or the report chose`); break; }
      free.sort((a, b) => rank(rule.prefer_pillars, a.pillar!) - rank(rule.prefer_pillars, b.pillar!) || rank(rule.prefer_lenses, a.lens) - rank(rule.prefer_lenses, b.lens) || picked.indexOf(a) - picked.indexOf(b));
      free[0].format = f;
    }
  }
  for (const e of picked) e.format ??= "text";

  const slugs = new Set<string>();
  const candidates: Pick[] = picked.map((e, position) => {
    let slug = slugify(e.title);
    for (let n = 2; slugs.has(slug); n++) slug = `${slugify(e.title).slice(0, 44)}-${n}`;
    slugs.add(slug);
    const { tier: _t, order: _o, ...rest } = e;
    return { ...rest, slug, position, pillar: e.pillar!, format: e.format!, channels: e.channels?.length ? e.channels : [...cfg.formats[e.format!].channels] };
  });
  const tally = <K extends string>(keys: readonly K[], f: (p: Pick) => string) => Object.fromEntries(keys.map((k) => [k, candidates.filter((c) => f(c) === k).length])) as Record<K, number>;
  return {
    week_start: input.week_start, candidates,
    pool: { queued: input.queued.length, report: input.actions.length, briefed: input.briefed.length, excluded, gated: gated.length }, gated,
    balance: { lens: tally(LENSES, (c) => c.lens), pillar: tally(CANDIDATE_PILLARS, (c) => c.pillar), format: tally(FORMATS, (c) => c.format) },
    warnings,
  };
}

function dedupeSources(list: Source[]): Source[] {
  const seen = new Set<string>();
  return list.filter((s) => s?.url && !seen.has(s.url) && (seen.add(s.url), true)).slice(0, 8);
}

/** The Monday the candidates are for: the week after today in Bali (the routine runs Sunday afternoon). */
export function defaultWeekStart(now = new Date()): string {
  return addDays(mondayOf(localDate(now)), 7);
}

/** `--week`: a date (its Monday) or season week N of the current season. */
export async function resolveCandidateWeek(db: SupabaseClient, arg: string | undefined, now = new Date()): Promise<string> {
  if (!arg) return defaultWeekStart(now);
  if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) return mondayOf(arg);
  if (!/^\d{1,2}$/.test(arg)) throw new Error("--week takes a season week number or a date (YYYY-MM-DD)");
  const { resolveSeason } = await import("../seasons");
  const { seasonWeekStart } = await import("../week");
  const season = await resolveSeason(db, undefined, localDate(now));
  return seasonWeekStart(season.starts_on, Number(arg));
}

const SIGNAL_COLUMNS = "id,title,lanes,score,status,requested_format,brief,last_seen,acted_at";

/** Reads everything the selection needs. Read-only. */
export async function loadSelectInput(db: SupabaseClient, weekStart: string, now = new Date(), cfg = candidatesConfig()): Promise<SelectInput> {
  const since = new Date(now.getTime() - cfg.window_days * 86_400_000).toISOString();
  const [queued, briefed, report, used] = await Promise.all([
    db.from("gtm_signal_stories").select(SIGNAL_COLUMNS).eq("status", "queued").order("acted_at").limit(50),
    db.from("gtm_signal_stories").select(SIGNAL_COLUMNS).in("status", ["new", "saved"]).not("brief", "is", null).gte("last_seen", since).order("score", { ascending: false }).limit(60),
    db.from("gtm_content_reports").select("id,week,period_start").eq("kind", "weekly").eq("status", "done").order("period_start", { ascending: false }).limit(1).maybeSingle(),
    db.from("gtm_content_candidates").select("signal_id,report_action_id,week_start").neq("week_start", weekStart),
  ]);
  const rep = must(report, "latest report") as SelectInput["report"];
  const actions = rep
    ? must(await db.from("gtm_report_actions").select("id,report_id,position,status,proposal,rationale,change").eq("report_id", rep.id).eq("type", "new_story").neq("status", "dismissed").order("position"), "report actions") as ReportActionRow[]
    : [];
  // Before the gtm_content_candidates migration reaches a database, nothing has been used yet: say so and go on.
  const missing = used.error && /could not find the table|does not exist/i.test(used.error.message);
  const usedRows = missing ? [] : must(used, "used candidates") as { signal_id: string | null; report_action_id: string | null }[];
  const q = must(queued, "queued signals") as SignalRow[];
  const b = must(briefed, "briefed signals") as SignalRow[];
  // Signals a report action names but that are neither queued nor in the briefed window.
  const named = actions.map((a) => a.change.signal_id).filter((id): id is string => !!id && ![...q, ...b].some((s) => s.id === id));
  const extra = named.length ? must(await db.from("gtm_signal_stories").select(SIGNAL_COLUMNS).in("id", named), "report signals") as SignalRow[] : [];
  const all = [...q, ...b, ...extra];
  const items = await storyItems(db, all.map((s) => s.id));
  const sources: Record<string, Source[]> = {};
  for (const i of items) (sources[i.story_id as string] ??= []).length < 6 && sources[i.story_id as string].push({ title: i.title.slice(0, 200), url: i.url, source: i.source });
  return {
    week_start: weekStart, queued: q, briefed: [...b, ...extra], actions,
    taken: { signals: usedRows.map((r) => r.signal_id).filter((x): x is string => !!x), actions: usedRows.map((r) => r.report_action_id).filter((x): x is string => !!x) },
    sources, report: rep, notes: missing ? ["gtm_content_candidates does not exist in this database yet (brand.example.com migration 20261011160000): no signal counts as used"] : [],
  };
}
