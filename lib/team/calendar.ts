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
// Rows, people's word and privacy (review of #39):
// - Rows are created with an id derived from the event (rowId), so a retried create, an overlapping run or a lost map
//   write can never make a second row; an id already in Twenty's trash means a person deleted it, and it is not recreated.
// - A meeting already in Twenty for the same owner within 3 hours, at the same company or person (a Granola or
//   hand-made row), is adopted: linked, and never edited or deleted except for a privacy reason.
// - A row this sync created follows the event: time, date and count always; kind, links and the name's label unless a
//   person changed the kind (Kind source Manual, or a kind different from the automatic one).
// - Privacy reasons (the event marked Private, the NDA deny-list, a matched person whose queue is SUPPRESSED) withdraw the
//   row whoever made it and whatever its kind: its fields are stripped ("Retracted meeting", no links, time or count) and
//   it goes to Twenty's trash. They are final for every member: the map keeps a `withheld` row, so another member's copy
//   of the invite is never written either. A matched person who is otherwise protected (unsubscribed, invalid) holds the
//   meeting: no row is created, none is removed.
// - Other reasons (cancelled, declined, no longer matching the CRM, gone from the listing) trash a row the sync created,
//   unless a person changed its kind (then it is kept and no longer managed). They pass a breaker (the ledger's: more than
//   3, or at least 2 and more than 20% of the member's live rows, in one run) that holds them until an owner applies the
//   held removals on Pipeline > Meetings.
// - Once a day a sweep re-checks every meeting row the member owns, of any age and whoever wrote it: a linked company on
//   the deny-list, a linked person now SUPPRESSED or erased from the CRM, withdraws it (erasures behind the same breaker).
// - Everything withdrawn is final. One meeting on two members' calendars (same iCalendar UID and instance) is written once.
import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertLiveProvidersAllowed, providerFetch } from "../demo-safety";
import { must } from "../db";
import { demoMode } from "../demo";
import { TwentyError, type TwentyReader } from "../twenty";
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
export const LOOKAHEAD_DAYS = 90;
export const ADOPT_WINDOW_MS = 3 * 3_600_000;
/** The ledger's breaker (meeting_ledger.breaker_tripped): more than `most`, or at least two and more than `share` of `of`. */
export const breakerTripped = (n: number, of: number, most = 3, share = 0.2) => n > most || (n >= 2 && n > share * Math.max(of, 1));
/** Twenty's `mtgOwner` options: a member code outside them cannot own a row. */
export const OWNER_CODES = ["JOHN", "ABE"];
export const PRIVACY = ["private", "deny_list", "suppressed", "erased"] as const;
/** Map reasons that end the meeting for every member, not just the one whose calendar said so. */
const FINAL_FOR_ALL = new Set<string>([...PRIVACY, "person_deleted", "kept_manual"]);
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
    const d = JSON.parse(raw) as Record<string, unknown>;
    // Both lists must be present, and nothing else: a typo ("organisations") must not read as an empty list.
    if (!d || typeof d !== "object" || Array.isArray(d) || !Array.isArray(d.domains) || !Array.isArray(d.organizations)) return null;
    if (Object.keys(d).some((k) => k !== "domains" && k !== "organizations")) return null;
    return {
      domains: (d.domains as unknown[]).map((x) => String(x).trim().toLowerCase().replace(/^@/, "")).filter(Boolean),
      organizations: (d.organizations as unknown[]).map((x) => String(x).trim()).filter(Boolean),
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
  id: string; iCalUID?: string; status?: string; eventType?: string; visibility?: string;
  start?: { dateTime?: string; date?: string }; originalStartTime?: { dateTime?: string; date?: string };
  attendees?: { email?: string; displayName?: string; self?: boolean; resource?: boolean; responseStatus?: string }[];
};
export const EVENT_FIELDS = "nextPageToken,items(id,iCalUID,status,eventType,visibility,start,originalStartTime,attendees(email,displayName,self,resource,responseStatus))";

