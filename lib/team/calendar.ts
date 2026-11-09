// Meetings from Google Calendar (VIB-518): the pipeline's meeting source since John moved from Granola to Wispr Flow
// (Wispr Flow has no server API). A member connects their own calendar with read-only consent (/pipeline/meetings); the
// hourly pipeline cron reads it and writes one Twenty `meeting` row per meeting with someone the CRM knows, under the same
// rules as the Granola meeting ledger (vibrana-crm qualification/meeting_ledger.py, hub gtm/strategy/pipeline-metrics.md).
//
// What is read, and what is kept:
// - Events are listed with a Google `fields` mask: id, status, type, visibility, start, and attendees (address, display
//   name, self, resource, response). Titles, descriptions, locations and conference links are never fetched.
// - Display names are used in memory only, for the NDA deny-list; nothing about an attendee is stored but the CRM ids
//   their address matched.
// - The meeting map (gtm_calendar_meetings) keeps a keyed hash of the event id, the Twenty row id, the start and the kind.
//
// Which events become a meeting:
// - skipped: cancelled, not a plain event (focus time, out of office, working location), all-day, marked Private or
//   Confidential in Google Calendar, declined by the member, no outside attendee (team domains, team addresses,
//   calendar resources and no-reply removed), more than MAX_EXTERNAL outside guests (a webinar, not a meeting), or any
//   attendee or matched company on the NDA deny-list (MEETING_DENY_LIST; without it nothing is written: fail closed);
// - otherwise an outside attendee must match exactly one CRM person (primary or additional email), or their address's
//   domain exactly one CRM company. The strongest match sets the kind, in the ledger's order: a won deal at the company,
//   or a client or former client -> CLIENT; an open deal or an eligible prospect -> DISCOVERY; a partner contact ->
//   PARTNER; else OTHER. A suppressed person is never linked.
// - The row's name is composed, "<date> meeting: <CRM company, else CRM person>", never calendar text.
//
// Rows and people's word:
// - A meeting already in Twenty for the same owner within 3 hours, at the same company or person (a Granola or
//   hand-made row), is adopted: linked, never edited or deleted by this sync.
// - A row this sync created follows the event: time and name always; kind and links unless a person changed the kind
//   (Kind source Manual, or a kind different from the automatic one).
// - When the event is cancelled, declined, made private, or stops matching the CRM, a row the sync created is deleted
//   (Twenty's soft delete, restorable), unless a person changed its kind; then it is kept and left alone. A row a person
//   deleted is never recreated. More than BREAKER_MIN removals that are also more than BREAKER_SHARE of the member's live
//   rows hold every removal for review instead.
// - One meeting on two members' calendars is written once, for the member whose sync saw it first.
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertLiveProvidersAllowed, providerFetch } from "../demo-safety";
import { must } from "../db";
import { demoMode } from "../demo";
import type { TwentyReader } from "../twenty";
import { domainOf, FREEMAIL } from "./classify";
import { eventKey, openToken } from "./crypto";
import { accessToken, gmailConfig, ignoredDomains, ReconnectError, selectAll, type GmailConfig } from "./mailbox";
import { teamMembers } from "./members";

export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
export const calendarScopes = () => ["openid", "email", CALENDAR_SCOPE];
export const calendarAad = (member: string, address: string) => `calendar:${member}:${address.toLowerCase()}`;
/** The team's own domains (the same list as vibrana-crm google_meta.TEAM_DOMAINS): never an outside attendee. */
export const TEAM_DOMAINS = ["vibrana.ai", "vibranahq.com", "john-ellison.com"];
export const MAX_EXTERNAL = 15;
export const LOOKBACK_DAYS = 60;
export const LOOKAHEAD_DAYS = 21;
export const ADOPT_WINDOW_MS = 3 * 3_600_000;
export const BREAKER_MIN = 5;
export const BREAKER_SHARE = 0.3;
const DAY = 86_400_000;
const NOT_PEOPLE = /@(resource|group)\.calendar\.google\.com$|@group\.v\.calendar\.google\.com$|^(no-?reply|do-?not-?reply|notifications?|calendar-notification)[+@.\-_]/;
const OPEN_STAGES = ["IDENTIFIED", "CONTACTED", "QUALIFIED", "PROPOSAL"];
const PROSPECT_QUEUES = ["BUYER_CHAMPION", "HIGH_POTENTIAL"];
const PROSPECT_REVIEW = ["PENDING", "APPROVED", "WARM_INTRO"];
const RANK = { CLIENT: 0, DISCOVERY: 1, PARTNER: 2, OTHER: 3 } as const;
export type Kind = keyof typeof RANK;
/** The ledger's name for a withdrawn row; never adopted. */
const RETRACTED = "Retracted meeting";

