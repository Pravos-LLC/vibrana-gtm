// The reply classifier (VIB-496, email contract v1 "Classification"): a typed-decision model, Jev 1.13 through OpenCode's
// System One endpoint, answers two separate questions about a reply's new text: what the person wants, and whether they
// asked not to be emailed. It runs only with EMAIL_CLASSIFIER=jev and OPENCODE_API_KEY set; spend is capped in OpenCode.
//
// - The free model is tried first, then the paid one; the answer records which model gave it.
// - An intent counts only at confidence >= INTENT_MIN; otherwise it is "uncertain" and left to a person.
// - "Asked to stop" at >= STOP_MIN is a possible opt-out: it opens a review (VIB-513) and is never applied.
// - The model never outranks a person's label or the rules (lib/email/load.ts currentDecisions).
// - The text is sent once and kept nowhere: not stored, not logged, not in errors.
import { providerFetch } from "../demo-safety";
import { newText } from "./rules";

export const ENDPOINT = "https://opencode.ai/inference/systemone/v1/systemone";
export const MODELS = ["jev-1.13-free", "jev-1.13"] as const;
export const INTENT_MIN = 0.8;
export const STOP_MIN = 0.5;
export const MAX_CHARS = 4000;
export const DECISION_VERSION = 1;

export const INTENTS = ["interested", "not_now", "not_interested", "referral", "neutral", "auto_reply"] as const;
export type Intent = (typeof INTENTS)[number] | "uncertain";

const QUESTIONS = {
  intent: {
    type: "choice",
    instructions: "This is a reply to a cold sales email. What does the person want?",
    criteria: {
      interested: "Wants to talk, learn more, or book a call now",
      not_now: "Open to it, but asks to follow up later",
      not_interested: "Declines or says it is not relevant",
      referral: "Points to someone else to talk to",
      neutral: "A question or comment with no clear direction",
      auto_reply: "An out-of-office or other automatic reply",
    },
  },
  asked_to_stop: {
    type: "noul",
    instructions: "Does the person explicitly ask not to be emailed again, or to be removed from the list?",
  },
} as const;

export type ModelDecision = { intent: Intent; opt_out: "none" | "uncertain"; model: string; confidence: number; stop: number; billing: string | null };

export const classifierEnabled = (env: Record<string, string | undefined> = process.env) =>
  env.EMAIL_CLASSIFIER?.trim().toLowerCase() === "jev" && !!env.OPENCODE_API_KEY?.trim();

/** Jev's answer, or null when it is not in the expected shape (never a guess). */
export function readAnswer(body: unknown, model: string): ModelDecision | null {
  const a = (body as { answers?: Record<string, Record<string, unknown>> } | null)?.answers;
  const choice = a?.intent?.choice, confidence = a?.intent?.confidence, stop = a?.asked_to_stop?.noul;
  if (typeof choice !== "string" || typeof confidence !== "number" || typeof stop !== "number") return null;
  if (!(INTENTS as readonly string[]).includes(choice) || confidence < 0 || confidence > 1 || stop < 0 || stop > 1) return null;
  const billing = (body as { usage?: { opencode?: { billing_source?: unknown } } }).usage?.opencode?.billing_source;
  return {
    intent: confidence >= INTENT_MIN ? (choice as Intent) : "uncertain",
    opt_out: stop >= STOP_MIN ? "uncertain" : "none",
    model, confidence, stop, billing: typeof billing === "string" ? billing.slice(0, 20) : null,
  };
}

/**
 * Classifies one reply. Returns null when there is no new text, the classifier is off, or no model answered in the
 * expected shape; the caller then leaves the reply for the next run. Errors carry the model and status only.
 */
export async function classifyReply(text: string, opts: { env?: Record<string, string | undefined>; fetcher?: typeof fetch; timeoutMs?: number } = {}): Promise<ModelDecision | null> {
  const env = opts.env ?? process.env;
  if (!classifierEnabled(env)) return null;
  const state = newText(text).slice(0, MAX_CHARS);
  if (!state) return null;
  const send = providerFetch(opts.fetcher ?? fetch);
  for (const model of MODELS) {
    try {
      const res = await send(ENDPOINT, {
        method: "POST",
        headers: { authorization: `Bearer ${env.OPENCODE_API_KEY!.trim()}`, "content-type": "application/json" },
        body: JSON.stringify({ model, state, questions: QUESTIONS }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
      });
      if (!res.ok) continue;   // the next model (the free one may be gone or rate-limited)
      const decision = readAnswer(await res.json().catch(() => null), model);
      if (decision) return decision;
    } catch { /* timeout or network: try the next model */ }
  }
  return null;
}
