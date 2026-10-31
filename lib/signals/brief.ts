import { loadRuntimeConfig } from "../runtime-config.mjs";
import { assertLiveProvidersAllowed, providerFetch } from "../demo-safety";
// Briefs for the top stories: what happened, why it matters to Vibrana's buyers, the tension worth
// writing about, and three angles. Facts come only from the story's own sources (the copy-brief rule:
// never invent a number, quote or result). Briefs are suggestions for John, never drafts in his voice.
import type { SupabaseClient } from "@supabase/supabase-js";
import { must } from "../db";
import { audienceInstructions } from "./audience";
import type { Brief, SignalsConfig } from "./config";
import { listStories, storyItems } from "./pipeline";

// Through OpenRouter (hub OPENROUTER_API_KEY). Chosen by a side-by-side test on real stories; see README
// "Signal Desk". SIGNALS_BRIEF_MODEL overrides it without a deploy of code.
export const BRIEF_MODEL = "openai/gpt-6.1-sol";
export const briefModel = () => process.env.SIGNALS_BRIEF_MODEL || BRIEF_MODEL;

const system = () => `You brief ${loadRuntimeConfig().brand.authorLabel}, founder of Vibrana (an AI transformation consultancy for companies), on one AI news story so he can decide whether to write about it.

Rules:
- Use only facts stated in the sources provided. Never add a number, name, quote or claim that is not in them. If the sources disagree or are thin, say so.
- Plain American English. No em dashes. No hype words (revolutionary, game-changer, unprecedented). Short sentences.
- "why_it_matters" speaks to operators and leaders adopting AI: cost, risk, people, power, the planet.
- "tension" names the genuinely hard question or trade-off in the story, with real stakes on more than one side. Do not moralize.
- The three angles are one-line prompts for John, not drafts: a LinkedIn take (his opinion on it), a story (a longer piece connecting it to how companies adopt AI), a video (what he would show or explain on camera).
- "sources" lists the sources you relied on, copied exactly from the input.
- "audience_fit" and "audience_reason" judge the story for Vibrana's reader (lib/signals/audience.ts):
${audienceInstructions()}`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["headline", "what_happened", "why_it_matters", "tension", "angles", "sources", "audience_fit", "audience_reason"],
  properties: {
    headline: { type: "string" },
    what_happened: { type: "string" },
    why_it_matters: { type: "string" },
    tension: { type: "string" },
    angles: {
      type: "object", additionalProperties: false, required: ["linkedin_take", "story", "video"],
      properties: { linkedin_take: { type: "string" }, story: { type: "string" }, video: { type: "string" } },
    },
    sources: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["title", "url", "source"], properties: { title: { type: "string" }, url: { type: "string" }, source: { type: "string" } } },
    },
    audience_fit: { type: "number" },
    audience_reason: { type: "string" },
  },
} as const;

type SourceItem = { url: string; source: string; author: string | null; title: string; body: string; published_at: string | null };

export function briefPrompt(title: string, lanes: string[], items: SourceItem[]): string {
  const sources = items.slice(0, 12).map((i, n) => [
    `<source n="${n + 1}">`, `title: ${i.title}`, `url: ${i.url}`, `source: ${i.source}${i.author ? ` (${i.author})` : ""}`,
    `published: ${i.published_at ?? "unknown"}`, `text: ${(i.body || i.title).slice(0, 1500)}`, "</source>",
  ].join("\n")).join("\n\n");
  return `Story: ${title}\nLanes: ${lanes.join(", ") || "none"}\n\n${sources}`;
}

/** Audience fit is a 0..1 judgment; anything else (a percentage, a stray value) is clamped into range. */
export const clampFit = (n: number) => (Number.isFinite(n) ? Math.round(Math.min(1, Math.max(0, n > 1 ? n / 100 : n)) * 100) / 100 : 0);

