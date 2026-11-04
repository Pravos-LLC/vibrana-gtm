// What a team member has put into Twenty: the rows they created (people, companies, notes), the tasks assigned to them,
// their meetings, and the opportunities their work touches. Read by the team cron with the paced TwentyReader and cached
// in gtm_sync_state (`team.activity.<code>`), so the page never waits on the CRM. Ids, dates and status fields only:
// names, emails and note bodies are never read here.
import type { SupabaseClient } from "@supabase/supabase-js";
import { must } from "../db";
import { TwentyError, type TwentyReader } from "../twenty";
import { createdByFilter, type TeamMember } from "./members";

export type ActivityPerson = { id: string; createdAt: string; hasEmail: boolean; verification: string | null; companyId: string | null; notSendable: boolean; lastContactedAt: string | null };
export type ActivityCompany = { id: string; createdAt: string; stage: string | null; decision: string | null; hasOwner: boolean };
export type ActivityOpportunity = { id: string; createdAt: string; stage: string | null; amount: number | null; currency: string | null; companyId: string | null; personId: string | null; mine: boolean };
export type ActivityTask = { id: string; status: string | null; dueAt: string | null; createdAt: string };
export type Activity = {
  member: string;
  capturedAt: string;
  people: ActivityPerson[];
  companies: ActivityCompany[];
  notes: { createdAt: string }[];
  opportunities: ActivityOpportunity[];
  tasks: ActivityTask[];
  meetings: { createdAt: string; status: string | null }[];
  captureRuns: number | null;
  /** Objects that could not be read this run, with why (shown as "not measured", never as 0). */
  errors: Record<string, string>;
};

type PersonNode = { id: string; createdAt: string; emails: { primaryEmail: string | null } | null; revEmailVerification: string | null; companyId: string | null; prospectNotSendable: boolean | null; lastContactedAt: string | null };
type CompanyNode = { id: string; createdAt: string; revResearchStage: string | null; revDecision: string | null; accountOwnerId: string | null };
type OppNode = { id: string; createdAt: string; stage: string | null; amount: { amountMicros: number | null; currencyCode: string | null } | null; companyId: string | null; pointOfContactId: string | null; createdBy: { source: string | null; name: string | null; workspaceMemberId: string | null } | null };

