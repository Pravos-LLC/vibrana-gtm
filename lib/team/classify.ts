// Which of a member's sent emails count as GTM outreach, and which later messages are replies. Pure: the mailbox sync
// supplies the Gmail metadata and the CRM lookups; nothing here reads a network or stores an address.
//
// The rules (adversarial review, 2026-11-04):
// - Outreach is a sent email with a To or Cc recipient who is an eligible Twenty person, matched on the exact address.
//   Clients, former clients, personal contacts, partners and suppressed people are not outreach.
// - A send that matches a CRM company only by its domain is "other CRM mail", shown apart and never in the headline.
//   Freemail domains never match a company.
// - A reply is a later inbound message in the same thread from one of the outreach recipients, not auto-submitted.
//   A message from mailer-daemon or postmaster in the thread marks the send bounced.
import { addresses, automated, header, type MailMessage } from "../outreach/mailbox";

export type CrmPerson = { id: string; gtmRelationship: string | null; prospectReviewState: string | null; gtmQueue: string | null };
export type SendClass = { kind: "outreach"; personIds: string[]; recipients: string[] } | { kind: "other_crm"; companyIds: string[] } | null;

const NOT_OUTREACH_RELATIONSHIP = new Set(["CLIENT", "FORMER_CLIENT", "PERSONAL"]);
const NOT_OUTREACH_REVIEW = new Set(["PARTNER_CANDIDATE"]);
const NOT_OUTREACH_QUEUE = new Set(["PARTNER", "SUPPRESSED"]);

/** Webmail and consumer domains: a person there is matched only by exact address, never through a company domain. */
export const FREEMAIL = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "ymail.com",
  "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "pm.me", "gmx.com", "gmx.de", "gmx.net", "web.de", "mail.com",
  "zoho.com", "yandex.com", "yandex.ru", "qq.com", "163.com", "126.com", "fastmail.com", "hey.com", "tutanota.com", "duck.com"]);

export const eligibleForOutreach = (p: CrmPerson) =>
  !NOT_OUTREACH_RELATIONSHIP.has(p.gtmRelationship ?? "") && !NOT_OUTREACH_REVIEW.has(p.prospectReviewState ?? "") && !NOT_OUTREACH_QUEUE.has(p.gtmQueue ?? "");

export const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1).toLowerCase();

/** Every To and Cc recipient of a message who is not one of the member's own or ignored addresses. */
export function recipients(m: MailMessage, own: string[], ignoreDomains: string[] = []): string[] {
  const mine = new Set(own.map((a) => a.toLowerCase()));
  const skip = new Set([...ignoreDomains.map((d) => d.toLowerCase()), ...own.map(domainOf)]);
  return [...new Set([...addresses(header(m, "To")), ...addresses(header(m, "Cc"))])].filter((a) => !mine.has(a) && !skip.has(domainOf(a)));
}

/**
 * Classifies one sent message. `people` maps an exact address to its Twenty person (only addresses Twenty knows);
 * `companies` maps a non-freemail domain to the Twenty companies at it.
 */
export function classifySend(rcpts: string[], people: Map<string, CrmPerson>, companies: Map<string, string[]>): SendClass {
  const matched = rcpts.flatMap((a) => { const p = people.get(a); return p && eligibleForOutreach(p) ? [{ a, p }] : []; });
  if (matched.length) return { kind: "outreach", personIds: [...new Set(matched.map((m) => m.p.id))], recipients: matched.map((m) => m.a) };
  // A known person who is not outreach (a client, a partner) is not "other CRM mail" by domain either: it is simply not counted.
  if (rcpts.some((a) => people.has(a))) return null;
  const companyIds = [...new Set(rcpts.flatMap((a) => FREEMAIL.has(domainOf(a)) ? [] : companies.get(domainOf(a)) ?? []))];
  return companyIds.length ? { kind: "other_crm", companyIds } : null;
}

/** Auto-replies and list mail: Auto-Submitted (RFC 3834), Precedence bulk/junk/auto_reply/list, or X-Autoreply. Subjects are never read. */
export const autoMessage = (m: MailMessage) => automated(m) || /^(bulk|junk|auto_reply|list)$/i.test(header(m, "Precedence").trim()) || !!header(m, "X-Autoreply");

export type ThreadOutcome = { replies: { id: string; at: number }[]; bounce: { id: string; at: number } | null };

/**
 * After the first outreach send in a thread, which inbound messages are replies from its recipients. `isRecipient`
 * answers whether an address was an outreach recipient in this thread (the sync compares keyed hashes, never addresses).
 */
export function threadOutcome(messages: MailMessage[], firstSendAt: number, own: string[], isRecipient: (address: string) => boolean): ThreadOutcome {
  const mine = new Set(own.map((a) => a.toLowerCase()));
  const later = messages.filter((m) => Number(m.internalDate ?? 0) > firstSendAt && !m.labelIds?.includes("SENT")
    && !m.labelIds?.some((l) => l === "DRAFT" || l === "SPAM" || l === "TRASH"))
    .filter((m) => !addresses(header(m, "From")).some((a) => mine.has(a)));
  // From mailer-daemon or postmaster only: multipart/report alone also covers read receipts, which are not bounces.
  const failure = later.find((m) => /mailer-daemon|postmaster/i.test(header(m, "From")));
  const replies = later.filter((m) => !autoMessage(m) && !/mailer-daemon|postmaster/i.test(header(m, "From")) && addresses(header(m, "From")).some(isRecipient))
    .map((m) => ({ id: m.id, at: Number(m.internalDate) }));
  return { replies, bounce: failure ? { id: failure.id, at: Number(failure.internalDate) } : null };
}
