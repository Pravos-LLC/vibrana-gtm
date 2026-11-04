import { demoMode } from "./demo";
// Twenty CRM funnel counts via GraphQL. One root resolver per request (Twenty rejects duplicates).
import { CAPTURE_OWNERS, emptyOwners, schemaMiss, toRun, type CaptureHealth, type CaptureOwner } from "./meeting-capture";

const BASE = process.env.TWENTY_BASE ?? "https://brand.example.com";

/** Carries the raw GraphQL errors so callers can tell a missing object from an outage. */
export class TwentyError extends Error {
  constructor(message: string, readonly errors: unknown) { super(message); }
}

async function gql<T>(query: string, timeoutMs = 15_000): Promise<T> {
  if (demoMode()) {
    if (/mutation/i.test(query)) throw new Error("Demo mode: provider mutations are disabled");
    throw new Error("Demo mode: CRM reads are unavailable; no request was sent");
  }
  const token = process.env.TWENTY_API_KEY;
  if (!token) throw new Error("TWENTY_API_KEY is not set");
  const res = await fetch(`${BASE}/graphql`, {
    signal: AbortSignal.timeout(timeoutMs),
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new TwentyError(`Twenty: ${JSON.stringify(json.errors ?? json).slice(0, 300)}`, json.errors);
  return json.data as T;
}

/**
 * Serial, paced Twenty reads for batch jobs (the team cron). Production Twenty is small: after the 2026-10-01 saturation
 * the CRM runbook (vibrana-crm docs/operations.md) asks for one reader at a time, a pause between reads and backoff on
 * 429 or 5xx. `gql()` above is a single request for page views; this wraps a variables-capable request in that discipline
 * and stops at a deadline rather than running into the function's time limit. GraphQL errors are not retried: they are
 * answers, not overload.
 */
export class TwentyReader {
  private chain: Promise<unknown> = Promise.resolve();
  private last = 0;
  readonly requests: { count: number } = { count: 0 };
  constructor(private opts: {
    pauseMs?: number; retries?: number; deadline?: number; timeoutMs?: number;
    fetcher?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => number;
  } = {}) {}

  /** Moves the stop time, e.g. to give each team member a fair share of a cron run. */
  setDeadline(deadline: number | undefined) { this.opts.deadline = deadline; }

  read<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const run = this.chain.then(() => this.send<T>(query, variables));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async send<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    if (demoMode()) throw new Error("Demo mode: CRM reads are unavailable; no request was sent");
    const token = process.env.TWENTY_API_KEY;
    if (!token) throw new Error("TWENTY_API_KEY is not set");
    const now = this.opts.now ?? Date.now, sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const pause = this.opts.pauseMs ?? 1500, retries = this.opts.retries ?? 4;
    for (let attempt = 0; ; attempt++) {
      const wait = this.last + pause - now();
      if (wait > 0) await sleep(wait);
      if (this.opts.deadline && now() > this.opts.deadline) throw new Error("Twenty read stopped at the run deadline");
      this.requests.count++;
      let status = 0, json: { data?: T; errors?: unknown } | null = null, failure = "";
      try {
        const res = await (this.opts.fetcher ?? fetch)(`${BASE}/graphql`, {
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20_000), method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ query, variables }),
        });
        status = res.status;
        json = await res.json().catch(() => null);
      } catch (e) { failure = (e as Error).message; }
      this.last = now();
      if (json?.errors) throw new TwentyError(`Twenty: ${JSON.stringify(json.errors).slice(0, 300)}`, json.errors);
      if (status >= 200 && status < 300 && json?.data) return json.data;
      const transient = !status || status === 429 || status >= 500;
      if (!transient || attempt >= retries) throw new Error(`Twenty read failed (${status || failure || "no response"})`);
      await sleep(Math.min(30_000, 2_000 * 2 ** attempt));
    }
  }

  /**
   * Every node of a connection, page by page (`first` up to 100), following the cursor. Twenty's cursor under a
   * createdAt sort hands back the boundary row again on the next page (measured on production 2026-11-04: one extra row
   * per page), so `id` is always selected and every row is kept once.
   */
  async all<N>(object: string, fields: string, filter: Record<string, unknown> | null, filterType: string, pageSize = 100, max = 5_000): Promise<N[]> {
    const out: N[] = [];
    const seen = new Set<string>();
    const select = /(^|\s)id(\s|$)/.test(fields) ? fields : `id ${fields}`;
    let after: string | null = null;
    for (;;) {
      const q = `query($f:${filterType},$a:String){ ${object}(filter:$f, first:${pageSize}, after:$a, orderBy:[{createdAt:AscNullsFirst},{id:AscNullsFirst}]) { pageInfo { hasNextPage endCursor } edges { node { ${select} } } } }`;
      const d: Record<string, { pageInfo: { hasNextPage: boolean; endCursor: string | null }; edges: { node: N & { id: string } }[] }> =
        await this.read(q, { f: filter ?? {}, a: after });
      const c = d[object];
      let fresh = 0;
      for (const e of c.edges) if (!seen.has(e.node.id)) { seen.add(e.node.id); out.push(e.node); fresh++; }
      if (out.length >= max) throw new Error(`Twenty ${object}: more than ${max} rows; refusing to return a silently truncated list`);
      if (!c.pageInfo.hasNextPage || !c.pageInfo.endCursor || (!fresh && c.edges.length)) return out;
      after = c.pageInfo.endCursor;
    }
  }
}