/* ------------------------------------------------------------------------------------------------ consent */

/** Trades the consent code for tokens. The address comes from the id_token on this direct TLS call; the calendar scope must
 *  be in what Google granted, not just in what was asked. */
export async function exchangeCalendarCode(cfg: GmailConfig, code: string, verifier: string, redirectUri: string, fetcher: typeof fetch = fetch) {
  assertLiveProvidersAllowed();
  const res = await providerFetch(fetcher)("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, cache: "no-store", signal: AbortSignal.timeout(15_000),
    body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, code, code_verifier: verifier, redirect_uri: redirectUri, grant_type: "authorization_code" }),
  });
  const body = await res.json().catch(() => ({})) as { refresh_token?: string; id_token?: string; scope?: string };
  if (!res.ok || !body.refresh_token || !body.id_token) throw new Error("Google did not grant offline access. Try connecting again.");
  const claims = JSON.parse(Buffer.from(body.id_token.split(".")[1] ?? "", "base64url").toString("utf8")) as { email?: string; email_verified?: boolean };
  if (!claims.email || claims.email_verified === false) throw new Error("Google did not confirm the calendar's address.");
  if (!(body.scope ?? "").split(" ").includes(CALENDAR_SCOPE)) throw Object.assign(new Error("The read-only calendar permission was not granted."), { scopeMissing: true });
  return { refreshToken: body.refresh_token, email: claims.email.toLowerCase(), grantedScopes: [CALENDAR_SCOPE] };
}

/* ------------------------------------------------------------------------------------------------ deny-list */

export type DenyList = { domains: string[]; organizations: string[] };

/** MEETING_DENY_LIST, the NDA deny-list (the same JSON as meeting capture's index/deny.json). Null when unset or malformed:
 *  the sync then writes nothing. An intentionally empty list is `{"domains":[],"organizations":[]}`. */
export function denyList(env: Record<string, string | undefined> = process.env): DenyList | null {
  const raw = env.MEETING_DENY_LIST?.trim();
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as { domains?: unknown; organizations?: unknown };
    if (!d || typeof d !== "object" || !Array.isArray(d.domains ?? []) || !Array.isArray(d.organizations ?? [])) return null;
    return {
      domains: ((d.domains ?? []) as unknown[]).map((x) => String(x).trim().toLowerCase().replace(/^@/, "")).filter(Boolean),
      organizations: ((d.organizations ?? []) as unknown[]).map((x) => String(x).trim()).filter(Boolean),
    };
  } catch { return null; }
}

const onDomain = (domain: string, list: string[]) => list.some((d) => domain === d || domain.endsWith(`.${d}`));
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function orgHit(hay: string, organizations: string[]) {
  const text = hay.toLowerCase();
  return organizations.some((org) => {
    const words = org.toLowerCase().split(/\W+/).filter(Boolean);
    return words.length > 0 && new RegExp(`(?<![a-z0-9])${words.map(escape).join("[\\s\\-_.]*")}(?![a-z0-9])`).test(text);
  });
}

/** True when an attendee's domain is denied, or a denied organization appears in an attendee's name or domain labels. */
export function eventDenied(addresses: string[], names: string[], deny: DenyList): boolean {
  if (addresses.some((a) => onDomain(domainOf(a), deny.domains))) return true;
  return orgHit([...names, ...addresses.map((a) => domainOf(a).replace(/[.-]/g, " "))].join(" "), deny.organizations);
}

/** True when a matched CRM company is on the deny-list, by name or by website domain. */
export function companyDenied(company: { name?: string | null; domain?: string | null } | null, deny: DenyList): boolean {
  if (!company) return false;
  if (company.domain && onDomain(company.domain, deny.domains)) return true;
  return !!company.name && orgHit(company.name, deny.organizations);
}