/** Reads one member's activity. Each object is read on its own; a failure is recorded and the others still land. */
export async function collectActivity(reader: TwentyReader, member: TeamMember, now = new Date()): Promise<Activity> {
  const mine = createdByFilter(member);
  const errors: Record<string, string> = {};
  const attempt = async <T>(name: string, read: () => Promise<T>, fallback: T): Promise<T> => {
    try { return await read(); } catch (e) {
      errors[name] = e instanceof TwentyError ? "Twenty rejected the query" : (e as Error).message.slice(0, 200);
      return fallback;
    }
  };
  const people = await attempt("people", async () => (await reader.all<PersonNode>("people",
    "id createdAt emails { primaryEmail } revEmailVerification companyId prospectNotSendable lastContactedAt", mine, "PersonFilterInput"))
    .map((p) => ({ id: p.id, createdAt: p.createdAt, hasEmail: !!p.emails?.primaryEmail, verification: p.revEmailVerification, companyId: p.companyId,
      notSendable: p.prospectNotSendable === true, lastContactedAt: p.lastContactedAt })), [] as ActivityPerson[]);
  const companies = await attempt("companies", async () => (await reader.all<CompanyNode>("companies",
    "id createdAt revResearchStage revDecision accountOwnerId", mine, "CompanyFilterInput"))
    .map((c) => ({ id: c.id, createdAt: c.createdAt, stage: c.revResearchStage, decision: c.revDecision, hasOwner: !!c.accountOwnerId })), [] as ActivityCompany[]);
  const notes = await attempt("notes", async () => (await reader.all<{ createdAt: string }>("notes", "createdAt", mine, "NoteFilterInput")), [] as { createdAt: string }[]);
  const myPeople = new Set(people.map((p) => p.id)), myCompanies = new Set(companies.map((c) => c.id));
  // Opportunities are few (a dozen); read them all and keep the ones the member created or whose company or contact they added.
  const opportunities = await attempt("opportunities", async () => (await reader.all<OppNode>("opportunities",
    "id createdAt stage amount { amountMicros currencyCode } companyId pointOfContactId createdBy { source name workspaceMemberId }", null, "OpportunityFilterInput"))
    .flatMap((o) => {
      const created = (member.workspaceMemberId && o.createdBy?.workspaceMemberId === member.workspaceMemberId)
        || (o.createdBy?.source === "API" && !!o.createdBy.name && member.apiKeyNames.includes(o.createdBy.name));
      const touched = created || (o.companyId && myCompanies.has(o.companyId)) || (o.pointOfContactId && myPeople.has(o.pointOfContactId));
      return touched ? [{ id: o.id, createdAt: o.createdAt, stage: o.stage, amount: o.amount?.amountMicros != null ? o.amount.amountMicros / 1e6 : null,
        currency: o.amount?.currencyCode ?? null, companyId: o.companyId, personId: o.pointOfContactId, mine: !!created }] : [];
    }), [] as ActivityOpportunity[]);
  const tasks = member.workspaceMemberId
    ? await attempt("tasks", async () => (await reader.all<ActivityTask>("tasks", "id status dueAt createdAt", { assigneeId: { eq: member.workspaceMemberId } }, "TaskFilterInput")), [] as ActivityTask[])
    : [];
  // Meeting capture tags its proposals and runs with the owner code (JOHN / ABE), the same code the team config uses.
  const meetings = await attempt("meetings", async () => (await reader.all<{ createdAt: string; mpStatus: string | null }>("meetingProposals", "createdAt mpStatus",
    { mpOwner: { eq: member.code } }, "MeetingProposalFilterInput")).map((m) => ({ createdAt: m.createdAt, status: m.mpStatus })), [] as { createdAt: string; status: string | null }[]);
  const captureRuns = await attempt("captureRuns", async () => (await reader.read<{ meetingCaptureRuns: { totalCount: number } }>(
    "query($f:MeetingCaptureRunFilterInput){ meetingCaptureRuns(filter:$f, first:1) { totalCount } }", { f: { mcrOwner: { eq: member.code } } })).meetingCaptureRuns.totalCount, null as number | null);
  return { member: member.code, capturedAt: now.toISOString(), people, companies, notes, opportunities, tasks, meetings, captureRuns, errors };
}

export const activityKey = (code: string) => `team.activity.${code.toLowerCase()}`;

export async function saveActivity(db: SupabaseClient, a: Activity) {
  must(await db.from("gtm_sync_state").upsert({ key: activityKey(a.member), value: a, updated_at: a.capturedAt }, { onConflict: "key" }), "save team activity");
}

export async function loadActivity(db: SupabaseClient, code: string): Promise<Activity | null> {
  const { data, error } = await db.from("gtm_sync_state").select("value").eq("key", activityKey(code)).maybeSingle();
  if (error) throw new Error(`team activity: ${error.message}`);
  return (data?.value as Activity | undefined) ?? null;
}

/* ------------------------------------------------------------------ writers the attribution does not know about */
// Attribution is by API key name. If someone starts writing through a new key (a renamed key, a new agent), the member's
// numbers would silently stop moving. Each run lists the API key names that wrote rows in the last two days; a name not
// seen before is reported once.

export const KNOWN_KEYS = "team.api_key_names";

export async function recentApiWriters(reader: TwentyReader, now = new Date()): Promise<string[]> {
  const since = new Date(now.getTime() - 2 * 86_400_000).toISOString();
  const names = new Set<string>();
  for (const [object, type] of [["people", "PersonFilterInput"], ["companies", "CompanyFilterInput"], ["notes", "NoteFilterInput"], ["opportunities", "OpportunityFilterInput"]] as const) {
    const rows = await reader.all<{ createdBy: { source: string | null; name: string | null } | null }>(object, "createdBy { source name }",
      { and: [{ createdAt: { gte: since } }, { createdBy: { source: { eq: "API" } } }] }, type, 100, 1_000);
    for (const r of rows) if (r.createdBy?.name) names.add(r.createdBy.name);
  }
  return [...names].sort();
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
