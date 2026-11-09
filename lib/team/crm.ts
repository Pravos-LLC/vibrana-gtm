// What a team member has put into Twenty: the rows they created (people, companies, notes), the tasks assigned to them,
// their meetings, and the opportunities their work touches. Read by the team cron with the paced TwentyReader and cached
// in gtm_sync_state (`team.activity.<code>`), so the page never waits on the CRM. Ids, dates and status fields only:
// names, emails and note bodies are never read here.
import type { SupabaseClient } from "@supabase/supabase-js";
import { must } from "../db";
import { TwentyError, type TwentyReader } from "../twenty";
import { selectAll } from "./mailbox";
import { createdByFilter, type TeamMember } from "./members";

/** One person row as the pre-VIB-516 cache stored it (people were read from Twenty into the cache, every row). */
export type ActivityPerson = { id: string; createdAt: string; hasEmail: boolean; verification: string | null; companyId?: string | null; notSendable: boolean; lastContactedAt?: string | null };
/**
 * What the team page needs about the people a member created (VIB-516), read from the CRM mirror (gtm_crm_people) by
 * gtm_team_people_summary. Its size grows with a member's recent additions, never with the CRM: counts for the stock
 * tiles, one creation time (epoch milliseconds) per person added since `addedSince` for the period, weekly and active-day
 * counts, the newest 25 adds for the timeline, and `mine`: of the people the member emailed or that are opportunity
 * contacts, the ones they created, with when (funnel "added by them", days to first touch).
 */
export type PeopleSummary = {
  total: number; withEmail: number; verified: number; sendable: number; unverified: number;
  addedSince: string;
  added: number[];
  latest: { id: string; createdAt: string }[];
  mine: Record<string, string>;
};
/** How far back `added` reaches: the 90-day period and the 90 days before it, with margin. The 8-week chart fits inside. */
export const ADDED_WINDOW_DAYS = 190;
// The account-review labels (revResearchStage, revDecision) are triage only and deprecated as inputs (VIB-481); not read here.
export type ActivityCompany = { id: string; createdAt: string; hasOwner: boolean };
export type ActivityOpportunity = { id: string; createdAt: string; stage: string | null; amount: number | null; currency: string | null; companyId: string | null; personId: string | null; mine: boolean };
export type ActivityTask = { id: string; status: string | null; dueAt: string | null; createdAt: string };
export type Activity = {
  member: string;
  capturedAt: string;
  people: PeopleSummary;
  companies: ActivityCompany[];
  notes: { createdAt: string }[];
  opportunities: ActivityOpportunity[];
  tasks: ActivityTask[];
  meetings: { createdAt: string; status: string | null }[];
  captureRuns: number | null;
  /** Objects that could not be read this run, with why (shown as "not measured", never as 0). */
  errors: Record<string, string>;
};

type CompanyNode = { id: string; createdAt: string; accountOwnerId: string | null };
type OppNode = { id: string; createdAt: string; stage: string | null; amount: { amountMicros: number | null; currencyCode: string | null } | null; companyId: string | null; pointOfContactId: string | null; createdBy: { source: string | null; name: string | null; workspaceMemberId: string | null } | null };

/** An empty summary, for a member whose people could not be read (the error says why; the page shows "not measured"). */
export const emptyPeople = (since = new Date(0)): PeopleSummary => ({ total: 0, withEmail: 0, verified: 0, sendable: 0, unverified: 0, addedSince: since.toISOString(), added: [], latest: [], mine: {} });

/**
 * The summary from full rows: how a pre-VIB-516 cache (which stored every person) is read, and the reference the tests
 * hold the mirror's SQL to. `mine` keeps every row's id, which is what a full list implied.
 */