/* ------------------------------------------------------------------------------------------------ events */

export type GEvent = {
  id: string; status?: string; eventType?: string; visibility?: string;
  start?: { dateTime?: string; date?: string };
  attendees?: { email?: string; displayName?: string; self?: boolean; resource?: boolean; responseStatus?: string }[];
};
export const EVENT_FIELDS = "nextPageToken,items(id,status,eventType,visibility,start,attendees(email,displayName,self,resource,responseStatus))";

export type Candidate = { id: string; start: string; day: string; externals: string[]; names: string[] };
export type Sorted = { live: Candidate[]; gone: { id: string; why: string }[] };

/** Pure: which events may be a meeting (live) and which must not have a row (gone, with the reason). `self` is the
 *  calendar's own address; `team` holds every team address; `ignored` the extra domains (TEAM_IGNORE_DOMAINS). */
export function sortEvents(items: GEvent[], self: string, team: string[], ignored: string[]): Sorted {
  const out: Sorted = { live: [], gone: [] };
  self = self.toLowerCase();
  const teamSet = new Set([self, ...team].map((a) => a.toLowerCase()));
  const domains = [...TEAM_DOMAINS, ...ignored, domainOf(self)];
  for (const e of items) {
    if (!e?.id) continue;
    const gone = (why: string) => out.gone.push({ id: e.id, why });
    if (e.status === "cancelled") { gone("cancelled"); continue; }
    if (e.eventType && e.eventType !== "default") { gone("not_a_meeting"); continue; }
    if (e.visibility === "private" || e.visibility === "confidential") { gone("private"); continue; }
    const dt = e.start?.dateTime;
    if (!dt || Number.isNaN(Date.parse(dt))) { gone("all_day"); continue; }
    const attendees = e.attendees ?? [];
    if (attendees.some((a) => (a.self || (a.email ?? "").toLowerCase() === self) && a.responseStatus === "declined")) { gone("declined"); continue; }
    const external = attendees.filter((a) => {
      const email = (a.email ?? "").trim().toLowerCase();
      return email.includes("@") && !a.self && !a.resource && !teamSet.has(email) && !NOT_PEOPLE.test(email) && !onDomain(domainOf(email), domains);
    });
    if (!external.length) { gone("internal"); continue; }
    if (external.length > MAX_EXTERNAL) { gone("large_event"); continue; }
    out.live.push({
      id: e.id, start: new Date(dt).toISOString(), day: dt.slice(0, 10),
      externals: [...new Set(external.map((a) => a.email!.trim().toLowerCase()))],
      names: external.map((a) => a.displayName ?? "").filter(Boolean),
    });
  }
  return out;
}

