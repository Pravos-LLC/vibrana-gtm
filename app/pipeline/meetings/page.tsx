// Pipeline > Meetings: discovery meetings with prospects, client meetings and partner meetings, from the Twenty meeting
// ledger. Meeting capture (vibrana-crm) writes a row only for a Granola meeting it judged business, with someone the CRM
// knows; a person can add or correct a row in Twenty, and a person's kind is never overwritten.
import { Section, Shell, Table } from "@/components/shell";
import { StatTile } from "@/components/stat-tile";
import { SalesNav } from "@/components/sales/nav";
import { SourceNote } from "@/components/sales/parts";
import { loadMeetings, parseOwner, parsePeriod } from "@/lib/sales/load";
import { meetingStats, windowFor, type Meeting } from "@/lib/sales/metrics";
import { sessionDb } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const maxDuration = 30;
export const metadata = { title: "Meetings" };

const KIND: Record<string, string> = { DISCOVERY: "Discovery", CLIENT: "Client", PARTNER: "Partner", INTERNAL: "Internal", OTHER: "Other" };
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "Asia/Makassar", dateStyle: "medium", timeStyle: "short" });

export default async function Meetings({ searchParams }: { searchParams: Promise<{ owner?: string; period?: string }> }) {
  const sp = await searchParams;
  const owner = parseOwner(sp.owner), period = parsePeriod(sp.period);
  const now = new Date();
  const w = windowFor(period, now);
  await sessionDb();
  const read = await loadMeetings(w.start);
  const installed = read.data?.installed ? read.data : null;
  const st = installed ? meetingStats(installed.meetings, w, now, owner) : null;
  const missing = read.error ? "not measured: Twenty read failed" : "not measured: meeting ledger not installed";
  const row = (m: Meeting) => [
    <a key="n" href={m.url} target="_blank" rel="noreferrer" className="hover:underline">{m.name}</a>,
    when(m.at), KIND[m.kind ?? ""] ?? "Not set", m.company ?? "-", m.opportunityStage ? m.opportunityStage.toLowerCase() : "-", m.owner === "ABE" ? "Abe" : m.owner === "JOHN" ? "John" : "-",
  ];
  return (
    <Shell title="Meetings" active="/pipeline">
      <SalesNav active="/pipeline/meetings" owner={owner} period={period} />
      {read.error && <SourceNote tone="bad">Twenty could not be read ({read.error}).</SourceNote>}
      {read.data && !read.data.installed && <SourceNote>{read.data.reason} Meetings show as not measured until it is.</SourceNote>}
      {installed?.sample && <SourceNote>Sample meetings: this is a demo or preview, not the CRM.</SourceNote>}

      <div className="mb-10 grid grid-cols-2 gap-4 md:grid-cols-5">
        <StatTile label="Discovery meetings" value={st ? String(st.discovery) : null} missing={missing} note={st ? `${st.discoveryWithDeal} tied to a deal` : undefined} />
        <StatTile label="Client meetings" value={st ? String(st.client) : null} missing={missing} />
        <StatTile label="Partner meetings" value={st ? String(st.partner) : null} missing={missing} />
        <StatTile label="Other external" value={st ? String(st.other) : null} missing={missing} note="business, no deal or partner yet" />
        <StatTile label="Upcoming" value={st ? String(st.upcoming.length) : null} missing={missing} note="recorded ahead in Granola" />
      </div>

      {st && st.upcoming.length > 0 && (
        <Section title="Coming up">
          <Table head={["Meeting", "When (Bali)", "Kind", "Company", "Deal stage", "Owner"]} rows={st.upcoming.map(row)} />
        </Section>
      )}
      <Section title="Held">
        <Table head={["Meeting", "When (Bali)", "Kind", "Company", "Deal stage", "Owner"]} rows={(st?.recent ?? []).filter((m) => m.kind !== "INTERNAL").map(row)} />
      </Section>
      <Section title="How a meeting gets its kind">
        <ul className="list-disc space-y-1 pl-5 text-sm text-ink-2">
          <li>A Granola meeting becomes a record only when meeting capture judged it business and someone in it is in the CRM. Calls you do not record in Granola, or that capture has not judged yet, are not counted: add them in Twenty (Meetings) by hand.</li>
          <li>Internal and personal meetings are never recorded, and a record is withdrawn if you exclude the note, delete it, or the person is suppressed. The company has a won deal, or a contact is a client: client. An open deal or an eligible prospect: discovery. A partner contact: partner. Otherwise: other.</li>
          <li>Wrong kind? Change it in Twenty; a kind you set is never overwritten.</li>
        </ul>
      </Section>
    </Shell>
  );
}