export function summarizePeople(rows: ActivityPerson[], now = new Date()): PeopleSummary {
  const since = new Date(now.getTime() - ADDED_WINDOW_DAYS * 86_400_000);
  const ms = (iso: string) => Date.parse(iso);
  const sorted = [...rows].sort((a, b) => ms(a.createdAt) - ms(b.createdAt));
  return {
    total: rows.length,
    withEmail: rows.filter((x) => x.hasEmail).length,
    verified: rows.filter((x) => x.hasEmail && x.verification === "VERIFIED").length,
    sendable: rows.filter((x) => x.hasEmail && x.verification === "VERIFIED" && !x.notSendable).length,
    unverified: rows.filter((x) => x.verification !== "VERIFIED").length,
    addedSince: since.toISOString(),
    added: sorted.filter((x) => ms(x.createdAt) >= since.getTime()).map((x) => ms(x.createdAt)),
    latest: [...sorted].reverse().slice(0, 25).map((x) => ({ id: x.id, createdAt: x.createdAt })),
    mine: Object.fromEntries(rows.map((x) => [x.id, x.createdAt])),
  };
}

/** Reads a cache row written before VIB-516 (a people array) as the summary the page now expects. */
export function normalizeActivity(a: Activity | (Omit<Activity, "people"> & { people: ActivityPerson[] | PeopleSummary }) | null): Activity | null {
  if (!a) return null;
  return Array.isArray(a.people) ? { ...a, people: summarizePeople(a.people, new Date(a.capturedAt)) } : (a as Activity);
}

