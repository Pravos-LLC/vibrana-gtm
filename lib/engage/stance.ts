import { assertLiveProvidersAllowed, providerFetch } from "../demo-safety";
// Stance only (VIB-424): the same stance definitions and model as the drafting call, without drafting a
// reply. For re-reading history in bulk (comment-history calibration) at a fraction of the cost: one call per
// post, up to 40 comments a call. Read-only: it returns labels and writes nothing.
import { STANCE_RULES, draftModel, stripDashes } from "./draft";
import { STANCES, type Stance } from "./parse";

export type StanceInput = { platform: string; post: string; comments: { id: string; text: string; in_reply_to?: string | null }[] };
export type StanceLabel = { comment_id: string; stance: Stance; objection: string };

const SYSTEM = `You label comments on Sample Author's social posts. John runs Vibrana, an AI transformation consultancy for companies. Judge each comment against what the post actually says.

Stance:
${STANCE_RULES}

Return one entry per comment, with its comment_id copied exactly. Write nothing else.`;

const SCHEMA = {
  type: "object", additionalProperties: false, required: ["labels"],
  properties: {
    labels: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["comment_id", "stance", "objection"],
        properties: { comment_id: { type: "string" }, stance: { type: "string", enum: [...STANCES] }, objection: { type: "string" } },
      },
    },
  },
} as const;

export function stancePrompt(input: StanceInput): string {
  const list = input.comments.map((c) => [`<comment comment_id="${c.id}">`, c.in_reply_to ? `in reply to: ${c.in_reply_to.slice(0, 300)}` : null, c.text.slice(0, 1200), "</comment>"].filter(Boolean).join("\n")).join("\n");
  return [`Platform: ${input.platform}`, input.post ? `<post>\n${input.post.slice(0, 1500)}\n</post>` : "(no post text available)", list].join("\n\n");
}

/** Keeps only known comment ids and stances; objections are one neutral line with no dashes. */
export function checkLabels(labels: { comment_id: string; stance: string; objection?: string }[], ids: Set<string>): StanceLabel[] {
  return labels.filter((l) => ids.has(l.comment_id) && (STANCES as readonly string[]).includes(l.stance)).map((l) => ({
    comment_id: l.comment_id, stance: l.stance as Stance,
    objection: ["supportive", "question", "spam"].includes(l.stance) ? "" : stripDashes(String(l.objection ?? "")).replace(/\s+/g, " ").trim().slice(0, 300),
  }));
}

export type StanceClassifier = (input: StanceInput, opts?: { timeoutMs?: number }) => Promise<{ labels: StanceLabel[]; usage: { prompt_tokens?: number; completion_tokens?: number; cost?: number } }>;

export function openRouterStanceClassifier(opts: { key?: string; model?: string; fetcher?: typeof fetch } = {}): StanceClassifier {
  assertLiveProvidersAllowed();
  const key = opts.key ?? process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is required to classify stance");
  const model = opts.model ?? draftModel();
  return async (input, call = {}) => {
    const res = await providerFetch(opts.fetcher)("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-title": "Vibrana Engage stance" },
      body: JSON.stringify({
        model, max_tokens: 4000, usage: { include: true },
        messages: [{ role: "system", content: SYSTEM }, { role: "user", content: stancePrompt(input) }],
        response_format: { type: "json_schema", json_schema: { name: "stances", strict: true, schema: SCHEMA } },
        provider: { require_parameters: true },
      }),
      signal: AbortSignal.timeout(call.timeoutMs ?? 120_000),
    });
    const data = await res.json().catch(() => null) as { choices?: { message?: { content?: string }; finish_reason?: string }[]; usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number }; error?: { message?: string } } | null;
    if (!res.ok || !data?.choices?.[0]) throw new Error(`openrouter ${model}: ${res.status} ${data?.error?.message ?? ""}`.trim());
    let parsed: { labels?: { comment_id: string; stance: string; objection?: string }[] };
    try { parsed = JSON.parse(data.choices[0].message?.content ?? ""); } catch { throw new Error(`openrouter ${model}: unparseable labels`); }
    return { labels: checkLabels(parsed.labels ?? [], new Set(input.comments.map((c) => c.id))), usage: data.usage ?? {} };
  };
}
