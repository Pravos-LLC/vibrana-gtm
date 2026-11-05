// Meetings for the pipeline dashboard: the Twenty `meeting` ledger that meeting capture writes for every Granola meeting
// (vibrana-crm qualification/meeting_capture.py; kinds DISCOVERY, CLIENT, PARTNER, INTERNAL, OTHER, decided there and
// correctable in Twenty). Read live per page view. Until the object exists the page says "not installed", never 0.
import { demoMode } from "../demo";
import { schemaMiss } from "../meeting-capture";
import { TwentyError } from "../twenty";
import type { Owner } from "./deals";
import type { Meeting } from "./metrics";

/** The name meeting capture gives a row it had to withdraw (vibrana-crm meeting_ledger.retract). */
export const RETRACTED = "Retracted meeting";

export type MeetingRead = { installed: true; meetings: Meeting[]; sample: boolean } | { installed: false; reason: string };

type Node = {
  id: string; name: string | null; mtgAt: string | null; mtgOwner: string | null; mtgKind: string | null;
  mtgCompany: { name: string | null } | null; mtgOpportunity: { id: string; stage: string | null } | null;
};

export async function salesMeetings(since: Date, opts: { timeoutMs?: number; query?: (q: string) => Promise<unknown> } = {}): Promise<MeetingRead> {
  if (demoMode() && !opts.query) return { installed: true, meetings: sampleMeetings(), sample: true };
  const base = process.env.TWENTY_BASE ?? "https://brand.example.com";
  const run = opts.query ?? (async (query: string) => {
    const token = process.env.TWENTY_API_KEY;
    if (!token) throw new Error("TWENTY_API_KEY is not set");
    const res = await fetch(`${base}/graphql`, { method: "POST", signal: AbortSignal.timeout(opts.timeoutMs ?? 8_000),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ query }) });
    const json = await res.json().catch(() => ({})) as { data?: unknown; errors?: unknown };
    if (!res.ok || json.errors) throw new TwentyError(`Twenty: ${JSON.stringify(json.errors ?? json).slice(0, 300)}`, json.errors);
    return json.data;
  });
  try {
    const d = await run(`{ meetings(first:300, filter:{mtgAt:{gte:"${since.toISOString()}"}}, orderBy:[{mtgAt:DescNullsLast}]) {
      edges { node { id name mtgAt mtgOwner mtgKind mtgCompany { name } mtgOpportunity { id stage } } } } }`) as { meetings: { edges: { node: Node }[] } };
    // A retracted row (an opt-out after it was written) waits for an admin delete; it is not a meeting.
    const meetings = d.meetings.edges.map(({ node: n }) => n).filter((n) => n.mtgAt && n.name !== RETRACTED).map((n): Meeting => ({
      id: n.id, name: n.name || "Meeting", at: n.mtgAt!, owner: n.mtgOwner === "JOHN" || n.mtgOwner === "ABE" ? (n.mtgOwner as Owner) : null,
      kind: n.mtgKind, company: n.mtgCompany?.name || null, opportunityId: n.mtgOpportunity?.id ?? null, opportunityStage: n.mtgOpportunity?.stage ?? null,
      url: `${base}/object/meeting/${n.id}`,
    }));
    return { installed: true, meetings, sample: false };
  } catch (e) {
    const miss = e instanceof TwentyError ? schemaMiss(e.errors) : null;
    if (miss) return { installed: false, reason: "The meeting ledger is not in Twenty yet (vibrana-crm pipeline_schema.py)." };
    throw e;
  }
}

const at = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
function sampleMeetings(): Meeting[] {
  const m = (id: string, name: string, days: number, kind: string, owner: Owner = "JOHN", company: string | null = null, opp: string | null = null): Meeting =>
    ({ id, name, at: at(days), owner, kind, company, opportunityId: opp, opportunityStage: opp ? "PROPOSAL" : null, url: "https://brand.example.com/object/meeting/" + id });
  return [
    m("00000000-0000-4000-8000-0000000000b1", "Harbor Labs scoping", -3, "DISCOVERY", "JOHN", "Harbor Labs", "00000000-0000-4000-8000-0000000000a1"),
    m("00000000-0000-4000-8000-0000000000b2", "Fabrikam check-in", -1, "CLIENT", "JOHN", "Fabrikam"),
    m("00000000-0000-4000-8000-0000000000b3", "Northwind intro", -6, "DISCOVERY", "ABE", "Northwind", "00000000-0000-4000-8000-0000000000a2"),
    m("00000000-0000-4000-8000-0000000000b4", "Partner sync", -2, "PARTNER"),
    m("00000000-0000-4000-8000-0000000000b5", "Team planning", -4, "INTERNAL"),
    m("00000000-0000-4000-8000-0000000000b6", "Harbor Labs follow-up", 2, "DISCOVERY", "JOHN", "Harbor Labs", "00000000-0000-4000-8000-0000000000a1"),
  ];
}