/** Every event in the window, page by page; throws rather than return part of a listing. */
export async function listEvents(token: string, timeMin: string, timeMax: string, fetcher: typeof fetch = fetch, deadline?: number): Promise<GEvent[]> {
  const out: GEvent[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 40; page++) {
    const p = new URLSearchParams({ timeMin, timeMax, singleEvents: "true", showDeleted: "true", maxResults: "250", fields: EVENT_FIELDS });
    if (pageToken) p.set("pageToken", pageToken);
    const res = await providerFetch(fetcher)(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${p}`, {
      headers: { Authorization: `Bearer ${token}` }, cache: "no-store",
      signal: AbortSignal.timeout(deadline != null ? Math.max(1_000, Math.min(15_000, deadline - Date.now())) : 15_000),
    });
    if (res.status === 401) throw new ReconnectError("Google no longer accepts the stored calendar connection. Reconnect the calendar.");
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: { message?: string } };
      throw new Error(`Google Calendar ${res.status}${body.error?.message ? `: ${body.error.message.slice(0, 160)}` : ""}`);
    }
    const body = await res.json() as { items?: GEvent[]; nextPageToken?: string };
    out.push(...(body.items ?? []));
    if (!body.nextPageToken) return out;
    pageToken = body.nextPageToken;
  }
  throw new Error("Google Calendar: more than 40 pages of events; refusing to return a partial listing");
}

/* ------------------------------------------------------------------------------------------------ kind */

export type CrmPerson = {
  id: string; name?: { firstName?: string | null; lastName?: string | null } | null;
  emails?: { primaryEmail?: string | null; additionalEmails?: string[] | null } | null;
  companyId?: string | null; company?: { id?: string | null; name?: string | null; domainName?: { primaryLinkUrl?: string | null } | null } | null;
  gtmEligibility?: string | null; gtmMarketingConsent?: string | null; gtmQueue?: string | null; gtmPriority?: string | null;
  gtmRelationship?: string | null; prospectReviewState?: string | null;
};
export type CrmCompany = { id: string; name?: string | null; domainName?: { primaryLinkUrl?: string | null } | null };
export type CrmOpp = { id: string; stage?: string | null; companyId?: string | null };
export type Choice = { person: CrmPerson | null; company: { id: string; name: string | null; domain: string | null } | null; deal: CrmOpp | null; kind: Kind };

export const PERSON_FIELDS = "id name { firstName lastName } emails { primaryEmail additionalEmails } companyId company { id name domainName { primaryLinkUrl } } " +
  "gtmEligibility gtmMarketingConsent gtmQueue gtmPriority gtmRelationship prospectReviewState";

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
const normRel = (v: string | null | undefined) => (typeof v === "string" ? v.trim().replace(/[\s-]+/g, "_").toUpperCase() : null);
export const hostOf = (url: string | null | undefined) => norm(url).replace(/^[a-z]+:\/\//, "").split("/")[0].replace(/^www\./, "") || null;
export const personEmails = (p: CrmPerson) => new Set([p.emails?.primaryEmail, ...(p.emails?.additionalEmails ?? [])].map(norm).filter(Boolean));
/** vibrana-crm crm.protected: no automated process may select this person. */
export const protectedPerson = (p: CrmPerson) => p.gtmEligibility === "SUPPRESSED" || p.gtmEligibility === "INVALID" ||
  p.gtmMarketingConsent === "UNSUBSCRIBED" || p.gtmQueue === "SUPPRESSED" || p.gtmPriority === "SUPPRESSED";
/** The privacy test for linking a person to a meeting (meeting_ledger.suppressed): their queue is SUPPRESSED. */
export const suppressed = (p: CrmPerson) => p.gtmQueue === "SUPPRESSED";
const eligibleProspect = (p: CrmPerson) => !protectedPerson(p) && (PROSPECT_QUEUES.includes(p.gtmQueue ?? "") || PROSPECT_REVIEW.includes(p.prospectReviewState ?? ""));

/** Pure: meeting_ledger.kind for one matched attendee (their own record, or none) and the deals at their company. */
export function kindOf(people: CrmPerson[], opps: CrmOpp[]): Kind {
  if (opps.some((o) => o.stage === "SIGNED") || people.some((p) => ["CLIENT", "FORMER_CLIENT"].includes(normRel(p.gtmRelationship) ?? ""))) return "CLIENT";
  if (opps.some((o) => OPEN_STAGES.includes(o.stage ?? "")) || people.some(eligibleProspect)) return "DISCOVERY";
  if (people.some((p) => p.gtmQueue === "PARTNER" || p.prospectReviewState === "PARTNER_CANDIDATE")) return "PARTNER";
  return "OTHER";
}

/** The open deal furthest along at the company, else its won one. */
export function dealAt(companyId: string | null | undefined, opps: CrmOpp[]): CrmOpp | null {
  if (!companyId) return null;
  const at = opps.filter((o) => o.companyId === companyId);
  const open = at.filter((o) => OPEN_STAGES.includes(o.stage ?? "")).sort((a, b) => OPEN_STAGES.indexOf(b.stage!) - OPEN_STAGES.indexOf(a.stage!) || a.id.localeCompare(b.id));
  const won = at.filter((o) => o.stage === "SIGNED").sort((a, b) => a.id.localeCompare(b.id));
  return open[0] ?? won[0] ?? null;
}

/** Pure: the attendee the row is written for, or null when none matched. Address order; the strongest kind wins, ties to
 *  the earlier address. A person matched by more than one CRM row, or a domain owned by more than one company, is skipped. */
export function choose(externals: string[], byEmail: Map<string, CrmPerson[]>, byDomain: Map<string, CrmCompany[]>, opps: CrmOpp[]): Choice | null {
  let best: (Choice & { rank: [number, number] }) | null = null;
  externals.forEach((email, i) => {
    const people = byEmail.get(email) ?? [];
    let cand: Choice | null = null;
    if (people.length === 1) {
      const p = people[0];
      const coId = p.company?.id ?? p.companyId ?? null;
      const co = coId ? { id: coId, name: p.company?.name ?? null, domain: hostOf(p.company?.domainName?.primaryLinkUrl) } : null;
      const link = suppressed(p) ? null : p;
      if (!link && !co) return;
      cand = { person: link, company: co, deal: dealAt(co?.id, opps), kind: kindOf([p], opps.filter((o) => co && o.companyId === co.id)) };
    } else if (people.length === 0) {
      const companies = byDomain.get(domainOf(email)) ?? [];
      if (companies.length !== 1) return;
      const c = companies[0];
      const co = { id: c.id, name: c.name ?? null, domain: hostOf(c.domainName?.primaryLinkUrl) };
      cand = { person: null, company: co, deal: dealAt(co.id, opps), kind: kindOf([], opps.filter((o) => o.companyId === co.id)) };
    } else return;
    const rank: [number, number] = [RANK[cand.kind], i];
    if (!best || rank[0] < best.rank[0] || (rank[0] === best.rank[0] && rank[1] < best.rank[1])) best = { ...cand, rank };
  });
  if (!best) return null;
  const { rank: _rank, ...choice } = best as Choice & { rank: [number, number] };
  return choice;
}

export const personName = (p: CrmPerson | null) => [p?.name?.firstName, p?.name?.lastName].map((x) => (x ?? "").trim()).filter(Boolean).join(" ");
export function composeName(day: string, choice: Choice): string {
  const label = (choice.company?.name || personName(choice.person)).replace(/\s+/g, " ").trim().slice(0, 120);
  return label ? `${day} meeting: ${label}` : `${day} meeting`;
}

/* ------------------------------------------------------------------------------------------------ CRM reads */

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** CRM people owning each address (primary or additional), exact after a narrow server-side filter. */
export async function peopleByEmail(reader: TwentyReader, emails: string[]): Promise<Map<string, CrmPerson[]>> {
  const out = new Map<string, CrmPerson[]>(emails.map((e) => [e, []]));
  for (let i = 0; i < emails.length; i += 15) {
    const batch = emails.slice(i, i + 15);
    const or = batch.flatMap((e) => [{ emails: { primaryEmail: { ilike: likeEscape(e) } } }, { emails: { additionalEmails: { like: `%"${likeEscape(e)}"%` } } }]);
    const rows = await reader.all<CrmPerson>("people", PERSON_FIELDS, { or }, "PersonFilterInput", 100, 500);
    for (const p of rows) for (const e of personEmails(p)) if (out.has(e) && !out.get(e)!.some((x) => x.id === p.id)) out.get(e)!.push(p);
  }
  return out;
}

/** CRM companies whose website is exactly each (non-freemail) domain. */
export async function companiesByDomain(reader: TwentyReader, domains: string[]): Promise<Map<string, CrmCompany[]>> {
  const wanted = domains.filter((d) => d && !FREEMAIL.has(d));
  const out = new Map<string, CrmCompany[]>(wanted.map((d) => [d, []]));
  for (let i = 0; i < wanted.length; i += 20) {
    const or = wanted.slice(i, i + 20).map((d) => ({ domainName: { primaryLinkUrl: { ilike: `%${likeEscape(d)}%` } } }));
    const rows = await reader.all<CrmCompany>("companies", "id name domainName { primaryLinkUrl }", { or }, "CompanyFilterInput", 100, 500);
    for (const c of rows) { const h = hostOf(c.domainName?.primaryLinkUrl); if (h && out.has(h)) out.get(h)!.push(c); }
  }
  return out;
}

/* ------------------------------------------------------------------------------------------------ rows */

export type MeetingRow = {
  id: string; name: string | null; mtgAt: string | null; mtgOwner: string | null; mtgKind: string | null; mtgKindSource: string | null;
  mtgAutoKind: string | null; mtgCompanyId: string | null; mtgPersonId: string | null; mtgOpportunityId: string | null;
  mtgExternalCount: number | null; mtgCaptureKey: string | null;
};
const ROW_FIELDS = "id name mtgAt mtgOwner mtgKind mtgKindSource mtgAutoKind mtgCompanyId mtgPersonId mtgOpportunityId mtgExternalCount mtgCaptureKey";
export const captureKey = (key: string) => `calendar:${key}`;
/** A person's word (meeting_ledger.is_manual): Kind source Manual, or a kind different from the automatic one. */
export const isManual = (r: MeetingRow) => r.mtgKindSource === "MANUAL" || (!!r.mtgAutoKind && r.mtgKind !== r.mtgAutoKind);

export type MapRow = { member: string; event_key: string; meeting_id: string; origin: "created" | "adopted"; start_at: string; kind: Kind; removed_at: string | null };

export type Want = { key: string; start: string; day: string; externals: number; choice: Choice };

/** Pure: the fields a row should hold for a wanted meeting. */
export function rowFields(w: Want, member: string) {
  return {
    name: composeName(w.day, w.choice), mtgAt: w.start, mtgOwner: member, mtgKind: w.choice.kind, mtgKindSource: "AUTO", mtgAutoKind: w.choice.kind,
    mtgCompanyId: w.choice.company?.id ?? null, mtgPersonId: w.choice.person?.id ?? null, mtgOpportunityId: w.choice.deal?.id ?? null,
    mtgExternalCount: w.externals, mtgCaptureKey: captureKey(w.key),
  };
}

/** Pure: what to change on a row this sync created. Time, name and count always; kind and links only without a person's word. */
export function rowChanges(row: MeetingRow, want: ReturnType<typeof rowFields>): Partial<ReturnType<typeof rowFields>> {
  const keys: (keyof typeof want)[] = isManual(row) ? ["name", "mtgAt", "mtgExternalCount"] : ["name", "mtgAt", "mtgExternalCount", "mtgKind", "mtgAutoKind", "mtgCompanyId", "mtgPersonId", "mtgOpportunityId"];
  const out: Partial<typeof want> = {};
  for (const k of keys) {
    const have = row[k as keyof MeetingRow];
    const same = k === "mtgAt" ? !!have && Date.parse(String(have)) === Date.parse(String(want[k])) : (have ?? null) === (want[k] ?? null);
    if (!same) (out as Record<string, unknown>)[k] = want[k];
  }
  return out;
}

/** Pure: an existing row for the same meeting (same owner, within ADOPT_WINDOW_MS, same company or person). */
export function adoptable(rows: MeetingRow[], member: string, w: Want, taken: Set<string>): MeetingRow | null {
  const t = Date.parse(w.start);
  const hits = rows.filter((r) => r.mtgOwner === member && r.name !== RETRACTED && !taken.has(r.id) && r.mtgAt && Math.abs(Date.parse(r.mtgAt) - t) <= ADOPT_WINDOW_MS &&
    ((w.choice.company && r.mtgCompanyId === w.choice.company.id) || (w.choice.person && r.mtgPersonId === w.choice.person.id)));
  return hits.sort((a, b) => Math.abs(Date.parse(a.mtgAt!) - t) - Math.abs(Date.parse(b.mtgAt!) - t))[0] ?? null;
}

/* ------------------------------------------------------------------------------------------------ sync */

export type CalendarResult = { events: number; business: number; created: number; updated: number; adopted: number; removed: number; kept: number; held?: number; error?: string };
export type CalendarRun = { skipped?: string; calendars?: Record<string, CalendarResult> };

type Connection = { member: string; address: string; token_ciphertext: string };

export async function syncCalendars(db: SupabaseClient, reader: TwentyReader, opts: { now?: Date; deadline?: number; fetcher?: typeof fetch } = {}): Promise<CalendarRun> {
  if (demoMode()) return { skipped: "demo mode" };
  const cfg = gmailConfig();
  if (!cfg) return { skipped: "TEAM_GMAIL_CLIENT_ID or TEAM_GMAIL_CLIENT_SECRET is not set" };
  const deny = denyList();
  if (!deny) return { skipped: "MEETING_DENY_LIST is not set or malformed: no meeting is written without the NDA deny-list" };
  const connections = must(await db.from("gtm_team_calendars").select("member,address,token_ciphertext").order("member"), "calendar connections") as Connection[];
  if (!connections.length) return { skipped: "no calendar connected" };
  const now = opts.now ?? new Date();
  const timeMin = new Date(now.getTime() - LOOKBACK_DAYS * DAY).toISOString(), timeMax = new Date(now.getTime() + LOOKAHEAD_DAYS * DAY).toISOString();
  const mailboxes = must(await db.from("gtm_team_mailboxes").select("address"), "team mailboxes") as { address: string }[];
  const team = [...new Set([...connections.map((c) => c.address), ...mailboxes.map((m) => m.address),
    ...teamMembers().flatMap((m) => [m.authEmail, ...m.mailboxes])].map((a) => a.toLowerCase()))];
  let opps: CrmOpp[] | null = null;
  const run: CalendarRun = { calendars: {} };
  for (const c of connections) {
    const label = `${c.member}:${c.address}`;
    const result: CalendarResult = { events: 0, business: 0, created: 0, updated: 0, adopted: 0, removed: 0, kept: 0 };
    let error: string | null = null;
    try {
      const token = await accessToken(cfg, openToken(c.token_ciphertext, calendarAad(c.member, c.address)), opts.fetcher ?? fetch);
      const items = await listEvents(token, timeMin, timeMax, opts.fetcher ?? fetch, opts.deadline);
      result.events = items.length;
      opps ??= await reader.all<CrmOpp>("opportunities", "id stage companyId", null, "OpportunityFilterInput", 100, 2_000);
      await syncOne(db, reader, c.member, c.address, items, { team, ignored: ignoredDomains(), deny, opps, timeMin, timeMax, now }, result);
    } catch (e) {
      error = (e as Error).message.slice(0, 500);
      result.error = error;
    }
    run.calendars![label] = result;
    must(await db.from("gtm_team_calendars").update({ last_sync_at: now.toISOString(), last_error: error, last_result: result }).eq("member", c.member).eq("address", c.address), "save calendar sync");
  }
  return run;
}

type Ctx = { team: string[]; ignored: string[]; deny: DenyList; opps: CrmOpp[]; timeMin: string; timeMax: string; now: Date };

async function syncOne(db: SupabaseClient, reader: TwentyReader, member: string, address: string, items: GEvent[], ctx: Ctx, result: CalendarResult) {
  const sorted = sortEvents(items, address, ctx.team, ctx.ignored);
  const gone = new Map(sorted.gone.map((g) => [eventKey(g.id), g.why]));
  const live = sorted.live.filter((e) => {
    if (!eventDenied(e.externals, e.names, ctx.deny)) return true;
    gone.set(eventKey(e.id), "deny_list");
    return false;
  });
  const emails = [...new Set(live.flatMap((e) => e.externals))];
  const byEmail = emails.length ? await peopleByEmail(reader, emails) : new Map<string, CrmPerson[]>();
  const domains = [...new Set(emails.filter((e) => !(byEmail.get(e) ?? []).length).map(domainOf))];
  const byDomain = domains.length ? await companiesByDomain(reader, domains) : new Map<string, CrmCompany[]>();
  const wants: Want[] = [];
  for (const e of live) {
    const key = eventKey(e.id);
    const choice = choose(e.externals, byEmail, byDomain, ctx.opps);
    if (!choice) { gone.set(key, "no_crm_match"); continue; }
    // A matched person whose company is on the deny-list excludes the meeting even from a personal address.
    const denied = [...e.externals.flatMap((x) => byEmail.get(x) ?? []).map((p) => p.company ? { name: p.company.name, domain: hostOf(p.company.domainName?.primaryLinkUrl) } : null), choice.company]
      .some((co) => companyDenied(co, ctx.deny));
    if (denied) { gone.set(key, "deny_list"); continue; }
    wants.push({ key, start: e.start, day: e.day, externals: e.externals.length, choice });
  }
  result.business = wants.length;

  const maps = await selectAll<MapRow>((from, to) => db.from("gtm_calendar_meetings").select("member,event_key,meeting_id,origin,start_at,kind,removed_at").order("event_key").range(from, to), "meeting map");
  const mine = new Map(maps.filter((m) => m.member === member).map((m) => [m.event_key, m]));
  const others = new Set(maps.filter((m) => m.member !== member && !m.removed_at).map((m) => m.event_key));
  const lo = new Date(Date.parse(ctx.timeMin) - DAY).toISOString(), hi = new Date(Date.parse(ctx.timeMax) + DAY).toISOString();
  const rows = await reader.all<MeetingRow>("meetings", ROW_FIELDS, { and: [{ mtgOwner: { eq: member } }, { mtgAt: { gte: lo } }, { mtgAt: { lte: hi } }] }, "MeetingFilterInput", 100, 2_000);
  const mappedIds = [...mine.values()].filter((m) => !m.removed_at).map((m) => m.meeting_id).filter((id) => !rows.some((r) => r.id === id));
  for (let i = 0; i < mappedIds.length; i += 50) rows.push(...await reader.all<MeetingRow>("meetings", ROW_FIELDS, { id: { in: mappedIds.slice(i, i + 50) } }, "MeetingFilterInput", 100, 100));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const taken = new Set(maps.filter((m) => !m.removed_at).map((m) => m.meeting_id));
  const stamp = ctx.now.toISOString();
  const save = async (m: Omit<MapRow, "removed_at"> & { removed_at?: string | null }) =>
    must(await db.from("gtm_calendar_meetings").upsert({ ...m, updated_at: stamp }, { onConflict: "member,event_key" }), "save meeting map");

  for (const w of wants) {
    const map = mine.get(w.key);
    if (map?.removed_at) continue;                       // final: a row a person deleted, or one withdrawn earlier
    if (!map && others.has(w.key)) continue;             // already counted for another member
    const want = rowFields(w, member);
    if (map) {
      const row = byId.get(map.meeting_id);
      if (!row) { await save({ ...map, removed_at: stamp }); continue; }   // a person deleted it: never recreated
      if (map.origin === "adopted") continue;
      const patch = rowChanges(row, want);
      if (Object.keys(patch).length) {
        await reader.read("mutation($id:UUID!,$d:MeetingUpdateInput!){ updateMeeting(id:$id, data:$d) { id } }", { id: row.id, d: patch });
        result.updated++;
      }
      if (map.start_at !== w.start || map.kind !== w.choice.kind) await save({ ...map, start_at: w.start, kind: w.choice.kind });
      continue;
    }
    // A row this sync created whose map write was lost: recover it by its capture key instead of creating a second one.
    const own = rows.find((r) => r.mtgCaptureKey === want.mtgCaptureKey);
    if (own) { await save({ member, event_key: w.key, meeting_id: own.id, origin: "created", start_at: w.start, kind: w.choice.kind }); taken.add(own.id); continue; }
    const existing = adoptable(rows, member, w, taken);
    if (existing) {
      await save({ member, event_key: w.key, meeting_id: existing.id, origin: "adopted", start_at: w.start, kind: w.choice.kind });
      taken.add(existing.id);
      result.adopted++;
      continue;
    }
    const made = await reader.read<{ createMeeting: { id: string } }>("mutation($d:MeetingCreateInput!){ createMeeting(data:$d) { id } }", { d: want });
    await save({ member, event_key: w.key, meeting_id: made.createMeeting.id, origin: "created", start_at: w.start, kind: w.choice.kind });
    taken.add(made.createMeeting.id);
    result.created++;
  }

  // Withdrawals: only rows this sync created, only for events seen and judged gone in this listing.
  const removals = [...mine.values()].filter((m) => !m.removed_at && m.origin === "created" && gone.has(m.event_key));
  const liveRows = [...mine.values()].filter((m) => !m.removed_at && m.origin === "created").length;
  if (removals.length > BREAKER_MIN && removals.length > BREAKER_SHARE * liveRows) {
    result.held = removals.length;
    result.error = `held ${removals.length} removals of ${liveRows} rows for review (breaker)`;
    return;
  }
  for (const m of removals) {
    const row = byId.get(m.meeting_id);
    if (row && isManual(row)) { result.kept++; await save({ ...m, removed_at: stamp }); continue; }
    if (row) await reader.read("mutation($id:UUID!){ deleteMeeting(id:$id) { id } }", { id: row.id });
    await save({ ...m, removed_at: stamp });
    result.removed++;
  }
}
