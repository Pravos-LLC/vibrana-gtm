// The pipeline dashboard's settings (gtm.vibrana.ai/pipeline, VIB-499): the take-home goal, the costs that sit between
// cash and take-home, FX planning rates, and the planning rates the reverse funnel uses until enough deals are measured.
// Stored in gtm_settings under the key "pipeline"; these defaults apply when nothing is saved. Definitions: hub
// gtm/strategy/pipeline-metrics.md. Pure apart from loadSalesSettings.
import type { SupabaseClient } from "@supabase/supabase-js";

export const SALES_KEY = "pipeline";

export const OPEN_STAGES = ["IDENTIFIED", "CONTACTED", "QUALIFIED", "PROPOSAL"] as const;
export type OpenStage = (typeof OPEN_STAGES)[number];

export type SalesSettings = {
  /** Monthly take-home John needs, in USD (John, 2026-11-05: take-home, not gross cash or signed value). */
  goalUsd: number;
  /** Monthly business costs paid before take-home, in USD. */
  overheadUsd: number;
  /** Share of collected contribution set aside for tax, 0 to 0.6. */
  taxReserve: number;
  /** USD per unit of each currency. Planning rates, not quotes. */
  fx: Record<string, number>;
  /** Used for the required pace until there are measured won deals. USD. */
  plannedDealUsd: number;
  /** Planning conversion rates, replaced on the page by measured ones at MIN_MEASURED data points. */
  rates: { winFromQualified: number; qualifiedFromMeeting: number; meetingFromPositive: number; positiveFromTouch: number };
  /** Probability of an open deal at each stage, for weighted pipeline. */
  stageWeights: Record<OpenStage, number>;
  /** Paths that signal buying intent, per site (prefix match). */
  highIntentPaths: Record<string, string[]>;
  /** Months of required fee the open pipeline should cover. */
  coverageMonths: number;
};

/** A rate needs this many observations before it replaces the planning rate. */
export const MIN_MEASURED = 10;

// FX: ECB reference via frankfurter.dev, 2026-11-04 (GBP 1.35, EUR 1.1267 USD). Rates: hub pipeline-metrics.md.
export const DEFAULT_SALES_SETTINGS: SalesSettings = {
  goalUsd: 10_000,
  overheadUsd: 0,
  taxReserve: 0,
  fx: { USD: 1, GBP: 1.35, EUR: 1.13 },
  // The hub's illustrative sprint (gtm/strategy/offer-ladder.md, gtm-hypotheses.md): $15k. Replaced by the average of
  // won deals once three have fees.
  plannedDealUsd: 15_000,
  rates: { winFromQualified: 0.5, qualifiedFromMeeting: 0.65, meetingFromPositive: 0.5, positiveFromTouch: 0.02 },
  stageWeights: { IDENTIFIED: 0.05, CONTACTED: 0.1, QUALIFIED: 0.3, PROPOSAL: 0.5 },
  highIntentPaths: {
    // Routes that exist on each site today (checked 2026-11-05): the offer, contact and assessment pages.
    "vibrana.ai": ["/ai-build-sprint", "/contact", "/ai-readiness", "/eu-ai-act-readiness", "/ai-transformation", "/executive-ai-transformation", "/company-brain-lab"],
    "john-ellison.com": ["/contact", "/services", "/ai-transformation", "/executive-ai-transformation", "/work"],
    "aiosbrain.dev": ["/team-brain", "/workspace", "/licensing"],
  },
  coverageMonths: 2,
};

const rate = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 1;
const money = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 10_000_000;

/** Problems with settings someone typed; empty when they can be saved. */
export function salesSettingsProblems(v: unknown): string[] {
  const s = v as Partial<SalesSettings> | null;
  if (!s || typeof s !== "object") return ["Settings must be an object."];
  const out: string[] = [];
  if (!money(s.goalUsd) || !s.goalUsd) out.push("The goal must be a positive amount in USD.");
  if (!money(s.overheadUsd)) out.push("Overhead must be zero or more.");
  if (typeof s.taxReserve !== "number" || s.taxReserve < 0 || s.taxReserve > 0.6) out.push("The tax reserve must be between 0% and 60%.");
  if (!s.fx || typeof s.fx !== "object" || s.fx.USD !== 1 || Object.entries(s.fx).some(([k, x]) => !/^[A-Z]{3}$/.test(k) || typeof x !== "number" || !(x > 0) || x > 1000))
    out.push("FX needs USD = 1 and a positive USD rate for each currency code.");
  if (!money(s.plannedDealUsd) || !s.plannedDealUsd) out.push("The planned deal size must be positive.");
  const r = s.rates as Record<string, unknown> | undefined;
  if (!r || !["winFromQualified", "qualifiedFromMeeting", "meetingFromPositive", "positiveFromTouch"].every((k) => rate(r[k]))) out.push("Each planning rate must be above 0% and at most 100%.");
  const w = s.stageWeights as Record<string, unknown> | undefined;
  if (!w || !OPEN_STAGES.every((k) => rate(w[k]))) out.push("Each stage weight must be above 0% and at most 100%.");
  const h = s.highIntentPaths as Record<string, unknown> | undefined;
  if (!h || typeof h !== "object" || Object.values(h).some((p) => !Array.isArray(p) || p.some((x) => typeof x !== "string" || !x.startsWith("/"))))
    out.push("High-intent paths must be lists of paths starting with /.");
  if (typeof s.coverageMonths !== "number" || s.coverageMonths < 1 || s.coverageMonths > 6) out.push("Coverage months must be 1 to 6.");
  return out;
}

/** Saved values over the defaults, key by key, so a setting saved before a new field existed still loads. */
export function mergeSalesSettings(saved: unknown): SalesSettings {
  const d = DEFAULT_SALES_SETTINGS;
  const s = (saved && typeof saved === "object" ? saved : {}) as Partial<SalesSettings>;
  return {
    ...d, ...s,
    fx: { ...d.fx, ...(s.fx ?? {}), USD: 1 },
    rates: { ...d.rates, ...(s.rates ?? {}) },
    stageWeights: { ...d.stageWeights, ...(s.stageWeights ?? {}) },
    highIntentPaths: { ...d.highIntentPaths, ...(s.highIntentPaths ?? {}) },
  };
}

/** The saved settings, or the defaults when none are saved or the saved ones are not valid (with the reasons). */
export async function loadSalesSettings(db: SupabaseClient): Promise<{ settings: SalesSettings; source: "saved" | "default"; problems: string[] }> {
  const { data, error } = await db.from("gtm_settings").select("value").eq("key", SALES_KEY).maybeSingle();
  if (error) return { settings: DEFAULT_SALES_SETTINGS, source: "default", problems: [`settings: ${error.message}`] };
  const value = (data as { value?: unknown } | null)?.value;
  if (!value) return { settings: DEFAULT_SALES_SETTINGS, source: "default", problems: [] };
  const merged = mergeSalesSettings(value);
  const problems = salesSettingsProblems(merged);
  return problems.length ? { settings: DEFAULT_SALES_SETTINGS, source: "default", problems } : { settings: merged, source: "saved", problems: [] };
}
