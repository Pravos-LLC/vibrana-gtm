// Deterministic email rules (email contract v1, VIB-511). Pure; text is processed in memory and never stored.
//
// Failure reports (RFC 3464 delivery status): each Final-Recipient gets a delivery outcome for its own attempt.
// - 5.1.x (bad mailbox, bad domain, moved) is a permanently invalid address: failed_invalid_address.
// - 5.7.x and policy/authentication/reputation wording is about the sender, not the contact: failed_policy.
// - 4.x.x, Action: delayed, and a full mailbox (x.2.2) are temporary: delayed. Nothing permanent follows.
// - Any other 5.x.x is failed_unclassified. No status at all is unresolved and is not applied.
// A generic mailer-daemon message alone never proves an invalid recipient.
//
// Replies: only the new text counts (quoted lines and everything after an "On ... wrote:" line are dropped), so an earlier
// message's unsubscribe footer quoted back is not an opt-out. A clear opt-out phrase is a *possible* opt-out: it is held
// for a human, never applied by itself.

export type Delivery = "delayed" | "failed_invalid_address" | "failed_policy" | "failed_unclassified";
export type FailureRecipient = { address: string; delivery: Delivery; status: string | null };

// Sender-side wording wins over an address status: "550 5.1.1 authentication required" is the sender's problem (review of #32, F1).
const POLICY = /\b(spam|blocked|block ?list|blacklist(ed)?|reputation|policy|dmarc|dkim|spf|(un)?authenticat\w*|rejected for security|not authori[sz]ed to send|5\.7\.\d+)\b/i;

export function classifyStatus(status: string | null, action: string | null, diagnostic: string): Delivery | null {
  const s = (status ?? "").trim(), a = (action ?? "").trim().toLowerCase();
  if (a === "delayed" || /^4\./.test(s)) return "delayed";
  if (/^5\.2\.2$/.test(s) || /mailbox (is )?full|over quota/i.test(diagnostic)) return "delayed";
  if (/^5\.7\./.test(s) || (s.startsWith("5.") && POLICY.test(diagnostic))) return "failed_policy";
  if (/^5\.1\.\d+$/.test(s)) return "failed_invalid_address";
  if (/^5\./.test(s)) return "failed_unclassified";
  if (a === "failed") return POLICY.test(diagnostic) ? "failed_policy" : "failed_unclassified";
  return null;
}

