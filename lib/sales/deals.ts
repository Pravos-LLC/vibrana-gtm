// Opportunities for the pipeline dashboard, read live from Twenty with the pipeline fields (owner, source, partner, offer,
// economics, next step). Field contract: hub gtm/strategy/pipeline-metrics.md; the fields are created by vibrana-crm
// qualification/pipeline_schema.py. Until they exist, the read falls back to the standard fields and says so, so the page
// never breaks on a CRM that is a step behind. Demo mode returns synthetic deals: no request leaves the process.
import { demoMode } from "../demo";
import { schemaMiss } from "../meeting-capture";
import { afterArg, pages, TwentyError } from "../twenty";

export const OWNERS = ["JOHN", "ABE"] as const;
export type Owner = (typeof OWNERS)[number];
export const SOURCES = ["INBOUND_SITE", "ORGANIC_SOCIAL", "OUTBOUND_EMAIL", "LINKEDIN_OUTREACH", "NETWORK", "CLIENT_EXPANSION", "PARTNER"] as const;
export type Source = (typeof SOURCES)[number];
export const SOURCE_LABELS: Record<Source, string> = {
  INBOUND_SITE: "Inbound site", ORGANIC_SOCIAL: "Organic social", OUTBOUND_EMAIL: "Outbound email", LINKEDIN_OUTREACH: "LinkedIn outreach",
  NETWORK: "Network", CLIENT_EXPANSION: "Client expansion", PARTNER: "Partner",
};
export const OFFER_LABELS: Record<string, string> = {
  TRIAGE: "Workflow triage", BUILD_SPRINT: "Build sprint", MAINTENANCE: "Maintenance", RETAINER: "Retainer", READINESS: "Readiness",
  GOVERNANCE: "Governance", BRAIN: "Company brain", TRANSFORMATION: "Transformation", OTHER: "Other",
};
export const LOST_LABELS: Record<string, string> = {
  NO_BUDGET: "No budget", NO_DECISION: "No decision", TIMING: "Timing", CHOSE_OTHER: "Chose another", BAD_FIT: "Bad fit", WENT_QUIET: "Went quiet", OTHER: "Other",
};

export type Money = { amount: number; currency: string } | null;
export type SalesDeal = {
  id: string; name: string; stage: string; company: string | null; domain: string | null; contact: string | null;
  fee: Money; upside: Money; deliveryCost: Money; referralFee: Money;
  owner: Owner | null; source: Source | null; partner: string | null; offer: string | null; lostReason: string | null;
  nextStep: string | null; nextStepAt: string | null; closeDate: string | null; createdAt: string; updatedAt: string | null; url: string;
};
export type DealRead = { deals: SalesDeal[]; fields: "pipeline" | "standard"; sample: boolean };

const BASE = () => process.env.TWENTY_BASE ?? "https://brand.example.com";
const MONEY = "{ amountMicros currencyCode }";
const STANDARD = `id name stage closeDate createdAt updatedAt amount ${MONEY} company { name domainName { primaryLinkUrl } } pointOfContact { name { firstName lastName } }`;
const PIPELINE = `${STANDARD} oppOwner oppSource oppPartner oppOffer oppLostReason oppNextStep oppNextStepAt oppUpsideAmount ${MONEY} oppDeliveryCost ${MONEY} oppReferralFee ${MONEY}`;

type MoneyNode = { amountMicros: number | null; currencyCode: string | null } | null | undefined;
type Node = {
  id: string; name: string | null; stage: string; closeDate: string | null; createdAt: string; updatedAt: string | null; amount: MoneyNode;
  company: { name: string | null; domainName: { primaryLinkUrl: string | null } | null } | null;
  pointOfContact: { name: { firstName: string; lastName: string } | null } | null;
  oppOwner?: string | null; oppSource?: string | null; oppPartner?: string | null; oppOffer?: string | null; oppLostReason?: string | null;
  oppNextStep?: string | null; oppNextStepAt?: string | null; oppUpsideAmount?: MoneyNode; oppDeliveryCost?: MoneyNode; oppReferralFee?: MoneyNode;
};

/** A Twenty currency value; zero and empty amounts are "not set", since Twenty stores an unset currency as 0 or null. */
export const money = (m: MoneyNode): Money =>
  m && m.amountMicros != null && m.amountMicros > 0 && m.currencyCode ? { amount: m.amountMicros / 1_000_000, currency: m.currencyCode } : null;

