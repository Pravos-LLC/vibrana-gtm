// Which of a member's sent emails count as GTM outreach, per recipient, and which later messages are replies. Pure: the
// mailbox sync supplies the Gmail metadata and the CRM lookups; nothing here reads a network or stores an address.
//
// Email contract v1 (Linear VIB-496), on top of the adversarial review of 2026-11-04:
// - Each external recipient of a counted message is one attempt. Identity is an exact address match (primary or additional)
//   to exactly one Twenty person; an address two people share is "ambiguous" and attributed to nobody.
// - A matched person who is correspondence (client, former client, personal, partner) is not outreach and is not stored.
//   Any other matched person is a cold attempt, counted even when the address is unverified or the send broke policy:
//   the break is a policy flag, never a reason to hide the send. A domain-only match is "other CRM mail".
// - Verification is what Twenty said about this exact address. revEmailVerification describes the primary address only;
//   an additional address is unknown. No bounce and a reply never make anything verified.
// - A reply is a later inbound message in the same thread from one of the outreach recipients, not auto-submitted.
//   A message from mailer-daemon or postmaster is a failure report.
import { addresses, automated, header, type MailMessage } from "../outreach/mailbox";
import { emailRefusals, normAddress, UNREADABLE } from "./restrictions";

export type CrmPerson = {
  id: string; gtmRelationship: string | null; prospectReviewState: string | null; gtmQueue: string | null;
  gtmEligibility?: string | null; gtmMarketingConsent?: string | null; gtmPriority?: string | null; gtmOrigins?: string[] | null;
  prospectNotSendable?: string | null; revEmailVerification?: string | null;
  emails?: { primaryEmail?: string | null; additionalEmails?: unknown } | null; gtmEmailRestrictions?: unknown;
};
/** An exact address's owner in Twenty: one person, or several (ambiguous, attributed to nobody). */
export type PersonMatch = { person: CrmPerson } | { ambiguous: true };
export type Field = "to" | "cc" | "bcc";
export type Recipient = { address: string; field: Field };
export type Verification = "verified" | "unverified" | "invalid" | "unknown";
export type AttemptClass = {
  address: string; field: Field; match: "matched" | "ambiguous" | "unmatched"; personId: string | null;
  stream: "cold" | "other_crm" | "unknown"; verification: Verification; verificationBasis: "at_send" | "inferred" | "none"; policyFlags: string[];
};
export type MessageClass = { kind: "outreach" | "other_crm"; personIds: string[]; companyIds: string[]; attempts: AttemptClass[] } | null;

const CORRESPONDENCE_RELATIONSHIP = new Set(["CLIENT", "FORMER_CLIENT", "PERSONAL"]);
const CORRESPONDENCE_REVIEW = new Set(["PARTNER_CANDIDATE"]);
const CORRESPONDENCE_QUEUE = new Set(["PARTNER"]);
const NETWORK_ORIGINS = new Set(["LINKEDIN", "WHATSAPP", "GMAIL"]);

/** Webmail and consumer domains: a person there is matched only by exact address, never through a company domain. */
export const FREEMAIL = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "ymail.com",
  "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "pm.me", "gmx.com", "gmx.de", "gmx.net", "web.de", "mail.com",
  "zoho.com", "yandex.com", "yandex.ru", "qq.com", "163.com", "126.com", "fastmail.com", "hey.com", "tutanota.com", "duck.com"]);

/** Mail to this person is correspondence (a client, a former client, a personal contact, a partner), not outreach. */
export const isCorrespondence = (p: CrmPerson) =>
  CORRESPONDENCE_RELATIONSHIP.has(p.gtmRelationship ?? "") || CORRESPONDENCE_REVIEW.has(p.prospectReviewState ?? "") || CORRESPONDENCE_QUEUE.has(p.gtmQueue ?? "");

/** Kept for readers of the old rule: not correspondence and not suppressed. New code reads attempts and their flags. */
export const eligibleForOutreach = (p: CrmPerson) => !isCorrespondence(p) && p.gtmQueue !== "SUPPRESSED";

export const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1).toLowerCase();

/**
 * Policy the send broke, as Twenty records it now (the CRM's guard is the authority; the client-domain list is private and
 * not checked here). A flagged send is still counted.
 */
export function policyFlags(p: CrmPerson, address: string): string[] {
  const out: string[] = [];
  if (p.gtmEligibility === "SUPPRESSED" || p.gtmEligibility === "INVALID") out.push(`ELIGIBILITY_${p.gtmEligibility}`);
  if (p.gtmMarketingConsent === "UNSUBSCRIBED") out.push("UNSUBSCRIBED");
  if (p.gtmQueue === "SUPPRESSED") out.push("QUEUE_SUPPRESSED");
  if (p.gtmPriority === "SUPPRESSED") out.push("PRIORITY_SUPPRESSED");
  if (p.gtmQueue === "NETWORK" || (p.gtmOrigins ?? []).some((o) => NETWORK_ORIGINS.has(o))) out.push("NETWORK");
  if (p.prospectReviewState === "REJECTED") out.push("REVIEW_REJECTED");
  if (String(p.prospectNotSendable ?? "").trim()) out.push("NOT_SENDABLE");   // TEXT reason code: any nonempty value blocks
  const refused = emailRefusals(p, address);
  if (refused.includes(UNREADABLE)) out.push("RESTRICTIONS_UNREADABLE");
  else {
    if (refused.some((r) => r.startsWith("email_hold_"))) out.push("EMAIL_HOLD");
    if (refused.some((r) => r.startsWith("address_") && r !== "address_not_on_person")) out.push("ADDRESS_RESTRICTED");
  }
  return out;
}

