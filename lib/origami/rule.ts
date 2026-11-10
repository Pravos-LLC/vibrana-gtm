// Rule origami-reply-v1 (VIB-521): what an Origami reply says about contacting the person again. Deterministic, no model,
// no network. The text is judged in memory and never stored.
//
// CONFIRMED (applied without a person's approval once ORIGAMI_OPTOUT_APPLY=1, John's decision 2026-11-10):
// - Origami marked the sequence unsubscribed (status or stop_reason `unsubscribed`); or
// - the person's FIRST reply on that sequence whose words (replyCore: new text only, case, punctuation, whitespace and
//   sign-offs like "thanks" ignored) are exactly one of CONFIRMED_PHRASES. Our emails end "Not relevant? Reply "no" and
//   I won't contact you again.", so a first reply of "no" answers that line.
// POSSIBLE (an OPT_OUT_REVIEW hold for a person; the Origami sequences still stop at once, a stop is reversible):
// - a confirmed phrase later in a conversation, the shared OPT_OUT wording, a reply that opens with a bare "no", or a
//   clear refusal ("not interested", "not for us", ...).
// Anything else: recorded, no action.
import { bareNo, NEGATED, newText, OPT_OUT, replyCore } from "../email/rules";

export const RULE_VERSION = "origami-reply-v1";

export const CONFIRMED_PHRASES = ["no", "no thanks", "no thank you", "not relevant", "unsubscribe", "remove me", "stop"] as const;

// Clear refusals in the person's own words. A possible opt-out only: a person decides whether it is one.
const REFUSAL = /\b(not interested|no interest|not relevant|no thanks|no thank you|not for (us|me)|not a (good |great )?fit|(we|i)('ll| will) pass|please stop|leave me alone|wrong person|not looking for|don'?t (need|want) (this|it|that|your)|do not (need|want) (this|it|that|your))\b/i;
// The reply opens with "no" as a word of its own ("No.", "No, we're set"), not "No problem" or "No worries".
const LEADING_NO = /^\s*no\s*([.!,;:\n\u2013\u2014-]|$)/i;

export type Classification = "confirmed" | "possible" | "none";
export type RuleResult = { classification: Classification; reason: string };

/** Whether the reply's words are exactly a confirmed phrase. Pure. */
export const exactPhrase = (body: string) => (CONFIRMED_PHRASES as readonly string[]).includes(replyCore(body));

/**
 * Classify one lead reply. `first` is whether it is the person's first reply on its sequence (null when that could not be
 * established, which never confirms). Pure.
 */
export function classifyReply(body: string, first: boolean | null): RuleResult {
  if (exactPhrase(body)) return first === true ? { classification: "confirmed", reason: "exact_phrase" } : { classification: "possible", reason: "exact_phrase_later" };
  const fresh = newText(body);
  if (OPT_OUT.test(fresh) && !NEGATED.test(fresh)) return { classification: "possible", reason: "opt_out_phrase" };
  if (bareNo(body) || LEADING_NO.test(fresh)) return { classification: "possible", reason: "leading_no" };
  if (REFUSAL.test(fresh)) return { classification: "possible", reason: "refusal_phrase" };
  return { classification: "none", reason: "no_opt_out" };
}

/** Origami's own unsubscribe on a sequence: confirmed. */
export const unsubscribedStatus = (p: { status?: string | null; stop_reason?: string | null }) =>
  p.status === "unsubscribed" || p.stop_reason === "unsubscribed";