/** Per-recipient outcomes from the message/delivery-status text of a failure report. */
export function parseDeliveryStatus(text: string): FailureRecipient[] {
  const out: FailureRecipient[] = [];
  // Per-recipient blocks are separated by blank lines; the first block is per-message fields.
  for (const block of text.replace(/\r\n/g, "\n").replace(/\n[ \t]+/g, " ").split(/\n\s*\n/)) {
    const field = (name: string) => block.match(new RegExp(`^${name}:\\s*(.+)$`, "im"))?.[1]?.trim() ?? null;
    const rcpt = field("Final-Recipient") ?? field("Original-Recipient");
    if (!rcpt) continue;
    const address = rcpt.replace(/^[a-z0-9-]+;\s*/i, "").replace(/^<|>$/g, "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) continue;
    const status = field("Status")?.match(/\d\.\d{1,3}\.\d{1,3}/)?.[0] ?? null;
    const delivery = classifyStatus(status, field("Action"), field("Diagnostic-Code") ?? "");
    if (delivery) out.push({ address, delivery, status });
  }
  return out;
}

// Where quoted mail starts. Only high-confidence markers, because this text also feeds the local opt-out rule: an ordinary
// line ("Reason: 3 emails this week", a "=====" rule) must never hide a request below it (review of #34, round 3). The
// classifier's outbound text cuts more aggressively on top of this (lib/email/classifier.ts strictText).
export const NAMED_SEPARATOR = /^\s*-{2,}\s*(Original Message|Forwarded message|Ursprüngliche Nachricht|Weitergeleitete Nachricht|Message d'origine|Message transféré|Mensaje original|Mensagem original|Messaggio originale|Oorspronkelijk bericht|Originalmeddelande|Opprinnelig melding|Original meddelelse|Alkuperäinen viesti)/i;
// Words framed by dashes, in any language ("-----Исходное сообщение-----"). Only a separator when a sender header follows:
// a reply may frame its own words the same way ("----- Please remove me -----", review of #34, round 4).
export const DASHED_WORDS = /^\s*-{3,}\s*\p{L}[\p{L}' ]{2,40}\s*-{3,}\s*$/u;
export const OUTLOOK_RULE = /^\s*_{10,}\s*$/;
// A sender header carrying an address, in the common languages ("From: Name <a@b>", "От: ...").
export const FROM_HEADER = /^\s*\*?(From|Von|De|Da|Van|Från|Fra|Lähettäjä|Od|От|Від|Kimden|Feladó)\*?\s*[:：].*@/iu;
// An attribution line carrying an address and ending in a colon (Gmail's attribution in any language).
export const ADDRESS_COLON = /[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+.*[:：]\s*$/u;
export const ATTRIBUTION_END = /(wrote|schrieb|a écrit|escribió|escreveu|ha scritto|schreef|skrev|kirjoitti)\s*:\s*$/i;
// German and Dutch put the sender after the verb ("Am ... schrieb Sender <a@b>:").
const ATTRIBUTION_VERB = /\b(wrote|schrieb|a écrit|escribió|escreveu|ha scritto|schreef|skrev|kirjoitti)\b.*:\s*$/i;
const ATTRIBUTION_START = /^\s*(On|Am|Le|El|Em|Il|Op|Den|Dne)\s/i;

/** The new text of a reply: no quoted lines, nothing from a high-confidence quote marker on (an attribution line, a named
 *  or dashed separator, Outlook's rule before a sender header, a sender header with an address). */
export function newText(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*>/.test(l)) continue;
    // An attribution line, also when a mail client wraps it over up to three lines ("On Thu, ..., Sender" / "<a@b> wrote:").
    if (ATTRIBUTION_START.test(l) && lines.slice(i, i + 3).some((x) => ATTRIBUTION_END.test(x) || ATTRIBUTION_VERB.test(x))) break;
    if (ADDRESS_COLON.test(l) || NAMED_SEPARATOR.test(l)) break;
    // A framed or ruled line right above a sender header starts quoted mail. The framed line itself, and any line between it
    // and the header, stay: their words may be the person's own ("----- Please remove me -----", or a request typed under
    // Outlook's rule; review of #34, round 5, and VIB-517). A real separator carries no request, and a real Outlook header
    // block follows its rule directly. The outbound text (strictText) still drops all of it.
    if (DASHED_WORDS.test(l) || OUTLOOK_RULE.test(l)) {
      const h = lines.slice(i + 1, i + 3).findIndex((x) => FROM_HEADER.test(x));
      if (h >= 0) { out.push(...lines.slice(i, i + 1 + h).filter((x) => !/^\s*>/.test(x))); break; }
    }
    if (FROM_HEADER.test(l) && out.length > 0) break;
    out.push(l);
  }
  return out.join("\n").trim();
}

export const OPT_OUT = /\b(unsubscribe( me)?|remove me|take me off|stop (emailing|e-mailing|contacting|sending)|do not (email|contact)|don'?t (email|contact) me|opt(ed)? out|no more emails)\b/i;
export const NEGATED = /\b(don'?t|do not|please don'?t|no need to)\s+(unsubscribe|remove)\b/i;

/** Lowercase words only: curly quotes folded, punctuation and runs of whitespace become one space. */
export const normalizeWords = (s: string) =>
  s.toLowerCase().replace(/[‘’]/g, "'").replace(/[^\p{L}\p{N}'\s]+/gu, " ").replace(/'(?!\p{L})|(?<!\p{L})'/gu, " ").replace(/\s+/g, " ").trim();

/** normalizeWords without accents ("désinscrire" and "desinscrire" read the same). */
export const foldWords = (s: string) => normalizeWords(s).normalize("NFD").replace(/\p{M}+/gu, "").replace(/ß/g, "ss");

// Sign-offs that carry no meaning of their own. A line that is only one of these, or a trailing one on the last line, is
// dropped; so is a short name line directly under a sign-off line ("Thanks,\nAna").
const SIGN_OFF = /^(thanks|thank you|thanks a lot|many thanks|thx|ty|cheers|regards|best|best regards|kind regards|warm regards|all the best|br|danke|merci|gracias|grazie|obrigado|obrigada|tack|tak|takk|bedankt|groeten|gruss|grusse|liebe grusse|viele grusse|mit freundlichen grussen|cordialement|saludos|un saludo|cordiali saluti|saluti|met vriendelijke groet|mvg|hilsen|halsningar|med vanlig halsning|atenciosamente|abracos)$/;
const TRAILING_SIGN_OFF = /\s(thanks|thank you|thx|cheers|regards|best regards|kind regards)$/;
// Greetings, in the languages our campaigns reach. A first line that is only a greeting and a name is dropped, and a
// greeting that opens the first line ("Dear John, no.") is cut off it, so the answer under it is what is judged (VIB-521).
const GREETING = "hi|hello|hey|hiya|dear|greetings|good morning|good afternoon|good evening|morning|hallo|hoi|hej|hei|moin|servus|guten morgen|guten tag|liebe|lieber|sehr geehrte|sehr geehrter|bonjour|bonsoir|salut|cher|chere|hola|buenos dias|buenas tardes|buenas|estimado|estimada|ciao|salve|buongiorno|gentile|ola|bom dia|boa tarde|caro|cara|goedemorgen|goedemiddag|goedendag|beste";
const GREETING_LINE = new RegExp(`^(${GREETING})( [\\p{L}.]+){0,3}$`, "u");
const GREETING_PREFIX = new RegExp(`^\\s*(${GREETING})\\b[^,!:\\n\u2013\u2014-]{0,40}[,!:\u2013\u2014-]+\\s*(?=\\S)`, "iu");
// "John - no." / "Ana, stop": a single capitalized name before the answer. Words that are part of an answer are not names.
const NAME_PREFIX = /^\s*(\p{Lu}[\p{L}'-]{1,30})\s*[,\u2013\u2014-]\s*(?=\S)/u;
const NOT_A_NAME = new Set(["no", "nope", "nah", "stop", "thanks", "thank", "yes", "sure", "ok", "okay", "sorry", "well", "unfortunately", "honestly", "again", "please",
  "nein", "non", "nee", "nej", "nei", "nao", "sadly", "actually", "hmm", "also", "but", "and", "so", "great", "perfect", "fine", "danke", "merci", "gracias", "grazie"]);

/** The reply's new text as lines of words: cut at a signature, without a leading greeting or trailing sign-offs. Pure. */
export function replyLines(text: string): string[] {
  const raw: string[] = [];
  for (const l of newText(text).split("\n")) {
    if (/^--\s*$/.test(l) || /^\s*sent from my\b/i.test(l) || /^\s*get outlook for\b/i.test(l)) break;
    if (l.trim()) raw.push(l);
  }
  // Leading greetings: a greeting opening the first line with the answer after it ("Dear John, no."), else a line that is
  // only a greeting and a name ("Hi John,"), then a name opening the first line ("John - no.").
  const plain = (l: string) => l.normalize("NFD").replace(/\p{M}+/gu, "");
  for (let guard = 0; raw.length && guard < 3; guard++) {
    const g = plain(raw[0]).match(GREETING_PREFIX);
    if (g) { raw[0] = plain(raw[0]).slice(g[0].length); break; }
    if (GREETING_LINE.test(foldWords(raw[0]))) { raw.shift(); continue; }
    const n = raw[0].match(NAME_PREFIX);
    if (n && !NOT_A_NAME.has(foldWords(n[1]))) raw[0] = raw[0].slice(n[0].length);
    break;
  }
  // A bare name under the answer, without a sign-off ("No\n\nAna").
  const name = (l: string) => l.trim().split(/\s+/).every((w) => /^\p{Lu}\p{Ll}+[.,]?$/u.test(w) && !NOT_A_NAME.has(foldWords(w))) && l.trim().split(/\s+/).length <= 2;
  if (raw.length >= 2 && name(raw[raw.length - 1])) raw.pop();
  const lines = raw.map(normalizeWords).filter(Boolean);
  for (;;) {
    const last = lines[lines.length - 1];
    if (last === undefined) break;
    if (SIGN_OFF.test(foldWords(last))) { lines.pop(); continue; }
    const prev = lines[lines.length - 2];
    if (prev !== undefined && SIGN_OFF.test(foldWords(prev)) && /^\p{L}+( \p{L}+){0,2}$/u.test(last)) { lines.splice(-2, 2); continue; }
    break;
  }
  if (lines.length) {
    let last = lines[lines.length - 1];
    while (TRAILING_SIGN_OFF.test(last)) last = last.replace(TRAILING_SIGN_OFF, "");
    lines[lines.length - 1] = last.trim();
    if (!lines[lines.length - 1]) lines.pop();
  }
  return lines;
}

/**
 * The words a person typed in this reply: the new text (newText), cut at a signature delimiter ("-- ") or a
 * "Sent from my ..." line, without a leading greeting or trailing sign-offs, normalized (normalizeWords). Pure.
 */
export const replyCore = (text: string) => replyLines(text).join(" ").trim();

/** A bare "no" (or "no thanks"): what our emails ask a person to reply when they want no further contact. */
export const bareNo = (text: string) => ["no", "nope", "no thanks", "no thank you"].includes(replyCore(text));

export type ReplyRule = { intent: "auto_reply" | "uncertain"; opt_out: "none" | "uncertain" };

/**
 * What the rules alone can say about a reply. A possible opt-out is "uncertain" and goes to a person; everything else is
 * "uncertain" intent for the model or a person to decide. `auto` is the Auto-Submitted/Precedence verdict from headers.
 * Scope: messages whose headers already declare them automated never become replies (lib/team/classify.ts threadOutcome),
 * so they are not labeled; `auto` here catches a reply whose headers say so only when it reached this point otherwise.
 * A bare "no" is a possible opt-out too: our emails end "Reply "no" and I won't contact you again" (VIB-521).
 */
export function replyRule(text: string, auto: boolean): ReplyRule {
  const fresh = newText(text);
  const optOut = (OPT_OUT.test(fresh) && !NEGATED.test(fresh)) || bareNo(text);
  if (auto && !optOut) return { intent: "auto_reply", opt_out: "none" };
  return { intent: "uncertain", opt_out: optOut ? "uncertain" : "none" };
}
