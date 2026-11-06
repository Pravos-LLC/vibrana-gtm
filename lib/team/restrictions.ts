// Exact-address email restrictions, read side (email contract v1, Linear VIB-496/VIB-497). The authority is vibrana-crm
// qualification/email_restrictions.py; this mirrors it for the cockpit and is held to the same synthetic cases
// (test/fixtures/email-contract-v1.json, a hash-pinned copy of the CRM's fixture).
//
// Twenty person field gtmEmailRestrictions (RAW_JSON, version 1): `addresses` blocks email to one exact address only;
// `holds` blocks cold email to the person while a possible opt-out is reviewed. A real person opt-out is
// gtmMarketingConsent=UNSUBSCRIBED, not this field. A present but unreadable value blocks every address (fail closed).
// Nothing here is a verification: no bounce observed and a human reply never write it.

export const RESTRICTIONS_FIELD = "gtmEmailRestrictions";
export const UNREADABLE = "email_restrictions_unreadable";

type Entry = { reason: string };
export type Restrictions = { ok: boolean; addresses: Map<string, Entry>; holds: Entry[] };
export type PersonEmails = { emails?: { primaryEmail?: string | null; additionalEmails?: unknown } | null; gtmEmailRestrictions?: unknown };

/** Trim and lower-case only, the CRM's rule. No dot or plus folding. */
export const normAddress = (a: unknown) => String(a ?? "").trim().toLowerCase();

export function personEmails(p: PersonEmails): string[] {
  const e = p.emails && typeof p.emails === "object" ? p.emails : {};
  const extra = Array.isArray(e.additionalEmails) ? e.additionalEmails : [];
  return [e.primaryEmail, ...extra].map(normAddress).filter(Boolean);
}

const hasReason = (v: unknown): v is Entry =>
  !!v && typeof v === "object" && typeof (v as Entry).reason === "string" && (v as Entry).reason.trim().length > 0;
const BAD: Restrictions = { ok: false, addresses: new Map(), holds: [] };

export function readRestrictions(p: PersonEmails): Restrictions {
  let raw = p.gtmEmailRestrictions;
  if (raw == null || raw === "" || (typeof raw === "object" && !Array.isArray(raw) && Object.keys(raw).length === 0)) {
    return { ok: true, addresses: new Map(), holds: [] };
  }
  if (typeof raw === "string") { try { raw = JSON.parse(raw); } catch { return BAD; } }
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || (raw as { version?: unknown }).version !== 1) return BAD;
  const { addresses = {}, holds = [] } = raw as { addresses?: unknown; holds?: unknown };
  if (!addresses || typeof addresses !== "object" || Array.isArray(addresses) || !Array.isArray(holds)) return BAD;
  const entries = Object.entries(addresses as Record<string, unknown>);
  if (!entries.every(([k, v]) => normAddress(k) && hasReason(v)) || !holds.every(hasReason)) return BAD;
  return { ok: true, addresses: new Map(entries.map(([k, v]) => [normAddress(k), v as Entry])), holds: holds as Entry[] };
}

/** Why email to `address` on this person is refused; [] when no email restriction applies. No address: any address
 *  restriction refuses with address_check_required, so a caller cannot skip naming the address it will use. */
export function emailRefusals(p: PersonEmails, address: string | null = null): string[] {
  const r = readRestrictions(p);
  if (!r.ok) return [UNREADABLE];
  const out: string[] = [];
  for (const h of r.holds) { const c = `email_hold_${h.reason.trim().toLowerCase()}`; if (!out.includes(c)) out.push(c); }
  const emails = personEmails(p);
  if (address == null) {
    if (r.addresses.size) out.push("address_check_required");
    else if (!emails.length) out.push("no_email_address");
    return out;
  }
  const a = normAddress(address);
  if (!emails.includes(a)) out.push("address_not_on_person");
  else if (r.addresses.has(a)) out.push(`address_${r.addresses.get(a)!.reason.trim().toLowerCase()}`);
  return out;
}

/** The primary address when nothing refuses it, else null. Never an additional address in its place. */
export function emailTarget(p: PersonEmails): { address: string | null; reasons: string[] } {
  const primary = normAddress(p.emails?.primaryEmail);
  if (!primary) return { address: null, reasons: ["no_primary_email"] };
  const reasons = emailRefusals(p, primary);
  return reasons.length ? { address: null, reasons } : { address: primary, reasons: [] };
}

/** The CRM's protected(): person-wide holds whose broader effects (capture, enrichment) this project leaves unchanged. */
export const protectedPerson = (p: { gtmEligibility?: string | null; gtmMarketingConsent?: string | null; gtmQueue?: string | null; gtmPriority?: string | null }) =>
  p.gtmEligibility === "SUPPRESSED" || p.gtmEligibility === "INVALID" || p.gtmMarketingConsent === "UNSUBSCRIBED" || p.gtmQueue === "SUPPRESSED" || p.gtmPriority === "SUPPRESSED";