/** Twenty's verdict for this exact address. `live` is a send read within a day of happening; older reads are inferred. */
export function verificationOf(p: CrmPerson, address: string, live: boolean): { verification: Verification; verificationBasis: "at_send" | "inferred" | "none" } {
  const v = { VERIFIED: "verified", UNVERIFIED: "unverified", INVALID: "invalid" }[p.revEmailVerification ?? ""] as Verification | undefined;
  if (!v || normAddress(p.emails?.primaryEmail) !== normAddress(address)) return { verification: "unknown", verificationBasis: "none" };
  return { verification: v, verificationBasis: live ? "at_send" : "inferred" };
}

/** Every To, Cc and Bcc recipient of a message who is not one of the member's own or ignored addresses. */
export function recipientsOf(m: MailMessage, own: string[], ignoreDomains: string[] = []): Recipient[] {
  const mine = new Set(own.map((a) => a.toLowerCase()));
  const skip = new Set([...ignoreDomains.map((d) => d.toLowerCase()), ...own.map(domainOf)]);
  const seen = new Set<string>(), out: Recipient[] = [];
  for (const field of ["to", "cc", "bcc"] as const) {
    for (const a of addresses(header(m, field === "to" ? "To" : field === "cc" ? "Cc" : "Bcc"))) {
      if (mine.has(a) || skip.has(domainOf(a)) || seen.has(a)) continue;
      seen.add(a); out.push({ address: a, field });
    }
  }
  return out;
}

/** Addresses only, for callers of the old shape. */
export const recipients = (m: MailMessage, own: string[], ignoreDomains: string[] = []) => recipientsOf(m, own, ignoreDomains).map((r) => r.address);

/**
 * Classifies one sent message into attempts. `people` maps an exact address to its Twenty owner(s); `companies` maps a
 * non-freemail domain to the Twenty companies at it. A message to a correspondence contact only is not counted.
 */
export function classifyMessage(rcpts: Recipient[], people: Map<string, PersonMatch>, companies: Map<string, string[]>, live = false): MessageClass {
  const attempts: AttemptClass[] = [];
  const companyIds = new Set<string>();
  let correspondence = false;
  for (const r of rcpts) {
    const m = people.get(r.address);
    const base = { address: r.address, field: r.field, verification: "unknown" as Verification, verificationBasis: "none" as const, policyFlags: [] as string[] };
    if (m && "ambiguous" in m) { attempts.push({ ...base, match: "ambiguous", personId: null, stream: "unknown" }); continue; }
    if (m) {
      if (isCorrespondence(m.person)) { correspondence = true; continue; }
      attempts.push({ ...base, ...verificationOf(m.person, r.address, live), match: "matched", personId: m.person.id, stream: "cold", policyFlags: policyFlags(m.person, r.address) });
      continue;
    }
    const at = FREEMAIL.has(domainOf(r.address)) ? [] : companies.get(domainOf(r.address)) ?? [];
    for (const c of at) companyIds.add(c);
    attempts.push({ ...base, match: "unmatched", personId: null, stream: at.length ? "other_crm" : "unknown" });
  }
  const cold = attempts.filter((a) => a.stream === "cold");
  if (cold.length) return { kind: "outreach", personIds: [...new Set(cold.map((a) => a.personId!))], companyIds: [...companyIds], attempts };
  // A known correspondence contact on the message: it is simply not counted, not "other CRM mail" by domain either.
  if (correspondence || !companyIds.size) return null;
  return { kind: "other_crm", personIds: [], companyIds: [...companyIds], attempts };
}

/** Auto-replies and list mail: Auto-Submitted (RFC 3834), Precedence bulk/junk/auto_reply/list, or X-Autoreply. Subjects are never read. */
export const autoMessage = (m: MailMessage) => automated(m) || /^(bulk|junk|auto_reply|list)$/i.test(header(m, "Precedence").trim()) || !!header(m, "X-Autoreply");

export const isFailureReport = (m: MailMessage) => /mailer-daemon|postmaster/i.test(header(m, "From"));

export type ThreadOutcome = { replies: { id: string; at: number; from: string }[]; bounce: { id: string; at: number } | null; failures: { id: string; at: number }[] };

/**
 * After the first outreach send in a thread, which inbound messages are replies from its recipients, and which are
 * failure reports. `isRecipient` answers whether an address was an outreach recipient in this thread (the sync compares
 * keyed hashes, never addresses); `from` is the matched sender, in memory only.
 */
export function threadOutcome(messages: MailMessage[], firstSendAt: number, own: string[], isRecipient: (address: string) => boolean): ThreadOutcome {
  const mine = new Set(own.map((a) => a.toLowerCase()));
  const later = messages.filter((m) => Number(m.internalDate ?? 0) > firstSendAt && !m.labelIds?.includes("SENT")
    && !m.labelIds?.some((l) => l === "DRAFT" || l === "SPAM" || l === "TRASH"))
    .filter((m) => !addresses(header(m, "From")).some((a) => mine.has(a)));
  // From mailer-daemon or postmaster only: multipart/report alone also covers read receipts, which are not bounces.
  const failures = later.filter(isFailureReport).map((m) => ({ id: m.id, at: Number(m.internalDate) }));
  const replies = later.filter((m) => !autoMessage(m) && !isFailureReport(m)).flatMap((m) => {
    const from = addresses(header(m, "From")).find(isRecipient);
    return from ? [{ id: m.id, at: Number(m.internalDate), from }] : [];
  });
  return { replies, bounce: failures[0] ?? null, failures };
}
