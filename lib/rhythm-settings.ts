// The weekly rhythm as a cockpit setting (John, 2026-11-02, phase 4 of the content-system redesign). The guide's rhythm
// (content/guide/channels.json) is the default; a saved version in gtm_settings, key "rhythm", replaces it everywhere the
// rhythm is read (lib/rhythm.ts RHYTHM), from the next request on. Server only: it reads the database.
import type { SupabaseClient } from "@supabase/supabase-js";
import { RHYTHM, WEEKDAYS, type ChannelBlock, type Lane, type RhythmDay } from "./rhythm";

export const RHYTHM_KEY = "rhythm";
export const RHYTHM_LANES: Lane[] = ["perspective", "proof", "build", "lists", "voices", "reels"];
export const RHYTHM_CHANNELS = ["linkedin", "instagram", "youtube"] as const;
const PILLARS = ["perspective", "proof", "build", "lists"];

export type RhythmSetting = { days: RhythmDay[]; blocked: ChannelBlock[]; rules: string[]; summary: string };

/** The guide's rhythm as it was loaded, so deleting the setting (or a bad row) falls back to it. */
const GUIDE: RhythmSetting = JSON.parse(JSON.stringify({ days: RHYTHM.days, blocked: RHYTHM.blocked ?? [], rules: RHYTHM.rules, summary: RHYTHM.summary }));
export const guideRhythm = (): RhythmSetting => JSON.parse(JSON.stringify(GUIDE));

/** Problems with a rhythm a person typed; empty when it can be saved. */
export function rhythmProblems(v: unknown): string[] {
  const out: string[] = [];
  const r = v as Partial<RhythmSetting> | null;
  if (!r || typeof r !== "object" || !Array.isArray(r.days)) return ["The rhythm needs seven days."];
  if (r.days.length !== 7 || r.days.some((d, i) => d?.day !== WEEKDAYS[i])) out.push("The rhythm needs Monday to Sunday, in order.");
  for (const d of r.days) {
    if (!d) continue;
    if (d.primary !== null && !RHYTHM_LANES.includes(d.primary)) out.push(`${d.day}: unknown pillar ${String(d.primary)}.`);
    if (!Array.isArray(d.fallback) || d.fallback.some((l) => !RHYTHM_LANES.includes(l))) out.push(`${d.day}: a fallback is not a known pillar.`);
    if (!Array.isArray(d.channels) || d.channels.some((c) => !(RHYTHM_CHANNELS as readonly string[]).includes(c))) out.push(`${d.day}: a channel is not LinkedIn, Instagram or YouTube.`);
    if (d.primary === null && d.channels?.length) out.push(`${d.day}: an off day posts on no channel.`);
    if (d.primary !== null && !d.channels?.length) out.push(`${d.day}: a posting day needs at least one channel.`);
  }
  if (!Array.isArray(r.blocked) || r.blocked.some((b) => !b || !(RHYTHM_CHANNELS as readonly string[]).includes(b.channel) || !Array.isArray(b.pillars) || b.pillars.some((p) => !PILLARS.includes(p)))) out.push("A blocked channel or pillar is not known.");
  if (!r.days.some((d) => d?.primary)) out.push("At least one day must post.");
  return out;
}

/** Puts a rhythm in place of the one every reader uses (lib/rhythm.ts RHYTHM is shared, so it is changed in place). */
export function applyRhythm(v: RhythmSetting): void {
  RHYTHM.days.splice(0, RHYTHM.days.length, ...JSON.parse(JSON.stringify(v.days)));
  RHYTHM.blocked = JSON.parse(JSON.stringify(v.blocked));
  if (Array.isArray(v.rules)) RHYTHM.rules.splice(0, RHYTHM.rules.length, ...v.rules);
  if (typeof v.summary === "string") RHYTHM.summary = v.summary;
}

let loadedAt = 0;
/**
 * Applies the saved rhythm (or the guide's, when none is saved or the saved one is not valid). Read at most every 30
 * seconds per server process; `fresh` reads now (after a save). A failed read keeps what is in place.
 */
export async function loadRhythm(db: SupabaseClient, opts: { fresh?: boolean } = {}): Promise<{ source: "setting" | "guide"; problems: string[] }> {
  if (!opts.fresh && Date.now() - loadedAt < 30_000) return { source: current.source, problems: current.problems };
  const { data, error } = await db.from("gtm_settings").select("value").eq("key", RHYTHM_KEY).maybeSingle();
  if (error) return { source: current.source, problems: [`settings: ${error.message}`] };
  loadedAt = Date.now();
  const value = (data as { value?: unknown } | null)?.value;
  const problems = value ? rhythmProblems(value) : [];
  if (value && !problems.length) { applyRhythm(value as RhythmSetting); current = { source: "setting", problems: [] }; }
  else { applyRhythm(guideRhythm()); current = { source: "guide", problems }; }
  return current;
}
let current: { source: "setting" | "guide"; problems: string[] } = { source: "guide", problems: [] };