const domainOf = (link?: string | null) => {
  if (!link) return null;
  try { return new URL(/^https?:\/\//.test(link) ? link : `https://${link}`).hostname.replace(/^www\./, ""); } catch { return null; }
};
const asOwner = (v: string | null | undefined): Owner | null => ((OWNERS as readonly string[]).includes(v ?? "") ? (v as Owner) : null);
const asSource = (v: string | null | undefined): Source | null => ((SOURCES as readonly string[]).includes(v ?? "") ? (v as Source) : null);

export function toDeal(n: Node, base = BASE()): SalesDeal {
  const contact = [n.pointOfContact?.name?.firstName, n.pointOfContact?.name?.lastName].filter(Boolean).join(" ").trim();
  return {
    id: n.id, name: n.name || n.company?.name || "Untitled", stage: n.stage, company: n.company?.name || null,
    domain: domainOf(n.company?.domainName?.primaryLinkUrl), contact: contact || null,
    fee: money(n.amount), upside: money(n.oppUpsideAmount), deliveryCost: money(n.oppDeliveryCost), referralFee: money(n.oppReferralFee),
    owner: asOwner(n.oppOwner), source: asSource(n.oppSource), partner: n.oppPartner || null, offer: n.oppOffer || null,
    lostReason: n.oppLostReason || null, nextStep: n.oppNextStep || null, nextStepAt: n.oppNextStepAt || null,
    closeDate: n.closeDate, createdAt: n.createdAt, updatedAt: n.updatedAt, url: `${base}/object/opportunity/${n.id}`,
  };
}

type Query = (query: string) => Promise<unknown>;

async function post(query: string, timeoutMs: number): Promise<unknown> {
  const token = process.env.TWENTY_API_KEY;
  if (!token) throw new Error("TWENTY_API_KEY is not set");
  const res = await fetch(`${BASE()}/graphql`, {
    method: "POST", signal: AbortSignal.timeout(timeoutMs),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ query }),
  });
  const json = await res.json().catch(() => ({})) as { data?: unknown; errors?: unknown };
  if (!res.ok || json.errors) throw new TwentyError(`Twenty: ${JSON.stringify(json.errors ?? json).slice(0, 300)}`, json.errors);
  return json.data;
}

/**
 * Every opportunity, newest change first. Tries the pipeline fields; when Twenty does not know one of them
 * yet, reads the standard fields instead and reports `fields: "standard"`.
 */
export async function salesDeals(opts: { timeoutMs?: number; query?: Query } = {}): Promise<DealRead> {
  if (demoMode() && !opts.query) return { deals: SAMPLE_DEALS, fields: "pipeline", sample: true };
  const run = opts.query ?? ((q: string) => post(q, opts.timeoutMs ?? 8_000));
  // Every opportunity, page by page: past one page this used to drop the rest without a word (VIB-516).
  const q = (fields: string) => (after: string | null) =>
    `{ opportunities(first:200${afterArg(after)}, orderBy:[{updatedAt:DescNullsLast},{id:AscNullsFirst}]) { pageInfo { hasNextPage endCursor } edges { node { ${fields} } } } }`;
  const read = async (fields: string) => (await pages<Node>("opportunities", q(fields), { run: async <T>(query: string) => (await run(query)) as T })).map((n) => toDeal(n));
  try {
    return { deals: await read(PIPELINE), fields: "pipeline", sample: false };
  } catch (e) {
    const miss = e instanceof TwentyError ? schemaMiss(e.errors) : null;
    if (!miss || miss.objectMissing || !miss.fields.length) throw e;
    return { deals: await read(STANDARD), fields: "standard", sample: false };
  }
}

/* ------------------------------------------------------------------ synthetic deals for demo mode and previews */
// Relative to now, so a preview or a test run any day sees the same shape of pipeline.
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString();
const sample = (d: Partial<SalesDeal> & Pick<SalesDeal, "id" | "name" | "stage">): SalesDeal => ({
  company: d.name.split(":")[0], domain: null, contact: null, fee: null, upside: null, deliveryCost: null, referralFee: null,
  owner: "JOHN", source: null, partner: null, offer: "BUILD_SPRINT", lostReason: null, nextStep: null, nextStepAt: null,
  closeDate: null, createdAt: day(-30), updatedAt: day(-1), url: "https://brand.example.com/object/opportunity/" + d.id, ...d,
});
export const SAMPLE_DEALS: SalesDeal[] = [
  sample({ id: "00000000-0000-4000-8000-0000000000a1", name: "Harbor Labs: build sprint", stage: "PROPOSAL", fee: { amount: 18_000, currency: "USD" },
    upside: { amount: 30_000, currency: "USD" }, source: "PARTNER", partner: "Sample partner", nextStep: "Partner signs the work order", nextStepAt: day(3) }),
  sample({ id: "00000000-0000-4000-8000-0000000000a2", name: "Northwind: workflow triage", stage: "QUALIFIED", fee: { amount: 3_000, currency: "USD" },
    owner: "ABE", source: "OUTBOUND_EMAIL", offer: "TRIAGE", nextStep: "Send triage scope", nextStepAt: day(-9) }),
  sample({ id: "00000000-0000-4000-8000-0000000000a3", name: "Fabrikam: maintenance", stage: "SIGNED", fee: { amount: 600, currency: "USD" },
    source: "CLIENT_EXPANSION", offer: "MAINTENANCE", closeDate: day(-1), createdAt: day(-2) }),
  sample({ id: "00000000-0000-4000-8000-0000000000a4", name: "Contoso: build sprint", stage: "SIGNED", fee: { amount: 16_000, currency: "USD" },
    deliveryCost: { amount: 3_000, currency: "USD" }, source: "NETWORK", closeDate: day(-20), createdAt: day(-60) }),
  sample({ id: "00000000-0000-4000-8000-0000000000a5", name: "Tailspin: transformation", stage: "LOST", fee: { amount: 30_000, currency: "EUR" },
    source: "ORGANIC_SOCIAL", offer: "TRANSFORMATION", lostReason: "TIMING", closeDate: day(-12), createdAt: day(-70) }),
  sample({ id: "00000000-0000-4000-8000-0000000000a6", name: "Litware: readiness", stage: "IDENTIFIED", owner: null, source: "INBOUND_SITE", offer: "READINESS" }),
];
