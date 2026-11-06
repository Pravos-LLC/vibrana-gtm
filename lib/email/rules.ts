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

const POLICY = /\b(spam|blocked|block list|blocklist|blacklist|reputation|policy|dmarc|dkim|spf|authenticat|rejected for security|not authorized to send|5\.7\.\d+)\b/i;

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

/** The new text of a reply: no quoted lines, nothing from an attribution line ("On ... wrote:") or a forwarded header on. */
export function newText(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const l of lines) {
    if (/^\s*>/.test(l)) continue;
    if (/^\s*On .{3,200}wrote:\s*$/i.test(l) || /^\s*-{2,}\s*(Original Message|Forwarded message)/i.test(l) || /^\s*From:\s.+$/i.test(l) && out.length > 0) break;
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
 */
export function replyRule(text: string, auto: boolean): ReplyRule {
  const fresh = newText(text);
  const optOut = OPT_OUT.test(fresh) && !NEGATED.test(fresh);
  if (auto && !optOut) return { intent: "auto_reply", opt_out: "none" };
  return { intent: "uncertain", opt_out: optOut ? "uncertain" : "none" };
}