async function countPeople(filter?: string): Promise<number> {
  const f = filter ? `(filter:${filter})` : "";
  const d = await gql<{ people: { totalCount: number } }>(`{ people${f} { totalCount } }`);
  return d.people.totalCount;
}

/** Each step is a real Twenty field; see the funnel page for definitions. */
export const FUNNEL_STEPS: Array<{ key: string; label: string; filter?: string }> = [
  { key: "people", label: "Contacts in CRM" },
  { key: "enrichment_attempted", label: "Enrichment attempted", filter: "{enrFullenrichResult:{is:NOT_NULL}}" },
  { key: "researched", label: "Researched", filter: "{gtmResearchStatus:{neq:NOT_RESEARCHED}}" },
  { key: "enriched", label: "Enriched", filter: "{enrStatus:{eq:ENRICHED}}" },
  { key: "identity_verified", label: "Identity verified", filter: "{gtmResearchStatus:{eq:VERIFIED}}" },
  { key: "eligible", label: "Eligible to contact", filter: "{gtmEligibility:{eq:ELIGIBLE}}" },
  { key: "offer_fit", label: "Offer fit", filter: "{gtmOfferFit:{in:[PROTOTYPE,WORKFLOW,BOTH]}}" },
  { key: "contacted", label: "Contacted", filter: "{lastContactedAt:{is:NOT_NULL}}" },
  { key: "warm", label: "Warm / hot", filter: "{warmth:{in:[HOT,WARM]}}" },
];

export async function crmSnapshot() {
  const metrics: Record<string, number> = {};
  for (const s of FUNNEL_STEPS) metrics[s.key] = await countPeople(s.filter);
  const c = await gql<{ companies: { totalCount: number } }>(`{ companies { totalCount } }`);
  metrics.companies = c.companies.totalCount;
  const m = await gql<{ messages: { totalCount: number } }>(`{ messages { totalCount } }`);
  metrics.email_messages_synced = m.messages.totalCount;
  const o = await gql<{ opportunities: { edges: Array<{ node: { stage: string } }> } }>(
    `{ opportunities(first: 200) { edges { node { stage } } } }`,
  );
  const stages: Record<string, number> = {};
  for (const e of o.opportunities.edges) stages[e.node.stage] = (stages[e.node.stage] ?? 0) + 1;
  return { metrics, opportunities: stages, meeting_capture: await captureHealth() };
}

export const RUN_FIELDS = ["mcrDay", "mcrOwner", "mcrMode", "mcrNotesSeen", "mcrCaptured", "mcrProposalsCreated", "mcrProposalsApplied",
  "mcrPendingOldestDays", "mcrLlmCalls", "mcrUsd", "mcrMonthUsd", "mcrMonthCapUsd", "mcrStaleOpen", "mcrStates", "mcrErrors",
  "mcrLastSuccessAt", "updatedAt"];

/** Every capture query, one root resolver each. Counts and heartbeat rows only: never Note bodies, never people. */
export const captureQueries = {
  pending: (o: CaptureOwner) => `{ meetingProposals(filter:{mpStatus:{eq:PENDING}, mpOwner:{eq:${o}}}) { totalCount } }`,
  /** Oldest by time in the queue (createdAt), so a backfill of old meetings does not read as a stale queue. */
  oldestPending: (o: CaptureOwner) =>
    `{ meetingProposals(filter:{mpStatus:{eq:PENDING}, mpOwner:{eq:${o}}}, orderBy:[{createdAt:AscNullsLast}], first:1) { edges { node { createdAt } } } }`,
  notes7d: (since: string) => `{ notes(filter:{title:{like:"[meeting-capture]%"}, createdAt:{gte:"${since}"}}) { totalCount } }`,
  latestRun: (o: CaptureOwner, fields: string[] = RUN_FIELDS) =>
    `{ meetingCaptureRuns(filter:{mcrOwner:{eq:${o}}}, orderBy:[{mcrDay:DescNullsLast},{updatedAt:DescNullsLast}], first:1) { edges { node { ${fields.join(" ")} } } } }`,
};

