import { loadRuntimeConfig } from "../runtime-config.mjs";
import { assertLiveProvidersAllowed, providerFetch } from "../demo-safety";
// The weekly report's model call (VIB-418): same route, model and env as the Signal Desk briefs
// (OpenRouter, strict JSON schema, only providers that honor it; SIGNALS_BRIEF_MODEL overrides the model).
// The model sees the input pack and nothing else. Its answer always goes through checkReport.
import { briefModel } from "../signals/brief";
import { BANNED, type Report } from "./guard";
import type { Pack } from "./pack";

const SYSTEM = `You write ${loadRuntimeConfig().brand.authorLabel}'s weekly content report for Vibrana (an AI transformation consultancy). John posts on LinkedIn, Instagram and YouTube. You get a JSON pack with everything known about the week; you know nothing else.

The phase is awareness (October to December 2026). Success means conversations (comments from others, replies, DMs), saves and sends, and net followers. Conversions are tracked, not judged. Each pillar has its own job and leading metric (pack.pillars); judge a pillar only on its own leading metric.

Hard rules (a guard enforces them, and anything breaking them is deleted):
- Every number you write must be a value from pack.facts (or a date, or a number already in a title). Do not compute new numbers: no sums, differences, percentages or averages that are not already a fact. The pack has week-over-week changes as change.* and change_pct.* facts.
- Write exact numbers from the facts. No K or M abbreviations, no "thousand" or "million", no relative quantities (half, double, twice, tripled), no multipliers (3x): they are deleted.
- Every claim in did_well, underperformed, patterns, against_playbook and pillars, and every action, carries evidence: a list of {fact, value} where fact is a key of pack.facts and value is its exact value.
- In ref fields, refer to posts by their ref (P1, P2, ...) and to calendar items by their exact id. In prose, name a post by its title and platform ("the LinkedIn video Power vs. purpose"), never by its ref or id.
- Never add reach across platforms. Each platform has its own unit (LinkedIn impressions, Instagram accounts reached, YouTube views). Name the unit when you cite a rate.
- Posts with stage "maturing" are not judged (Instagram under 48 hours, YouTube under 3 days). Compare against medians of "final" posts (7 days or older). If a median has thin: true (fewer than 3 posts), say the comparison is thin.
- against_playbook stays empty unless pack.playbook is set. When it is, grade our posts against the channel playbook:
  - Each tagged post has playbook_tags {hook, storyline, cta, cta_awareness, confidence}; pack.playbook.standard defines each id in use and names the benchmark creators who use it (example_creators). Name hooks, storylines and CTAs by their names, never their ids.
  - CTAs carry an awareness-phase flag. "use" CTAs (no ask, an open question, pick one, a research ask) start conversations: that is the job now. "limit" CTAs (send to someone, follow, a soft link, a paid ask) are fine at most target.soft_cta_per_week times a week; say so when playbook.week.cta.limit is above it. "avoid" CTAs (comment a keyword, a lead magnet, a sales ask, a sponsored post, tag someone) are a finding every time one went out: cite the count fact playbook.week.cta.avoid as evidence, and use playbook.week.avoid_refs (a list of post refs, not a fact) only to find which posts to name. Likewise cite playbook.week.cta.limit, never playbook.week.limit_refs.
  - Compare hooks, storylines and CTAs on the settled cohort's medians (median.hook.*, median.storyline.*, median.cta.*): their "leading" value is conversations per post. Say when a median is thin.
  - Tags with confidence "low" are uncertain; do not build a finding on them alone.
  - Every against_playbook entry cites at least one playbook.* or median.hook/storyline/cta.* fact, or it is deleted.
- Absolute counts first, ratios second.

Actions are proposals John accepts or dismisses; accepting one only edits the calendar. Allowed types:
- move: item_id (from pack.upcoming) to new_date (YYYY-MM-DD, not before today).
- swap: item_id and other_item_id (upcoming or reserve) trade dates.
- replace: a reserve item (other_item_id) takes the slot of an upcoming item (item_id).
- change_format: item_id gets new_format (text, image, carousel, document, video).
- new_story: an idea slot with new_title, new_pillar, new_format, new_channels (linkedin, instagram, youtube), new_date, and signal_id when it comes from a signal in pack.signals.
Never propose approving, scheduling, publishing or deleting anything. At most five actions, the most useful first. Fewer is fine; none is fine when the data is too thin to justify a change. Unused fields are null (new_channels is an empty list).

Writing: plain American English, short sentences, no hype, no em dashes, no fake warmth. Never use these words: ${BANNED.join(", ")}.
- headline: one sentence, the week's verdict.
- lede: two or three sentences on what to take from the week.
- went_out: one short note per post this week (window "this_week").
- pillars: one entry per pillar in pack.pillars: on_track, behind, or too_early when the data cannot say yet.`;

