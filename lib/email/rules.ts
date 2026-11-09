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
    // The framed line itself stays: its words may be the person's own ("----- Please remove me -----" right above quoted
    // mail, review of #34, round 5). A real separator carries no request; the outbound text (strictText) drops the line.
    if ((DASHED_WORDS.test(l) || OUTLOOK_RULE.test(l)) && lines.slice(i + 1, i + 3).some((x) => FROM_HEADER.test(x))) { out.push(l); break; }
    if (FROM_HEADER.test(l) && out.length > 0) break;
    out.push(l);
  }
  return out.join("\n").trim();
}

const OPT_OUT = /\b(unsubscribe( me)?|remove me|take me off|stop (emailing|e-mailing|contacting|sending)|do not (email|contact)|don'?t (email|contact) me|opt(ed)? out|no more emails)\b/i;
const NEGATED = /\b(don'?t|do not|please don'?t|no need to)\s+(unsubscribe|remove)\b/i;

export type ReplyRule = { intent: "auto_reply" | "uncertain"; opt_out: "none" | "uncertain" };

/**
 * What the rules alone can say about a reply. A possible opt-out is "uncertain" and goes to a person; everything else is
 * "uncertain" intent for the model or a person to decide. `auto` is the Auto-Submitted/Precedence verdict from headers.
 * Scope: messages whose headers already declare them automated never become replies (lib/team/classify.ts threadOutcome),
 * so they are not labeled; `auto` here catches a reply whose headers say so only when it reached this point otherwise.
 */
export function replyRule(text: string, auto: boolean): ReplyRule {
  const fresh = newText(text);
  const optOut = OPT_OUT.test(fresh) && !NEGATED.test(fresh);
  if (auto && !optOut) return { intent: "auto_reply", opt_out: "none" };
  return { intent: "uncertain", opt_out: optOut ? "uncertain" : "none" };
}