/**
 * Meeting capture health for the snapshot. Never throws. If Twenty does not know an object, or a field a query
 * filters or sorts on, that object is listed in `missing`; without `meetingCaptureRun` the block is
 * `installed: false`. A missing heartbeat field is dropped from the selection and listed in `missingFields`, so the
 * rest still shows. Anything else (an outage, an enum mismatch) lands in `error`, and the funnel snapshot still saves.
 */
/** `timeoutMs` per query: the daily sync keeps the default; the live /funnel read passes a short one (VIB-427). */
export async function captureHealth(now = new Date(), timeoutMs = 15_000): Promise<CaptureHealth> {
  const health: CaptureHealth = { installed: true, notes7d: null, owners: emptyOwners() };
  const missing = new Set<string>();
  const missingFields = new Set<string>();
  const errors: string[] = [];
  /** Runs one query; returns "missing" when Twenty lacks the object (or a filter/sort field), "fields" with names to drop. */
  const attempt = async <T>(object: string, q: string, use: (d: T) => void): Promise<string[] | null> => {
    try {
      use(await gql<T>(q, timeoutMs));
    } catch (e) {
      const miss = e instanceof TwentyError ? schemaMiss(e.errors) : null;
      if (miss?.objectMissing && object !== "note") missing.add(object);
      else if (miss && miss.fields.length && object !== "note") return miss.fields;
      else errors.push((e as Error).message);
    }
    return null;
  };
  const since = new Date(now.getTime() - 7 * 86400_000).toISOString();
  await attempt<{ notes: { totalCount: number } }>("note", captureQueries.notes7d(since), (d) => (health.notes7d = d.notes.totalCount));
  for (const o of CAPTURE_OWNERS) {
    if (missing.has("meetingProposal")) break;
    const own = health.owners[o];
    await attempt<{ meetingProposals: { totalCount: number } }>("meetingProposal", captureQueries.pending(o), (d) => (own.pending = d.meetingProposals.totalCount));
    if (missing.has("meetingProposal")) break;
    await attempt<{ meetingProposals: { edges: Array<{ node: { createdAt: string | null } }> } }>(
      "meetingProposal", captureQueries.oldestPending(o), (d) => {
        const t = Date.parse(d.meetingProposals.edges[0]?.node?.createdAt ?? "");
        own.oldestPendingDays = Number.isNaN(t) ? null : Math.max(0, Math.floor((now.getTime() - t) / 86400_000));
      });
  }
  let fields = RUN_FIELDS;
  for (const o of CAPTURE_OWNERS) {
    // A heartbeat field Twenty does not have yet is dropped and retried, never hiding the fields that do exist.
    for (let tries = 0; tries < 3 && !missing.has("meetingCaptureRun"); tries++) {
      const drop = await attempt<{ meetingCaptureRuns: { edges: Array<{ node: Record<string, unknown> }> } }>(
        "meetingCaptureRun", captureQueries.latestRun(o, fields), (d) => {
          const n = d.meetingCaptureRuns.edges[0]?.node;
          health.owners[o].run = n ? toRun(n) : null;
        });
      if (!drop) break;
      const unknown = drop.filter((f) => !fields.includes(f));
      for (const f of drop) missingFields.add(`meetingCaptureRun.${f}`);
      fields = fields.filter((f) => !drop.includes(f));
      if (unknown.length === drop.length) { errors.push(`Twenty rejected heartbeat fields ${drop.join(", ")}`); break; }
    }
  }
  if (missing.size) health.missing = [...missing];
  if (missing.has("meetingCaptureRun")) health.installed = false;
  if (missingFields.size) health.missingFields = [...missingFields];
  if (errors.length) health.error = errors.join("; ").slice(0, 500);
  return health;
}

/* ------------------------------------------------- people and deals for Today and the CRM page */
// Read live on each page view (owner-only pages). Names and photos are rendered, never stored or logged.
// A short timeout: a hung CRM must cost the page a few seconds, not the whole function budget.
export const PAGE_TIMEOUT = 5_000;