const EVIDENCE = { type: "array", items: { type: "object", additionalProperties: false, required: ["fact", "value"], properties: { fact: { type: "string" }, value: { type: "number" } } } } as const;
const nullable = (type: string) => ({ type: [type, "null"] });

export const REPORT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["headline", "lede", "went_out", "did_well", "underperformed", "patterns", "against_playbook", "pillars", "actions"],
  properties: {
    headline: { type: "string" },
    lede: { type: "string" },
    went_out: { type: "array", items: { type: "object", additionalProperties: false, required: ["ref", "note"], properties: { ref: { type: "string" }, note: { type: "string" } } } },
    did_well: { type: "array", items: { type: "object", additionalProperties: false, required: ["ref", "why", "evidence"], properties: { ref: { type: "string" }, why: { type: "string" }, evidence: EVIDENCE } } },
    underperformed: { type: "array", items: { type: "object", additionalProperties: false, required: ["ref", "why", "evidence"], properties: { ref: { type: "string" }, why: { type: "string" }, evidence: EVIDENCE } } },
    patterns: { type: "array", items: { type: "object", additionalProperties: false, required: ["observation", "evidence"], properties: { observation: { type: "string" }, evidence: EVIDENCE } } },
    against_playbook: { type: "array", items: { type: "object", additionalProperties: false, required: ["observation", "evidence"], properties: { observation: { type: "string" }, evidence: EVIDENCE } } },
    pillars: { type: "array", items: { type: "object", additionalProperties: false, required: ["pillar", "verdict", "note", "evidence"], properties: { pillar: { type: "string" }, verdict: { type: "string", enum: ["on_track", "behind", "too_early"] }, note: { type: "string" }, evidence: EVIDENCE } } },
    actions: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["type", "item_id", "other_item_id", "new_date", "new_format", "new_title", "new_pillar", "new_channels", "signal_id", "proposal", "rationale", "evidence"],
        properties: {
          type: { type: "string", enum: ["move", "swap", "replace", "new_story", "change_format"] },
          item_id: nullable("string"), other_item_id: nullable("string"), new_date: nullable("string"), new_format: nullable("string"),
          new_title: nullable("string"), new_pillar: nullable("string"), new_channels: { type: "array", items: { type: "string" } }, signal_id: nullable("string"),
          proposal: { type: "string" }, rationale: { type: "string" }, evidence: EVIDENCE,
        },
      },
    },
  },
} as const;

export const reportModel = () => process.env.REPORT_MODEL || briefModel();

export type ReportWriter = (pack: Pack, opts?: { timeoutMs?: number }) => Promise<{ report: Report; model: string }>;

/** OpenRouter chat completion with the strict report schema. Throws on HTTP errors, refusals and truncation. */
export function openRouterReportWriter(opts: { key?: string; model?: string; fetcher?: typeof fetch } = {}): ReportWriter {
  assertLiveProvidersAllowed();
  const key = opts.key ?? process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is required for the weekly report");
  const model = opts.model ?? reportModel();
  return async (pack, call = {}) => {
    const res = await providerFetch(opts.fetcher)("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-title": "Vibrana weekly content report" },
      body: JSON.stringify({
        model,
        max_tokens: 8000,
        messages: [{ role: "system", content: SYSTEM }, { role: "user", content: `The pack:\n${JSON.stringify(pack)}` }],
        response_format: { type: "json_schema", json_schema: { name: "weekly_report", strict: true, schema: REPORT_SCHEMA } },
        provider: { require_parameters: true },
      }),
      signal: AbortSignal.timeout(Math.max(1000, Math.min(240_000, call.timeoutMs ?? 240_000))),
    });
    const data = await res.json().catch(() => null) as { choices?: { message?: { content?: string; refusal?: string | null }; finish_reason?: string }[]; error?: { message?: string } } | null;
    if (!res.ok || !data?.choices?.[0]) throw new Error(`openrouter ${model}: ${res.status} ${data?.error?.message ?? ""}`.trim());
    const choice = data.choices[0];
    if (choice.message?.refusal) throw new Error(`report declined by ${model}`);
    if (choice.finish_reason === "length") throw new Error(`report truncated by ${model}`);
    try {
      return { report: JSON.parse(choice.message?.content ?? "") as Report, model };
    } catch {
      throw new Error(`openrouter ${model}: unparseable report (finish_reason ${choice.finish_reason ?? "unknown"})`);
    }
  };
}
