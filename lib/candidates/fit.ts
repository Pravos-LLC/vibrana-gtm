import { assertLiveProvidersAllowed, providerFetch } from "../demo-safety";
// Audience fit at selection time (VIB-420). New briefs carry `audience_fit` and `audience_reason`
// (lib/signals/brief.ts), but every brief written before that change lacks them. Rather than re-brief the
// pool, `gtm candidates select` scores the briefs that lack it in one batched, strict-schema OpenRouter call
// against the same reader and question the brief prompt uses. Read-only: the scores are not stored; the
// briefs pick the field up when they are next rewritten.
import { audienceInstructions } from "../signals/audience";
import { briefModel, clampFit } from "../signals/brief";
import type { Fit, SelectInput, SignalRow } from "./select";

// The rubric lives in lib/signals/audience.ts (built-in, or content/guide/audience-calibration.json when present).
const system = () => `You judge AI news stories for Vibrana, an AI transformation consultancy, one entry per story.
${audienceInstructions()}
Judge only from the brief given. Return one entry per story id, using the ids exactly as given.`;

const SCHEMA = {
  type: "object", additionalProperties: false, required: ["stories"],
  properties: {
    stories: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["id", "audience_fit", "audience_reason"],
        properties: { id: { type: "string" }, audience_fit: { type: "number" }, audience_reason: { type: "string" } },
      },
    },
  },
} as const;

/** The stories a selection would gate on: briefed, not already scored, at most `limit` of the highest score (60, the briefed pool loadSelectInput reads). */
export function needsFit(input: SelectInput, limit = 60): SignalRow[] {
  const all = [...input.queued, ...input.briefed].filter((s) => s.brief && typeof s.brief.audience_fit !== "number" && !input.fits?.[s.id]);
  const seen = new Set<string>();
  return all.filter((s) => !seen.has(s.id) && (seen.add(s.id), true)).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
}

export function fitPrompt(stories: SignalRow[]): string {
  return stories.map((s) => [
    `<story id="${s.id}">`, `headline: ${s.brief!.headline}`, `what happened: ${s.brief!.what_happened}`,
    `why it matters: ${s.brief!.why_it_matters}`, `lanes: ${s.lanes.join(", ")}`, "</story>",
  ].join("\n")).join("\n\n");
}

/** Keeps only scores for ids that were asked about, clamped to 0..1, with dashes made commas. */
export function checkFits(raw: { stories?: { id: string; audience_fit: number; audience_reason: string }[] }, asked: SignalRow[]): Record<string, Fit> {
  const ids = new Set(asked.map((s) => s.id));
  const out: Record<string, Fit> = {};
  for (const r of raw.stories ?? []) {
    if (!ids.has(r.id) || typeof r.audience_fit !== "number") continue;
    out[r.id] = { audience_fit: clampFit(r.audience_fit), audience_reason: String(r.audience_reason ?? "").replace(/\s*[—–]\s*/g, ", ").trim().slice(0, 400) };
  }
  return out;
}

export type FitScorer = (stories: SignalRow[]) => Promise<Record<string, Fit>>;

export function openRouterFitScorer(opts: { key?: string; model?: string; fetcher?: typeof fetch } = {}): FitScorer {
  assertLiveProvidersAllowed();
  const key = opts.key ?? process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is required to score audience fit (or pass --no-score and accept a gated week)");
  const model = opts.model ?? briefModel();
  return async (stories) => {
    if (!stories.length) return {};
    const res = await providerFetch(opts.fetcher)("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-title": "Vibrana Sunday candidates" },
      body: JSON.stringify({
        model, max_tokens: 8000,
        messages: [{ role: "system", content: system() }, { role: "user", content: fitPrompt(stories) }],
        response_format: { type: "json_schema", json_schema: { name: "audience_fit", strict: true, schema: SCHEMA } },
        provider: { require_parameters: true },
      }),
      signal: AbortSignal.timeout(180_000),
    });
    const data = await res.json().catch(() => null) as { choices?: { message?: { content?: string }; finish_reason?: string }[]; error?: { message?: string } } | null;
    if (!res.ok || !data?.choices?.[0]) throw new Error(`openrouter ${model}: ${res.status} ${data?.error?.message ?? ""}`.trim());
    if (data.choices[0].finish_reason === "length") throw new Error(`audience fit truncated by ${model}`);
    let parsed: { stories?: { id: string; audience_fit: number; audience_reason: string }[] };
    try { parsed = JSON.parse(data.choices[0].message?.content ?? ""); } catch { throw new Error(`openrouter ${model}: unparseable audience fit`); }
    return checkFits(parsed, stories);
  };
}

/** Adds selection-time fits for every story that lacks one. A story the model skipped stays unscored (and gated). */
export async function scoreFits(input: SelectInput, score: FitScorer, limit = 60): Promise<SelectInput> {
  const todo = needsFit(input, limit);
  const fits = { ...(input.fits ?? {}), ...(await score(todo)) };
  const missed = todo.filter((s) => !fits[s.id]).length;
  return { ...input, fits, notes: [...(input.notes ?? []), ...(missed ? [`${missed} stories came back without an audience fit; they are gated this week`] : [])] };
}