export type Contact = {
  id: string; name: string; jobTitle: string | null; avatar: string | null; company: string | null; domain: string | null;
  relationship: string | null; warmth: string | null; channel: string | null; lastExchangedAt: string | null; nextStep: string | null; url: string;
};
export type Deal = {
  id: string; name: string; stage: string; company: string | null; domain: string | null; amount: number | null; currency: string | null;
  contact: string | null; updatedAt: string | null; url: string;
};

const domainOf = (link?: string | null) => {
  if (!link) return null;
  try { return new URL(/^https?:\/\//.test(link) ? link : `https://${link}`).hostname.replace(/^www\./, ""); } catch { return null; }
};
/** Twenty seeds demo people with placeholder portraits from its docs site; those are not real photos. */
const realAvatar = (url?: string | null) => (url && !url.includes("twentyhq.github.io") ? url : null);
const fullName = (n?: { firstName?: string; lastName?: string } | null) => [n?.firstName, n?.lastName].filter(Boolean).join(" ").trim();

/** The people John has most recently exchanged messages with (gtmLastExchangedAt), newest first. */
export async function recentConversations(limit = 8): Promise<Contact[]> {
  type Node = {
    id: string; name: { firstName: string; lastName: string } | null; jobTitle: string | null; avatarUrl: string | null;
    gtmRelationship: string | null; warmth: string | null; lastChannel: string | null; gtmLastExchangedAt: string | null; gtmNextStep: string | null;
    company: { name: string | null; domainName: { primaryLinkUrl: string | null } | null } | null;
  };
  const d = await gql<{ people: { edges: { node: Node }[] } }>(
    `{ people(filter:{gtmLastExchangedAt:{is:NOT_NULL}, or:[{gtmPriority:{is:NULL}},{gtmPriority:{neq:SUPPRESSED}}]}, orderBy:[{gtmLastExchangedAt:DescNullsLast}], first:${Math.min(50, Math.max(1, limit))}) {
      edges { node { id name { firstName lastName } jobTitle avatarUrl gtmRelationship warmth lastChannel gtmLastExchangedAt gtmNextStep
        company { name domainName { primaryLinkUrl } } } } } }`,
    PAGE_TIMEOUT,
  );
  return d.people.edges.map(({ node: n }) => ({
    id: n.id, name: fullName(n.name) || "Unnamed", jobTitle: n.jobTitle || null, avatar: realAvatar(n.avatarUrl),
    company: n.company?.name || null, domain: domainOf(n.company?.domainName?.primaryLinkUrl),
    relationship: n.gtmRelationship, warmth: n.warmth, channel: n.lastChannel, lastExchangedAt: n.gtmLastExchangedAt,
    nextStep: n.gtmNextStep || null, url: `${BASE}/object/person/${n.id}`,
  }));
}

/** Every opportunity with its company and point of contact, most recently touched first. */
export async function opportunities(): Promise<Deal[]> {
  type Node = {
    id: string; name: string | null; stage: string; updatedAt: string | null;
    amount: { amountMicros: number | null; currencyCode: string | null } | null;
    company: { name: string | null; domainName: { primaryLinkUrl: string | null } | null } | null;
    pointOfContact: { name: { firstName: string; lastName: string } | null } | null;
  };
  const d = await gql<{ opportunities: { edges: { node: Node }[] } }>(
    `{ opportunities(first:200, orderBy:[{updatedAt:DescNullsLast}]) { edges { node { id name stage updatedAt amount { amountMicros currencyCode }
      company { name domainName { primaryLinkUrl } } pointOfContact { name { firstName lastName } } } } } }`,
    PAGE_TIMEOUT,
  );
  return d.opportunities.edges.map(({ node: n }) => ({
    id: n.id, name: n.name || n.company?.name || "Untitled", stage: n.stage, company: n.company?.name || null,
    domain: domainOf(n.company?.domainName?.primaryLinkUrl),
    amount: n.amount?.amountMicros != null ? n.amount.amountMicros / 1_000_000 : null, currency: n.amount?.currencyCode || null,
    contact: fullName(n.pointOfContact?.name) || null, updatedAt: n.updatedAt, url: `${BASE}/object/opportunity/${n.id}`,
  }));
}

/** Runs a CRM read for a page; a missing key or an outage becomes a message instead of a crash. */
export async function crmRead<T>(read: () => Promise<T>): Promise<{ data: T | null; error: string | null }> {
  if (!process.env.TWENTY_API_KEY) return { data: null, error: "Twenty is not connected (TWENTY_API_KEY is not set)." };
  try { return { data: await read(), error: null }; } catch (e) { return { data: null, error: `Twenty could not be read: ${(e as Error).message.slice(0, 160)}` }; }
}