/** The event's identity across calendars: its iCalendar UID (the same on every attendee's copy, whoever organized it), plus
 *  the instance's original start (as a UTC instant) for one occurrence of a series. Falls back to Google's id. */
export const eventIdentity = (e: GEvent) => {
  if (!e.iCalUID) return e.id;
  const o = e.originalStartTime;
  if (!o) return e.iCalUID;
  // Google renders dateTime in each calendar's own time zone: the instance is the instant, so every copy keys the same.
  const at = o.dateTime && !Number.isNaN(Date.parse(o.dateTime)) ? new Date(o.dateTime).toISOString() : o.date ?? "";
  return `${e.iCalUID}|${at}`;
};

export type Candidate = { key: string; start: string; day: string; externals: string[]; names: string[] };
export type Gone = { key: string; why: string };
export type Sorted = { live: Candidate[]; gone: Gone[] };

/** Pure: which events may be a meeting (live) and which must not have a row (gone, with the reason). `self` is the
 *  calendar's own address; `team` holds every team address; `ignored` the extra domains (TEAM_IGNORE_DOMAINS). */
export function sortEvents(items: GEvent[], self: string, team: string[], ignored: string[], key: (identity: string) => string = eventKey): Sorted {
  const out: Sorted = { live: [], gone: [] };
  self = self.toLowerCase();
  const teamSet = new Set([self, ...team].map((a) => a.toLowerCase()));
  // The calendar's own domain is the team's, unless it is a freemail domain (a gmail calendar must not drop gmail guests).
  const domains = [...TEAM_DOMAINS, ...ignored, ...(FREEMAIL.has(domainOf(self)) ? [] : [domainOf(self)])];
  for (const e of items) {
    if (!e?.id) continue;
    const k = key(eventIdentity(e));
    const gone = (why: string) => out.gone.push({ key: k, why });
    if (e.status === "cancelled") { gone("cancelled"); continue; }
    if (e.eventType && e.eventType !== "default") { gone("not_a_meeting"); continue; }
    const dt = e.start?.dateTime;
    if (!dt || Number.isNaN(Date.parse(dt))) { gone("all_day"); continue; }
    const attendees = e.attendees ?? [];
    if (attendees.some((a) => (a.self || (a.email ?? "").toLowerCase() === self) && a.responseStatus === "declined")) { gone("declined"); continue; }
    const external = attendees.filter((a) => {
      const email = (a.email ?? "").trim().toLowerCase();
      return email.includes("@") && !a.self && !a.resource && !teamSet.has(email) && !NOT_PEOPLE.test(email) && !onDomain(domainOf(email), domains);
    });
    if (!external.length) { gone("internal"); continue; }
    // After the guest check, so only an event that could have been a meeting is withheld for every member.
    if (e.visibility === "private" || e.visibility === "confidential") { gone("private"); continue; }
    if (external.length > MAX_EXTERNAL) { gone("large_event"); continue; }
    out.live.push({
      key: k, start: new Date(dt).toISOString(), day: dt.slice(0, 10),
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

const ROW_NAMESPACE = Buffer.from("6f1c9d2e4b7a5c3e9a1d2f8e7b6c5a40", "hex");
/** The Twenty row id for a member's meeting (a UUID v5 of its capture key and the member): a second create of the same
 *  meeting is refused by Twenty, so a retry, an overlapping run or a lost map write cannot make a duplicate
 *  (meeting_ledger.record_id). Per member, so when one member declines or is uninvited, another attending member's sync
 *  writes its own row instead of finding the first in the trash. */
export function rowId(key: string, member: string): string {
  const h = createHash("sha1").update(ROW_NAMESPACE).update(`${captureKey(key)}|${member}|meeting`).digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

export type MapRow = {
  member: string; event_key: string; meeting_id: string | null; origin: "created" | "adopted" | "withheld"; start_at: string;
  kind: Kind | null; removed_at: string | null; removed_reason: string | null;
};

export type Want = { key: string; start: string; day: string; externals: number; choice: Choice };

/** Pure: the fields a row should hold for a wanted meeting. */
export function rowFields(w: Want, member: string) {
  return {
    name: composeName(w.day, w.choice), mtgAt: w.start, mtgOwner: member, mtgKind: w.choice.kind, mtgKindSource: "AUTO", mtgAutoKind: w.choice.kind,
    mtgCompanyId: w.choice.company?.id ?? null, mtgPersonId: w.choice.person?.id ?? null, mtgOpportunityId: w.choice.deal?.id ?? null,
    mtgExternalCount: w.externals, mtgCaptureKey: captureKey(w.key),
  };
}

/** Pure: what to change on a row this sync created. Time, date and count always; kind, links and the label only without a
 *  person's word (a manual row keeps its own label, only the date in its name follows the event). */
export function rowChanges(row: MeetingRow, want: ReturnType<typeof rowFields>): Partial<ReturnType<typeof rowFields>> {
  const manual = isManual(row);
  const target = manual ? { ...want, name: (row.name ?? want.name).replace(/^\d{4}-\d{2}-\d{2}/, want.name.slice(0, 10)) } : want;
  const keys: (keyof typeof want)[] = manual ? ["name", "mtgAt", "mtgExternalCount"] : ["name", "mtgAt", "mtgExternalCount", "mtgKind", "mtgAutoKind", "mtgCompanyId", "mtgPersonId", "mtgOpportunityId"];
  const out: Partial<typeof want> = {};
  for (const k of keys) {
    const have = row[k as keyof MeetingRow];
    const same = k === "mtgAt" ? !!have && Date.parse(String(have)) === Date.parse(String(target[k])) : (have ?? null) === (target[k] ?? null);
    if (!same) (out as Record<string, unknown>)[k] = target[k];
  }
  return out;
}

/** Pure: an existing row for the same meeting (same owner, within ADOPT_WINDOW_MS, same company or person), never a row
 *  this sync made for another event, a withdrawn row, or one already mapped. */
export function adoptable(rows: MeetingRow[], member: string, w: Want, taken: Set<string>): MeetingRow | null {
  const t = Date.parse(w.start);
  const hits = rows.filter((r) => r.mtgOwner === member && r.name !== RETRACTED && !taken.has(r.id) && !(r.mtgCaptureKey ?? "").startsWith("calendar:") &&
    r.mtgAt && Math.abs(Date.parse(r.mtgAt) - t) <= ADOPT_WINDOW_MS &&
    ((w.choice.company && r.mtgCompanyId === w.choice.company.id) || (w.choice.person && r.mtgPersonId === w.choice.person.id)));
  return hits.sort((a, b) => Math.abs(Date.parse(a.mtgAt!) - t) - Math.abs(Date.parse(b.mtgAt!) - t))[0] ?? null;
}

/** What a privacy withdrawal leaves before the row goes to the trash: nothing a person could read back (meeting_ledger.retract). */
const STRIPPED = { name: RETRACTED, mtgKind: "OTHER", mtgAutoKind: "OTHER", mtgCompanyId: null, mtgPersonId: null, mtgOpportunityId: null, mtgAt: null, mtgExternalCount: null };

/** An error to store: Twenty's own messages can echo a filter value (an attendee's address), so only its codes are kept. */
export function safeError(e: unknown): string {
  if (e instanceof TwentyError) {
    const codes = [...new Set((Array.isArray(e.errors) ? e.errors : []).map((x: { extensions?: { code?: string } }) => x?.extensions?.code).filter(Boolean))];
    return `Twenty refused a request (${codes.join(", ") || "no code"})`;
  }
  return String((e as Error)?.message ?? e).replace(/[^\s@]+@[^\s@]+\.[A-Za-z]{2,}/g, "<address>").slice(0, 300);
}

/* ------------------------------------------------------------------------------------------------ sync */

export type CalendarResult = {
  events: number; business: number; created: number; updated: number; adopted: number; removed: number; kept: number;
  withheld?: number; held?: number; swept?: number; error?: string;
};
export type CalendarRun = { skipped?: string; calendars?: Record<string, CalendarResult> };
export const LEASE = "pipeline.calendar";
export const heldKey = (member: string) => `calendar.held.${member.toLowerCase()}`;
export const releaseKey = (member: string) => `calendar.release.${member.toLowerCase()}`;
export const sweepKey = (member: string) => `calendar.sweep.${member.toLowerCase()}`;

type Connection = { member: string; address: string; token_ciphertext: string };

export async function syncCalendars(db: SupabaseClient, reader: TwentyReader, opts: { now?: Date; deadline?: number; fetcher?: typeof fetch } = {}): Promise<CalendarRun> {
  if (demoMode()) return { skipped: "demo mode" };
  const cfg = gmailConfig();
  if (!cfg) return { skipped: "TEAM_GMAIL_CLIENT_ID or TEAM_GMAIL_CLIENT_SECRET is not set" };
  const deny = denyList();
  if (!deny) return { skipped: "MEETING_DENY_LIST is not set or malformed: no meeting is written without the NDA deny-list" };
  const connections = must(await db.from("gtm_team_calendars").select("member,address,token_ciphertext").order("member"), "calendar connections") as Connection[];
  if (!connections.length) return { skipped: "no calendar connected" };
  // One sync at a time: Vercel can deliver a cron twice, and two runs must not race on the same rows.
  const holder = randomUUID();
  const lease = await db.rpc("gtm_take_lease", { p_job: LEASE, p_holder: holder, p_seconds: 300 });
  if (lease.error) return { skipped: `the calendar lease could not be taken (${lease.error.code ?? "error"})` };
  if (lease.data !== true) return { skipped: "another calendar sync holds the lease" };
  try { return await syncLeased(db, reader, connections, deny, cfg, opts); } finally { await db.rpc("gtm_release_lease", { p_job: LEASE, p_holder: holder }); }
}

async function syncLeased(db: SupabaseClient, reader: TwentyReader, connections: Connection[], deny: DenyList, cfg: GmailConfig, opts: { now?: Date; deadline?: number; fetcher?: typeof fetch }): Promise<CalendarRun> {
  const now = opts.now ?? new Date();
  const timeMin = new Date(now.getTime() - LOOKBACK_DAYS * DAY).toISOString(), timeMax = new Date(now.getTime() + LOOKAHEAD_DAYS * DAY).toISOString();
  const mailboxes = must(await db.from("gtm_team_mailboxes").select("address"), "team mailboxes") as { address: string }[];
  const team = [...new Set([...connections.map((c) => c.address), ...mailboxes.map((m) => m.address),
    ...teamMembers().flatMap((m) => [m.authEmail, ...m.mailboxes])].map((a) => a.toLowerCase()))];
  let opps: CrmOpp[] | null = null;
  const run: CalendarRun = { calendars: {} };
  for (const [i, c] of connections.entries()) {
    // A fair share of what is left, so a slow first calendar cannot starve the next one.
    if (opts.deadline != null) reader.setDeadline(Date.now() + Math.max(5_000, (opts.deadline - Date.now()) / (connections.length - i)));
    const label = `${c.member}:${c.address}`;
    const result: CalendarResult = { events: 0, business: 0, created: 0, updated: 0, adopted: 0, removed: 0, kept: 0 };
    try {
      if (!OWNER_CODES.includes(c.member)) throw new Error(`${c.member} is not an owner option of Twenty's meeting object; add it to mtgOwner first`);
      let token: string;
      try { token = await accessToken(cfg, openToken(c.token_ciphertext, calendarAad(c.member, c.address)), opts.fetcher ?? fetch); } catch (e) {
        if (e instanceof ReconnectError) throw new ReconnectError("Google no longer accepts the stored calendar connection. Reconnect the calendar.");
        throw e;
      }
      const items = await listEvents(token, timeMin, timeMax, opts.fetcher ?? fetch, opts.deadline);
      result.events = items.length;
      opps ??= await reader.all<CrmOpp>("opportunities", "id stage companyId", null, "OpportunityFilterInput", 100, 2_000);
      await syncOne(db, reader, c.member, c.address, items, { team, ignored: ignoredDomains(), deny, opps, timeMin, timeMax, now }, result);
      await sweep(db, reader, c.member, deny, now, result);
    } catch (e) {
      result.error = safeError(e);
    }
    run.calendars![label] = result;
    must(await db.from("gtm_team_calendars").update({ last_sync_at: now.toISOString(), last_error: result.error ?? null, last_result: result }).eq("member", c.member).eq("address", c.address), "save calendar sync");
  }
  if (opts.deadline != null) reader.setDeadline(opts.deadline);
  return run;
}

type Ctx = { team: string[]; ignored: string[]; deny: DenyList; opps: CrmOpp[]; timeMin: string; timeMax: string; now: Date };

const readIds = async (reader: TwentyReader, ids: string[], trash: boolean) => {
  const out: MeetingRow[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const f = trash ? { and: [{ id: { in: ids.slice(i, i + 50) } }, { deletedAt: { is: "NOT_NULL" } }] } : { id: { in: ids.slice(i, i + 50) } };
    out.push(...await reader.all<MeetingRow>("meetings", ROW_FIELDS, f, "MeetingFilterInput", 100, 100));
  }
  return out;
};
async function withdraw(reader: TwentyReader, id: string, privacy: boolean) {
  if (privacy) await reader.read("mutation($id:UUID!,$d:MeetingUpdateInput!){ updateMeeting(id:$id, data:$d) { id } }", { id, d: STRIPPED });
  await reader.read("mutation($id:UUID!){ deleteMeeting(id:$id) { id } }", { id });
}
const getState = async <T>(db: SupabaseClient, key: string) =>
  ((must(await db.from("gtm_sync_state").select("value").eq("key", key), `read ${key}`) as { value: T }[])[0]?.value ?? null);
const setState = async (db: SupabaseClient, key: string, value: unknown, now: Date) =>
  must(await db.from("gtm_sync_state").upsert({ key, value, updated_at: now.toISOString() }, { onConflict: "key" }), `save ${key}`);

async function syncOne(db: SupabaseClient, reader: TwentyReader, member: string, address: string, items: GEvent[], ctx: Ctx, result: CalendarResult) {
  const sorted = sortEvents(items, address, ctx.team, ctx.ignored);
  const seen = new Set([...sorted.live.map((e) => e.key), ...sorted.gone.map((g) => g.key)]);
  const gone = new Map(sorted.gone.map((g) => [g.key, g.why]));
  const live = sorted.live.filter((e) => {
    if (!eventDenied(e.externals, e.names, ctx.deny)) return true;
    gone.set(e.key, "deny_list");
    return false;
  });
  const emails = [...new Set(live.flatMap((e) => e.externals))];
  const byEmail = emails.length ? await peopleByEmail(reader, emails) : new Map<string, CrmPerson[]>();
  const domains = [...new Set(emails.filter((e) => !(byEmail.get(e) ?? []).length).map(domainOf))];
  const byDomain = domains.length ? await companiesByDomain(reader, domains) : new Map<string, CrmCompany[]>();
  const wants: Want[] = [];
  const holds = new Set<string>();
  for (const e of live) {
    const people = e.externals.flatMap((x) => byEmail.get(x) ?? []);
    // Every company the meeting touches, not just the chosen one: a denied company on any attendee excludes it.
    const companies = [...people.map((p) => (p.company ? { name: p.company.name, domain: hostOf(p.company.domainName?.primaryLinkUrl) } : null)),
      ...e.externals.flatMap((x) => byDomain.get(domainOf(x)) ?? []).map((c) => ({ name: c.name, domain: hostOf(c.domainName?.primaryLinkUrl) }))];
    if (companies.some((co) => companyDenied(co, ctx.deny))) { gone.set(e.key, "deny_list"); continue; }
    if (people.some(suppressed)) { gone.set(e.key, "suppressed"); continue; }
    // Capture's PROTECTED hold: someone who opted out (or is invalid) is in it; no row is created and none is removed.
    if (people.some(protectedPerson)) { holds.add(e.key); continue; }
    const choice = choose(e.externals, byEmail, byDomain, ctx.opps);
    if (!choice) { gone.set(e.key, "no_crm_match"); continue; }
    wants.push({ key: e.key, start: e.start, day: e.day, externals: e.externals.length, choice });
  }
  result.business = wants.length;

  const maps = await selectAll<MapRow>((from, to) => db.from("gtm_calendar_meetings").select("member,event_key,meeting_id,origin,start_at,kind,removed_at,removed_reason").order("event_key").range(from, to), "meeting map");
  const mine = new Map(maps.filter((m) => m.member === member).map((m) => [m.event_key, m]));
  const claimed = new Set(maps.filter((m) => m.member !== member && (!m.removed_at || FINAL_FOR_ALL.has(m.removed_reason ?? ""))).map((m) => m.event_key));
  // A mapped meeting whose event is in the window but no longer listed was deleted or moved past the window.
  for (const m of mine.values()) {
    const t = Date.parse(m.start_at);
    if (!m.removed_at && m.origin === "created" && !seen.has(m.event_key) && t >= Date.parse(ctx.timeMin) && t <= Date.parse(ctx.timeMax)) gone.set(m.event_key, "missing");
  }
  const lo = new Date(Date.parse(ctx.timeMin) - DAY).toISOString(), hi = new Date(Date.parse(ctx.timeMax) + DAY).toISOString();
  const rows = await reader.all<MeetingRow>("meetings", ROW_FIELDS, { and: [{ mtgOwner: { eq: member } }, { mtgAt: { gte: lo } }, { mtgAt: { lte: hi } }] }, "MeetingFilterInput", 100, 2_000);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const wanted = (ids: string[]) => ids.filter((id) => !byId.has(id));
  for (const r of await readIds(reader, wanted([...mine.values()].filter((m) => !m.removed_at && m.meeting_id).map((m) => m.meeting_id!)), false)) byId.set(r.id, r);
  const fresh = wants.filter((w) => !mine.has(w.key) && !claimed.has(w.key)).map((w) => rowId(w.key, member));
  for (const r of await readIds(reader, wanted(fresh), false)) byId.set(r.id, r);
  const trashed = new Set((await readIds(reader, wanted(fresh), true)).map((r) => r.id));
  const taken = new Set(maps.filter((m) => !m.removed_at && m.meeting_id).map((m) => m.meeting_id!));
  const stamp = ctx.now.toISOString();
  const save = async (m: Omit<MapRow, "removed_at" | "removed_reason"> & { removed_at?: string | null; removed_reason?: string | null }) =>
    must(await db.from("gtm_calendar_meetings").upsert({ ...m, updated_at: stamp }, { onConflict: "member,event_key" }), "save meeting map");
  const close = (m: MapRow, reason: string) => save({ ...m, removed_at: stamp, removed_reason: reason });

  // Privacy first, never behind the breaker: the row goes whoever made it and whatever its kind, and on every member's
  // calendar: a shared invite marked Private on one copy withdraws the row another member's sync already wrote.
  const othersLive = maps.filter((m) => m.member !== member && !m.removed_at && m.meeting_id);
  for (const [key, why] of gone) {
    if (!(PRIVACY as readonly string[]).includes(why)) continue;
    for (const o of othersLive.filter((o) => o.event_key === key)) {
      const [row] = await readIds(reader, [o.meeting_id!], false);
      if (row) { await withdraw(reader, row.id, true); result.removed++; }
      await close(o, why);
      o.removed_at = stamp;
    }
    const m = mine.get(key);
    if (!m) {
      await save({ member, event_key: key, meeting_id: null, origin: "withheld", start_at: stamp, kind: null, removed_at: stamp, removed_reason: why });
      result.withheld = (result.withheld ?? 0) + 1;
      continue;
    }
    if (m.removed_at) continue;
    if (m.meeting_id && byId.has(m.meeting_id)) { await withdraw(reader, m.meeting_id, true); result.removed++; }
    await close(m, why);
  }

  // Other withdrawals: only rows this sync created, behind the ledger's breaker unless an owner released this exact set.
  const pending = [...mine.values()].filter((m) => !m.removed_at && m.origin === "created" && gone.has(m.event_key) && !(PRIVACY as readonly string[]).includes(gone.get(m.event_key)!));
  const toRemove: MapRow[] = [];
  for (const m of pending) {
    if (!m.meeting_id || !byId.has(m.meeting_id)) await close(m, "person_deleted");
    else toRemove.push(m);
  }
  const liveRows = [...mine.values()].filter((m) => !m.removed_at && m.origin === "created").length;
  const release = await getState<{ keys?: string[] }>(db, releaseKey(member));
  const released = new Set(release?.keys ?? []);
  if (breakerTripped(toRemove.length, liveRows) && !toRemove.every((m) => released.has(m.event_key))) {
    result.held = toRemove.length;
    result.error = `${toRemove.length} meetings would be withdrawn at once (cancelled or no longer in the CRM); held until applied on Pipeline > Meetings`;
    await setState(db, heldKey(member), { keys: toRemove.map((m) => m.event_key), at: stamp }, ctx.now);
  } else {
    for (const m of toRemove) {
      const row = byId.get(m.meeting_id!)!;
      if (isManual(row)) { result.kept++; await close(m, "kept_manual"); continue; }
      await withdraw(reader, row.id, false);
      await close(m, gone.get(m.event_key)!);
      result.removed++;
    }
    if (release) must(await db.from("gtm_sync_state").delete().eq("key", releaseKey(member)), "clear release");
    must(await db.from("gtm_sync_state").delete().eq("key", heldKey(member)), "clear held");
  }

  for (const w of wants) {
    const map = mine.get(w.key);
    if (map?.removed_at) continue;                       // final: withdrawn, withheld, or deleted by a person
    if (!map && claimed.has(w.key)) continue;            // another member's calendar holds this meeting
    if (holds.has(w.key)) continue;
    const want = rowFields(w, member);
    if (map) {
      const row = map.meeting_id ? byId.get(map.meeting_id) : undefined;
      if (!row) { await close(map, "person_deleted"); continue; }   // a person deleted it: never recreated
      if (map.origin === "created") {
        const patch = rowChanges(row, want);
        if (Object.keys(patch).length) {
          await reader.read("mutation($id:UUID!,$d:MeetingUpdateInput!){ updateMeeting(id:$id, data:$d) { id } }", { id: row.id, d: patch });
          result.updated++;
        }
      }
      if (Date.parse(map.start_at) !== Date.parse(w.start) || map.kind !== w.choice.kind) await save({ ...map, start_at: w.start, kind: w.choice.kind });
      continue;
    }
    const id = rowId(w.key, member);
    const record = (meetingId: string, origin: "created" | "adopted") => save({ member, event_key: w.key, meeting_id: meetingId, origin, start_at: w.start, kind: w.choice.kind });
    if (byId.has(id)) { await record(id, "created"); taken.add(id); continue; }            // made by a run whose map write was lost
    if (trashed.has(id)) { await save({ member, event_key: w.key, meeting_id: id, origin: "created", start_at: w.start, kind: w.choice.kind, removed_at: stamp, removed_reason: "person_deleted" }); continue; }
    const existing = adoptable(rows, member, w, taken);
    if (existing) { await record(existing.id, "adopted"); taken.add(existing.id); result.adopted++; continue; }
    try {
      await reader.read("mutation($d:MeetingCreateInput!){ createMeeting(data:$d) { id } }", { d: { id, ...want } });
    } catch (e) {
      // A refused create (the id exists: an earlier attempt committed) is settled by reading the id back.
      if ((await readIds(reader, [id], false)).length) { await record(id, "created"); taken.add(id); continue; }
      if ((await readIds(reader, [id], true)).length) { await save({ member, event_key: w.key, meeting_id: id, origin: "created", start_at: w.start, kind: w.choice.kind, removed_at: stamp, removed_reason: "person_deleted" }); continue; }
      throw e;
    }
    await record(id, "created");
    taken.add(id);
    result.created++;
  }
}

/** Once a day: every meeting row the member owns, of any age and whoever wrote it, against the deny-list and the CRM's
 *  privacy state (meeting_ledger's daily checks, which retired with Granola capture). */
async function sweep(db: SupabaseClient, reader: TwentyReader, member: string, deny: DenyList, now: Date, result: CalendarResult) {
  const day = now.toISOString().slice(0, 10);
  if ((await getState<{ day?: string }>(db, sweepKey(member)))?.day === day) return;
  const rows = (await reader.all<MeetingRow>("meetings", ROW_FIELDS, { mtgOwner: { eq: member } }, "MeetingFilterInput", 100, 5_000)).filter((r) => r.name !== RETRACTED);
  const personIds = [...new Set(rows.map((r) => r.mtgPersonId).filter((x): x is string => !!x))];
  const companyIds = [...new Set(rows.map((r) => r.mtgCompanyId).filter((x): x is string => !!x))];
  const people = new Map<string, CrmPerson>(), trashedPeople = new Set<string>(), companies = new Map<string, CrmCompany>();
  for (let i = 0; i < personIds.length; i += 50) {
    const ids = personIds.slice(i, i + 50);
    for (const p of await reader.all<CrmPerson>("people", "id gtmQueue", { id: { in: ids } }, "PersonFilterInput", 100, 100)) people.set(p.id, p);
    const missing = ids.filter((id) => !people.has(id));
    if (missing.length) for (const p of await reader.all<{ id: string }>("people", "id", { and: [{ id: { in: missing } }, { deletedAt: { is: "NOT_NULL" } }] }, "PersonFilterInput", 100, 100)) trashedPeople.add(p.id);
  }
  for (let i = 0; i < companyIds.length; i += 50)
    for (const c of await reader.all<CrmCompany>("companies", "id name domainName { primaryLinkUrl }", { id: { in: companyIds.slice(i, i + 50) } }, "CompanyFilterInput", 100, 100)) companies.set(c.id, c);
  const hits: { row: MeetingRow; why: string }[] = [], erased: MeetingRow[] = [];
  for (const r of rows) {
    const co = r.mtgCompanyId ? companies.get(r.mtgCompanyId) : undefined;
    if (co && companyDenied({ name: co.name, domain: hostOf(co.domainName?.primaryLinkUrl) }, deny)) { hits.push({ row: r, why: "deny_list" }); continue; }
    if (!r.mtgPersonId) continue;
    const p = people.get(r.mtgPersonId);
    if (p && suppressed(p)) hits.push({ row: r, why: "suppressed" });
    else if (!p && !trashedPeople.has(r.mtgPersonId)) erased.push(r);
  }
  // Erasure is inferred from absence, so a bad read must not empty the ledger: the breaker holds it.
  if (breakerTripped(erased.length, rows.length)) result.error = `${erased.length} meetings link people the CRM no longer has; held (breaker)`;
  else hits.push(...erased.map((row) => ({ row, why: "erased" })));
  if (hits.length) {
    const maps = await selectAll<MapRow>((from, to) => db.from("gtm_calendar_meetings").select("member,event_key,meeting_id,origin,start_at,kind,removed_at,removed_reason").order("event_key").range(from, to), "meeting map");
    for (const { row, why } of hits) {
      await withdraw(reader, row.id, true);
      for (const m of maps.filter((m) => m.meeting_id === row.id && !m.removed_at))
        must(await db.from("gtm_calendar_meetings").upsert({ ...m, removed_at: now.toISOString(), removed_reason: why, updated_at: now.toISOString() }, { onConflict: "member,event_key" }), "save meeting map");
    }
  }
  result.swept = hits.length;
  await setState(db, sweepKey(member), { day, withdrawn: hits.length }, now);
}
