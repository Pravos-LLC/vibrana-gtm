// The reply classifier (VIB-496, email contract v1 "Classification"): a typed-decision model, Jev 1.13 through OpenCode's
// System One endpoint, answers two separate questions about a reply's new text: what the person wants, and whether they
// asked not to be emailed. It runs only with EMAIL_CLASSIFIER=jev and OPENCODE_API_KEY set; spend is capped in OpenCode.
//
// - The free model is tried first, then the paid one; the answer records which model gave it.
// - An intent counts only at confidence >= INTENT_MIN; otherwise it is "uncertain" and left to a person.
// - "Asked to stop" at >= STOP_MIN is a possible opt-out: it opens a review (VIB-513) and is never applied.
// - The model never outranks a person's label or the rules (lib/email/load.ts currentDecisions).
// - Only the reply's new text leaves, with addresses and phone numbers masked; when that cannot be isolated, nothing is sent.
// - The text is sent once and kept nowhere: not stored, not logged, not in errors.
import { providerFetch } from "../demo-safety";
import { ATTRIBUTION_END, newText } from "./rules";

export const ENDPOINT = "https://opencode.ai/inference/systemone/v1/systemone";
export const MODELS = ["jev-1.13-free", "jev-1.13"] as const;
export const INTENT_MIN = 0.8;
export const STOP_MIN = 0.5;
export const MAX_CHARS = 4000;
export const DECISION_VERSION = 1;
export const ATTEMPT_MS = 20_000, RESERVE_MS = 15_000, MIN_ATTEMPT_MS = 3_000;

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
/** decided: the model answered. skipped: nothing safe to send (terminal; recorded so the reply is done). failed: no model
 *  answered in time or in shape (the reply is tried again next run). `attempts` counts real requests sent. */
export type ClassifyResult =
  | { status: "decided"; decision: ModelDecision; attempts: number }
  | { status: "skipped"; reason: "no_text" | "quoted_header"; attempts: 0 }
  | { status: "failed"; attempts: number };

const EMAIL = /[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[a-z]{2,}/gi;
const PHONE = /\+?\d[\d\s().-]{7,}\d/g;
// A labeled line carrying an address or a date ("Original sender: a@b", "Sent: 5 Nov 2026"): likely quoted mail.
const HEADER_LEFT = /^\s*\*?\p{L}[\p{L} ]{1,24}\*?\s*[:：]\s*.*(@|\d{4})/mu;

/**
 * What may leave for the model: the reply's new text cut at every quote marker, high-confidence or broad (strictText),
 * addresses and phone numbers masked, 4,000 characters at most. When something that looks like a mail
 * header survives, nothing is sent: the boundary errs toward sending less (review of #34, finding 1).
 */
// Broader, language-independent cut-offs for what leaves (review of #34, rounds 2-3): any ruled or dashed line, a bare
// attribution ending, Outlook's rule, and a header-like line in any alphabet once the reply has started. They may cut real
// text; that only means the model sees less. The local opt-out rule reads newText, which keeps such text.
const ANY_RULE = /^\s*(-{3,}.*-{3,}|[-_=*~]{8,})\s*$/u;
const ANY_HEADER = /^\s*\*?\p{L}[\p{L} ]{0,24}\*?\s*[:：]\s*.*(@|\d)/u;
const LABEL_HEADER = /^\s*\*?(From|Von|De|Da|Van|Från|Fra|Lähettäjä|Sent|Gesendet|Envoyé|Enviado|Inviato|Verzonden|Skickat|Sendt|Date|Datum|Fecha|Data|Subject|Betreff|Objet|Asunto|Assunto|Oggetto|Onderwerp|Ämne|Emne|To|An|À|Para|Aan|Till|Til|Cc)\*?\s*:\s*\S/i;

/** The reply's new text cut at any of the broader markers too: the most that may leave for the model. */
export function strictText(text: string): string {
  const out: string[] = [];
  for (const l of newText(text).split("\n")) {
    if (ANY_RULE.test(l) || ATTRIBUTION_END.test(l)) break;
    if ((ANY_HEADER.test(l) || LABEL_HEADER.test(l)) && out.length > 0) break;
    out.push(l);
  }
  return out.join("\n").trim();
}

export function outboundText(text: string): { text: string } | { skip: "no_text" | "quoted_header" } {
  const fresh = strictText(text);
  if (!fresh) return { skip: "no_text" };
  if (HEADER_LEFT.test(fresh)) return { skip: "quoted_header" };
  const masked = fresh.replace(EMAIL, "[email]").replace(PHONE, "[phone]").slice(0, MAX_CHARS).trim();
  return masked ? { text: masked } : { skip: "no_text" };
}

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
 * Classifies one reply within the caller's deadline: every attempt gets only the time left (minus a reserve for saving
 * results), and the fallback never resets it (review of #34, finding 3). Errors carry nothing of the text or the key.
 */
export async function classifyReply(text: string, opts: { env?: Record<string, string | undefined>; fetcher?: typeof fetch; deadline?: number; now?: () => number; maxAttempts?: number } = {}): Promise<ClassifyResult> {
  const env = opts.env ?? process.env;
  if (!classifierEnabled(env)) return { status: "failed", attempts: 0 };
  const out = outboundText(text);
  if ("skip" in out) return { status: "skipped", reason: out.skip, attempts: 0 };
  const now = opts.now ?? Date.now;
  const send = providerFetch(opts.fetcher ?? fetch);
  let attempts = 0;
  for (const model of MODELS.slice(0, Math.max(0, opts.maxAttempts ?? MODELS.length))) {
    const left = opts.deadline != null ? opts.deadline - RESERVE_MS - now() : ATTEMPT_MS;
    if (left < MIN_ATTEMPT_MS) break;   // not enough time left: the reply waits for the next run
    attempts++;
    try {
      const res = await send(ENDPOINT, {
        method: "POST",
        headers: { authorization: `Bearer ${env.OPENCODE_API_KEY!.trim()}`, "content-type": "application/json" },
        body: JSON.stringify({ model, state: out.text, questions: QUESTIONS }),
        signal: AbortSignal.timeout(Math.min(ATTEMPT_MS, left)),
      });
      if (!res.ok) continue;   // the next model (the free one may be gone or rate-limited)
      const decision = readAnswer(await res.json().catch(() => null), model);
      if (decision) return { status: "decided", decision, attempts };
    } catch { /* timeout or network: try the next model */ }
  }
  return { status: "failed", attempts };
}
