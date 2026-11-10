// Rule origami-reply-v1 (VIB-521): what an Origami reply says about contacting the person again. Deterministic, no model,
// no network. The text is judged in memory and never stored.
//
// CONFIRMED (applied without a person's approval once ORIGAMI_OPTOUT_APPLY=1, John's decision 2026-11-10):
// - Origami marked the sequence unsubscribed (status or stop_reason `unsubscribed`); or
// - the person's FIRST reply on that sequence whose words (replyCore: new text only, a leading greeting and trailing
//   sign-offs removed, case, punctuation and whitespace ignored) are exactly one of CONFIRMED_PHRASES. Our emails end
//   "Not relevant? Reply "no" and I won't contact you again.", so "Hi John, / No. / Best, Ana" answers that line.
// POSSIBLE (an OPT_OUT_REVIEW hold for a person; the Origami sequences still stop at once, a stop is reversible). Erring
// wide is deliberate: compliance treats any reply that reads as a refusal as an opt-out, and a person reviews these.
// - a confirmed phrase later in a conversation; the shared OPT_OUT wording or other unsubscribe wording, in English or a
//   European language; a clear refusal ("not interested", "thanks, but no", "nah", "nein danke", "non merci", ...); a line
//   that is only "no" or "stop"; or a short reply (SHORT_WORDS words or fewer) with a standalone no, nope, nah or stop that
//   is not "no problem", "no worries" and the like.
// Anything else: recorded, no action.
import { bareNo, foldWords, NEGATED, newText, OPT_OUT, replyCore, replyLines } from "../email/rules";

export const RULE_VERSION = "origami-reply-v1";

export const CONFIRMED_PHRASES = ["no", "no thanks", "no thank you", "not relevant", "unsubscribe", "remove me", "stop"] as const;
export const SHORT_WORDS = 25;

// English refusals and unsubscribe wording beyond OPT_OUT, matched on the folded words (apostrophes read as spaces).
const REFUSAL_EN = /\b(not interested|no interest|not relevant|no thanks|no thank you|thanks but no|but no thanks|not for (us|me)|not a (good |great )?fit|(we|i)( ll| will| shall)? pass( on (this|that|it))?|please stop|leave me alone|wrong person|not the right (person|contact|guy)|i am not the right|not looking for|don t (need|want) (this|it|that|your)|do not (need|want) (this|it|that|your)|not at this time|no longer interested)\b/;
const UNSUB_EN = /\b(unsubscribe|opt (me|us) out|take (me|us) off|please remove|remove (me|us|my)|stop (emailing|messaging|contacting|sending|writing))\b/;
// German, Dutch, French, Spanish, Italian, Portuguese, Swedish, Danish, Norwegian: refusals and unsubscribes (folded, so
// accents do not matter).
const REFUSAL_EU = new RegExp("\\b(" + [
  "nein danke", "nein vielen dank", "kein interesse", "kein bedarf", "nicht interessiert", "nicht relevant", "abmelden", "abbestellen", "austragen", "bitte entfernen", "entfernen sie mich", "keine (weiteren )?(e ?mails|nachrichten)",
  "nee bedankt", "nee dank (je|u)", "geen interesse", "niet geinteresseerd", "afmelden", "uitschrijven", "verwijder (mij|me)",
  "non merci", "pas interesse(e|s|es)?", "ne m ?interesse pas", "desinscri(re|vez|ption)", "me desinscrire", "desabonne(r|z)", "retirez moi", "ne plus recevoir",
  "no gracias", "no me interesa", "no estoy interesad[oa]", "no estamos interesados", "sin interes", "dar(se|me)? de baja", "dadme de baja", "borrame",
  "no grazie", "non mi interessa", "non sono interessat[oa]", "non siamo interessati", "cancellami", "disiscriv(i|ermi|etemi)", "rimuovimi",
  "nao obrigad[oa]", "nao tenho interesse", "nao temos interesse", "sem interesse", "nao estou interessad[oa]", "descadastr(ar|e|em)", "cancelar (a )?inscricao", "remova me",
  "nej tack", "inte intresserad(e)?", "inget intresse", "avregistrera", "avsluta prenumeration(en)?", "ta bort mig",
  "nej tak", "ikke interesseret", "ingen interesse", "afmeld", "frameld",
  "nei takk", "ikke interessert", "meld meg av", "avmeld",
].join("|") + ")\\b");
// A line that is only an answer of refusal.
const NO_LINE = /^(no|nope|nah|stop|pass|no thanks|no thank you|nein|nee|non|nej|nei|nao)$/;
// In a short reply, a standalone refusal word, once the everyday phrases that contain it are taken out.
const NO_WORD = /\b(no|nope|nah|stop|nein|nee|nej|nei|nao)\b/;
const NOT_REFUSAL = /\b(no (problem|problems|worries|worry|rush|hurry|doubt|pressure|idea|matter|issue|issues|question|questions|stress|biggie)|stop by|non stop)\b/g;
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
  const lines = replyLines(body).map((l) => foldWords(l).replace(/'/g, " ").replace(/\s+/g, " ").trim());
  const words = lines.join(" ");
  if (!NEGATED.test(fresh) && (OPT_OUT.test(fresh) || UNSUB_EN.test(words))) return { classification: "possible", reason: "opt_out_phrase" };
  if (REFUSAL_EN.test(words) && !NEGATED.test(fresh)) return { classification: "possible", reason: "refusal_phrase" };
  if (REFUSAL_EU.test(words)) return { classification: "possible", reason: "refusal_phrase_eu" };
  if (bareNo(body) || LEADING_NO.test(fresh) || lines.some((l) => NO_LINE.test(l))) return { classification: "possible", reason: "leading_no" };
  const count = words ? words.split(" ").length : 0;
  if (count && count <= SHORT_WORDS && NO_WORD.test(words.replace(NOT_REFUSAL, " "))) return { classification: "possible", reason: "short_no" };
  return { classification: "none", reason: "no_opt_out" };
}

/** Origami's own unsubscribe on a sequence: confirmed. */
export const unsubscribedStatus = (p: { status?: string | null; stop_reason?: string | null }) =>
  p.status === "unsubscribed" || p.stop_reason === "unsubscribed";