/** Where a member's people come from: the CRM mirror, through the two service-role functions (vibrana.ai 20261109010000). */
export type PeopleSource = {
  ready: () => Promise<{ ready: boolean; reason: string | null }>;
  summary: (member: TeamMember, since: Date) => Promise<Omit<PeopleSummary, "mine">>;
  lookup: (member: TeamMember, ids: string[]) => Promise<Record<string, string>>;
  /** Person ids the member's counted mail touched (every kind), for `mine`. */
  mailPeople: (member: TeamMember) => Promise<string[]>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function mirrorPeople(db: SupabaseClient, readiness: () => Promise<{ ready: boolean; reason: string | null }>): PeopleSource {
  return {
    ready: readiness,
    summary: async (member, since) => {
      const { data, error } = await db.rpc("gtm_team_people_summary", { p_member: member.workspaceMemberId, p_keys: member.apiKeyNames, p_since: since.toISOString() });
      if (error) throw new Error(`people summary: ${error.message}`);
      return data as Omit<PeopleSummary, "mine">;
    },
    lookup: async (member, ids) => {
      const out: Record<string, string> = {};
      const valid = [...new Set(ids.filter((id) => UUID.test(id)))];
      for (let i = 0; i < valid.length; i += 500) {
        const { data, error } = await db.rpc("gtm_team_people_lookup", { p_member: member.workspaceMemberId, p_keys: member.apiKeyNames, p_ids: valid.slice(i, i + 500) });
        if (error) throw new Error(`people lookup: ${error.message}`);
        for (const r of (data ?? []) as { id: string; created_at: string }[]) out[r.id] = new Date(r.created_at).toISOString();
      }
      return out;
    },
    mailPeople: async (member) => {
      const rows = await selectAll<{ person_ids: string[] }>((from, to) => db.from("gtm_team_mail_events").select("person_ids").eq("member", member.code).order("id").range(from, to), "mail people");
      return [...new Set(rows.flatMap((r) => r.person_ids ?? []))];
    },
  };
}

/**
 * Reads one member's activity. Each object is read on its own; a failure is recorded and the others still land.
 * People come from the CRM mirror (VIB-516), never a full Twenty read: a member can have created tens of thousands.
 * Companies, notes, opportunities, tasks and meeting proposals are small and are still read from Twenty.
 */
export async function collectActivity(reader: TwentyReader, member: TeamMember, people: PeopleSource, now = new Date()): Promise<Activity> {
  const mine = createdByFilter(member);
  const errors: Record<string, string> = {};
  const attempt = async <T>(name: string, read: () => Promise<T>, fallback: T): Promise<T> => {
    try { return await read(); } catch (e) {
      errors[name] = e instanceof TwentyError ? "Twenty rejected the query" : (e as Error).message.slice(0, 200);
      return fallback;
    }
  };
  const companies = await attempt("companies", async () => (await reader.all<CompanyNode>("companies",
    "id createdAt accountOwnerId", mine, "CompanyFilterInput"))
    .map((c) => ({ id: c.id, createdAt: c.createdAt, hasOwner: !!c.accountOwnerId })), [] as ActivityCompany[]);
  const notes = await attempt("notes", async () => (await reader.all<{ createdAt: string }>("notes", "createdAt", mine, "NoteFilterInput")), [] as { createdAt: string }[]);
  // Opportunities are few (a dozen); read them all, then keep the ones the member created or whose company or contact they added.
  const opps = await attempt("opportunities", async () => await reader.all<OppNode>("opportunities",
    "id createdAt stage amount { amountMicros currencyCode } companyId pointOfContactId createdBy { source name workspaceMemberId }", null, "OpportunityFilterInput"), null as OppNode[] | null);
  const summary = await attempt("people", async () => {
    const ok = await people.ready();
    if (!ok.ready) throw new Error(ok.reason ?? "the CRM mirror is not ready");
    const since = new Date(now.getTime() - ADDED_WINDOW_DAYS * 86_400_000);
    const base = await people.summary(member, since);
    const ids = [...await people.mailPeople(member), ...(opps ?? []).flatMap((o) => (o.pointOfContactId ? [o.pointOfContactId] : []))];
    return { ...base, mine: await people.lookup(member, ids) } as PeopleSummary;
  }, emptyPeople());
  const myCompanies = new Set(companies.map((c) => c.id));
  const opportunities = opps === null ? [] : opps.flatMap((o) => {
    const created = (member.workspaceMemberId && o.createdBy?.workspaceMemberId === member.workspaceMemberId)
      || (o.createdBy?.source === "API" && !!o.createdBy.name && member.apiKeyNames.includes(o.createdBy.name));
    // A contact counts only when the member's people were read: an unread mirror must not hide or invent a touch.
    const touched = created || (o.companyId && myCompanies.has(o.companyId)) || (!errors.people && o.pointOfContactId && o.pointOfContactId in summary.mine);
    return touched ? [{ id: o.id, createdAt: o.createdAt, stage: o.stage, amount: o.amount?.amountMicros != null ? o.amount.amountMicros / 1e6 : null,
      currency: o.amount?.currencyCode ?? null, companyId: o.companyId, personId: o.pointOfContactId, mine: !!created }] : [];
  });
  const tasks = member.workspaceMemberId
    ? await attempt("tasks", async () => (await reader.all<ActivityTask>("tasks", "id status dueAt createdAt", { assigneeId: { eq: member.workspaceMemberId } }, "TaskFilterInput")), [] as ActivityTask[])
    : [];
  // Meeting capture tags its proposals and runs with the owner code (JOHN / ABE), the same code the team config uses.
  const meetings = await attempt("meetings", async () => (await reader.all<{ createdAt: string; mpStatus: string | null }>("meetingProposals", "createdAt mpStatus",
    { mpOwner: { eq: member.code } }, "MeetingProposalFilterInput")).map((m) => ({ createdAt: m.createdAt, status: m.mpStatus })), [] as { createdAt: string; status: string | null }[]);
  const captureRuns = await attempt("captureRuns", async () => (await reader.read<{ meetingCaptureRuns: { totalCount: number } }>(
    "query($f:MeetingCaptureRunFilterInput){ meetingCaptureRuns(filter:$f, first:1) { totalCount } }", { f: { mcrOwner: { eq: member.code } } })).meetingCaptureRuns.totalCount, null as number | null);
  return { member: member.code, capturedAt: now.toISOString(), people: summary, companies, notes, opportunities, tasks, meetings, captureRuns, errors };
}

export const activityKey = (code: string) => `team.activity.${code.toLowerCase()}`;

export async function saveActivity(db: SupabaseClient, a: Activity) {
  must(await db.from("gtm_sync_state").upsert({ key: activityKey(a.member), value: a, updated_at: a.capturedAt }, { onConflict: "key" }), "save team activity");
}

export async function loadActivity(db: SupabaseClient, code: string): Promise<Activity | null> {
  const { data, error } = await db.from("gtm_sync_state").select("value").eq("key", activityKey(code)).maybeSingle();
  if (error) throw new Error(`team activity: ${error.message}`);
  return normalizeActivity((data?.value as Activity | undefined) ?? null);
}

/* ------------------------------------------------------------------ writers the attribution does not know about */
// Attribution is by API key name. If someone starts writing through a new key (a renamed key, a new agent), the member's
// numbers would silently stop moving. Each run lists the API key names that wrote rows in the last two days; a name not
// seen before is reported once.

export const KNOWN_KEYS = "team.api_key_names";

/**
 * API key names that wrote rows in the last two days and are not in `known`. It asks Twenty for one row created through
 * the API under a name it has not seen yet, adds that name to the exclusions and asks again, until none is left: a few
 * requests whatever the volume (it used to page through every row and broke on a large import, VIB-516).
 */
export async function recentApiWriters(reader: TwentyReader, now = new Date(), known: string[] = []): Promise<string[]> {
  const since = new Date(now.getTime() - 2 * 86_400_000).toISOString();
  const found = new Set<string>(), blank = new Set<string>();
  for (const [object, type] of [["people", "PersonFilterInput"], ["companies", "CompanyFilterInput"], ["notes", "NoteFilterInput"], ["opportunities", "OpportunityFilterInput"]] as const) {
    for (let guard = 0; guard < 50; guard++) {
      const exclude = [...new Set([...known, ...found, ...blank])];
      // A row with no key name cannot be attributed and must not end the search for real names (review of #36, F3).
      const and: Record<string, unknown>[] = [{ createdAt: { gte: since } }, { createdBy: { source: { eq: "API" } } }, { createdBy: { name: { is: "NOT_NULL" } } }];
      if (exclude.length) and.push({ not: { createdBy: { name: { in: exclude } } } });
      const d = await reader.read<Record<string, { edges: { node: { createdBy: { name: string | null } | null } }[] }>>(
        `query($f:${type}){ ${object}(filter:$f, first:1) { edges { node { createdBy { name } } } } }`, { f: { and } });
      const name = d[object]?.edges[0]?.node.createdBy?.name;
      if (name == null || exclude.includes(name)) break;
      // An empty key name is excluded from the next ask but is not a writer anyone can configure.
      if (name === "") { blank.add(name); continue; }
      found.add(name);
    }
  }
  return [...found].sort();
}

/** The API key names already recorded, or null before the first run seeded them. */
export async function knownApiWriters(db: SupabaseClient): Promise<string[] | null> {
  const { data, error } = await db.from("gtm_sync_state").select("value").eq("key", KNOWN_KEYS).maybeSingle();
  if (error) throw new Error(`known API keys: ${error.message}`);
  return (data?.value as { names?: string[] } | undefined)?.names ?? null;
}

/** The names never seen before (none on the very first run, which only seeds the list). Nothing is saved here. */
export async function newApiWriters(db: SupabaseClient, names: string[]): Promise<{ fresh: string[]; all: string[] }> {
  const { data, error } = await db.from("gtm_sync_state").select("value").eq("key", KNOWN_KEYS).maybeSingle();
  if (error) throw new Error(`known API keys: ${error.message}`);
  const known = (data?.value as { names?: string[] } | undefined)?.names;
  return { fresh: known ? names.filter((n) => !known.includes(n)) : [], all: [...new Set([...(known ?? []), ...names])].sort() };
}

/** Records the names as known, after any alert about them went out, so a failed alert is retried next run. */
export async function saveApiWriters(db: SupabaseClient, all: string[], now = new Date()) {
  must(await db.from("gtm_sync_state").upsert({ key: KNOWN_KEYS, value: { names: all, updated: now.toISOString() }, updated_at: now.toISOString() }, { onConflict: "key" }), "save known API keys");
}