/** Keeps only sources the model copied from the input, so a brief can never cite an invented link. */
export function checkBrief(brief: Brief, items: SourceItem[]): Brief {
  const urls = new Set(items.map((i) => i.url));
  const sources = brief.sources.filter((s) => urls.has(s.url));
  const fallback = items.slice(0, 3).map((i) => ({ title: i.title.slice(0, 200), url: i.url, source: i.source }));
  // No em dashes (John's rule). A dash between number-bearing tokens ("3x–4x", "2025–2026") is a range and
  // becomes a hyphen; any other dash, spaced or not ("plants—for AI"), becomes a comma.
  const clean = (s: string) => s.replace(/(\w*\d\w*)[—–](\w*\d\w*)/g, "$1-$2").replace(/\s*[—–]\s*/g, ", ").trim();
  return {
    headline: clean(brief.headline), what_happened: clean(brief.what_happened), why_it_matters: clean(brief.why_it_matters), tension: clean(brief.tension),
    angles: { linkedin_take: clean(brief.angles.linkedin_take), story: clean(brief.angles.story), video: clean(brief.angles.video) },
    sources: sources.length ? sources : fallback,
    ...(typeof brief.audience_fit === "number" ? { audience_fit: clampFit(brief.audience_fit), audience_reason: clean(brief.audience_reason ?? "") } : {}),
  };
}

export type BriefWriter = (title: string, lanes: string[], items: SourceItem[], opts?: { timeoutMs?: number }) => Promise<Brief>;

/** OpenRouter chat completion with a strict JSON schema; only providers that honor the schema are used. */
export function openRouterWriter(opts: { key?: string; model?: string; fetcher?: typeof fetch } = {}): BriefWriter {
  assertLiveProvidersAllowed();
  const key = opts.key ?? process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is required for Signal Desk briefs");
  const model = opts.model ?? briefModel();
  return async (title, lanes, items, call = {}) => {
    const res = await providerFetch(opts.fetcher)("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-title": "Vibrana Signal Desk" },
      body: JSON.stringify({
        model,
        max_tokens: 4000,
        messages: [{ role: "system", content: system() }, { role: "user", content: briefPrompt(title, lanes, items) }],
        response_format: { type: "json_schema", json_schema: { name: "brief", strict: true, schema: SCHEMA } },
        provider: { require_parameters: true },
      }),
      signal: AbortSignal.timeout(Math.max(1000, Math.min(120_000, call.timeoutMs ?? 120_000))),
    });
    const data = await res.json().catch(() => null) as { choices?: { message?: { content?: string; refusal?: string | null }; finish_reason?: string }[]; error?: { message?: string } } | null;
    if (!res.ok || !data?.choices?.[0]) throw new Error(`openrouter ${model}: ${res.status} ${data?.error?.message ?? ""}`.trim());
    const choice = data.choices[0];
    if (choice.message?.refusal) throw new Error(`brief declined by ${model}`);
    if (choice.finish_reason === "length") throw new Error(`brief truncated by ${model}`);
    let parsed: Brief;
    try { parsed = JSON.parse(choice.message?.content ?? "") as Brief; } catch {
      throw new Error(`openrouter ${model}: unparseable brief (finish_reason ${choice.finish_reason ?? "unknown"})`);
    }
    return checkBrief(parsed, items);
  };
}

/** Briefs the top stories that have no brief yet, or have gained sources since their last brief. */
/**
 * `deadline` (epoch ms): no brief starts after it and each call's timeout is capped at what is left, so the
 * digest cron finishes inside Vercel's 300 s; stories not reached are briefed on the next run.
 */
export async function briefTopStories(db: SupabaseClient, cfg: SignalsConfig, write?: BriefWriter, now = new Date(), deadline = Infinity) {
  // Throws without OPENROUTER_API_KEY: the cron fails loudly rather than send briefless digests forever.
  write ??= openRouterWriter();
  const since = new Date(now.getTime() - cfg.ranking.window_hours * 3600_000).toISOString();
  const top = (await listStories(db, { since, limit: cfg.ranking.top_n_briefs })) as { id: string; title: string; lanes: string[]; briefed_at: string | null; last_seen: string; status: string }[];
  const due = top.filter((s) => s.status !== "dismissed" && (!s.briefed_at || s.briefed_at < s.last_seen));
  const items = await storyItems(db, due.map((s) => s.id));
  const out = { briefed: 0, errors: [] as { story: string; error: string }[] };
  for (const story of due) {
    const left = deadline - Date.now();
    if (left < 5000) { out.errors.push({ story: story.id, error: "skipped: digest time budget used up" }); continue; }
    try {
      const brief = await write(story.title, story.lanes, items.filter((i) => i.story_id === story.id), { timeoutMs: Math.min(120_000, left) });
      must(await db.from("gtm_signal_stories").update({ brief, briefed_at: now.toISOString() }).eq("id", story.id), "save brief");
      out.briefed++;
    } catch (e) {
      out.errors.push({ story: story.id, error: (e as Error).message.slice(0, 200) });
    }
  }
  return out;
}
