// Pipeline > Meetings: discovery meetings with prospects, client meetings and partner meetings, from the Twenty meeting
// ledger. Since VIB-518 the rows come from each member's Google Calendar (lib/team/calendar.ts), connected on this page;
// earlier rows came from Granola meeting capture. A person can add or correct a row in Twenty, and a person's kind is
// never overwritten.
import { Section, Shell, Table } from "@/components/shell";
import { StatTile } from "@/components/stat-tile";
import { SalesNav } from "@/components/sales/nav";
import { SourceNote } from "@/components/sales/parts";
import { loadMeetings, parseOwner, parsePeriod } from "@/lib/sales/load";
import { meetingStats, windowFor, type Meeting } from "@/lib/sales/metrics";
import { sessionDb } from "@/lib/supabase/server";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { viewer } from "@/lib/team/connect";
import { gmailConfig } from "@/lib/team/mailbox";
import { denyList, type CalendarResult } from "@/lib/team/calendar";
import { teamMembers } from "@/lib/team/members";
import { connectCalendar, disconnectCalendar } from "./actions";

export const dynamic = "force-dynamic";
export const maxDuration = 30;
export const metadata = { title: "Meetings" };

const KIND: Record<string, string> = { DISCOVERY: "Discovery", CLIENT: "Client", PARTNER: "Partner", INTERNAL: "Internal", OTHER: "Other" };
const CALENDAR_STATUS: Record<string, string> = {
  connected: "Calendar connected. The pipeline job reads it within the hour and writes the meetings it finds.",
  disconnected: "Calendar disconnected. The stored access was deleted; meetings already in the CRM stay.",
  declined: "Google consent was cancelled. Nothing was connected.",
  expired: "The connection request expired or came from another browser. Start again.",
  invalid: "Google sent back an incomplete answer. Start again.",
  "wrong-user": "The signed-in account changed during the connection. Start again from your own login.",
  "scope-missing": "Google did not grant calendar access (the box may have been unticked). Start again and allow it.",
  "google-refused": "Google did not grant offline, read-only calendar access. Start again and accept the permission.",
  "not-configured": "The Google connection is not set up in this deployment (TEAM_GMAIL_CLIENT_ID / TEAM_GMAIL_CLIENT_SECRET).",
  "not-member": "Your login is not a configured team member, so there is no calendar to connect.",
  "save-failed": "The connection could not be saved. Try again.",
  "disconnect-failed": "The calendar could not be disconnected. Try again.",
};
type CalendarRow = { member: string; address: string; connected_at: string; last_sync_at: string | null; last_error: string | null; last_result: CalendarResult | null };
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "Asia/Makassar", dateStyle: "medium", timeStyle: "short" });

export default async function Meetings({ searchParams }: { searchParams: Promise<{ owner?: string; period?: string; calendar?: string }> }) {
  const sp = await searchParams;
  const owner = parseOwner(sp.owner), period = parsePeriod(sp.period);
  const now = new Date();
  const w = windowFor(period, now);
  const db = await sessionDb();
  const read = await loadMeetings(w.start);
  const v = await viewer();
  const cal = await db.from("gtm_team_calendars").select("member,address,connected_at,last_sync_at,last_error,last_result").order("member");
  const calendars = (cal.data ?? []) as CalendarRow[];
  const members = teamMembers();
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
      {sp.calendar && CALENDAR_STATUS[sp.calendar] && <Card glow={false} className="mb-8 p-4 text-sm text-ink-2" role="status">{CALENDAR_STATUS[sp.calendar]}</Card>}

      <div className="mb-10 grid grid-cols-2 gap-4 md:grid-cols-5">
        <StatTile label="Discovery meetings" value={st ? String(st.discovery) : null} missing={missing} note={st ? `${st.discoveryWithDeal} tied to a deal` : undefined} />
        <StatTile label="Client meetings" value={st ? String(st.client) : null} missing={missing} />
        <StatTile label="Partner meetings" value={st ? String(st.partner) : null} missing={missing} />
        <StatTile label="Other external" value={st ? String(st.other) : null} missing={missing} note="business, no open or won deal" />
        <StatTile label="Upcoming" value={st ? String(st.upcoming.length) : null} missing={missing} note="from connected calendars" />
      </div>

      {st && st.upcoming.length > 0 && (
        <Section title="Coming up">
          <Table head={["Meeting", "When (Bali)", "Kind", "Company", "Deal stage", "Owner"]} rows={st.upcoming.map(row)} />
        </Section>
      )}
      <Section title="Held">
        <Table head={["Meeting", "When (Bali)", "Kind", "Company", "Deal stage", "Owner"]} rows={(st?.recent ?? []).filter((m) => m.kind !== "INTERNAL").map(row)} />
      </Section>
      <Section title="Calendars">
        <div className="max-w-3xl space-y-3 text-sm leading-relaxed text-ink-2">
          <p>Meetings come from each team member&apos;s Google Calendar. Connect the calendar your client meetings are on; it can be a different account from your mailbox.</p>
          {cal.error && <p className="text-red-strong">Calendar connections could not be read ({cal.error.message}).</p>}
          {members.map((m) => {
            const rows = calendars.filter((c) => c.member === m.code);
            return (
              <div key={m.code} className="space-y-2">
                <p className="font-medium text-ink">{m.label}</p>
                {rows.length ? rows.map((r) => (
                  <Card key={r.address} glow={false} className="p-4">
                    <p className="text-ink">{r.address}</p>
                    <p className="text-ink-3">Connected {r.connected_at.slice(0, 10)}. {r.last_sync_at ? `Last read ${when(r.last_sync_at)} (Bali).` : "Not read yet: the pipeline job runs hourly."}
                      {r.last_result && !r.last_result.error ? ` ${r.last_result.events} events, ${r.last_result.business} with someone in the CRM; ${r.last_result.created} added, ${r.last_result.adopted} matched to existing records, ${r.last_result.removed} withdrawn.` : ""}</p>
                    {r.last_error && <p className="mt-1 text-red-strong">{r.last_error}</p>}
                    {v?.member?.code === m.code && <form action={disconnectCalendar} className="mt-3"><input type="hidden" name="address" value={r.address} /><Button type="submit" variant="secondary">Disconnect</Button></form>}
                  </Card>
                )) : <p>Not connected.</p>}
                {v?.member?.code === m.code && <form action={connectCalendar}><Button type="submit">{rows.length ? "Connect another calendar" : "Connect Google Calendar"}</Button></form>}
              </div>
            );
          })}
          {!members.length && <p>No team members are configured in this deployment.</p>}
          {v && !v.member && <p>Your login is not a configured team member, so there is no calendar for you to connect.</p>}
          {!gmailConfig() && <p className="text-ink-3">{CALENDAR_STATUS["not-configured"]}</p>}
          {!denyList() && <p className="text-ink-3">The NDA deny-list (MEETING_DENY_LIST) is not set in this deployment, so connected calendars are read but no meeting is written.</p>}
        </div>
      </Section>
      <Section title="What is read, and how a meeting gets its kind">
        <ul className="list-disc space-y-1 pl-5 text-sm text-ink-2">
          <li>Permission asked: Google&apos;s read-only calendar scope and your email address. It cannot create, change or delete anything.</li>
          <li>Read for each event: its time, type, privacy setting and who is invited (address, name, response). Titles, descriptions, locations and call links are never fetched. Names are used only to check the NDA deny-list and are not kept.</li>
          <li>An event becomes a meeting record when someone invited is in the CRM (or their company&apos;s website domain is), and it is not cancelled, declined, all-day, marked Private, internal, or a webinar of more than 15 guests. The record&apos;s name is the date and the CRM company or person, never the event title. Mark an event Private in Google Calendar to keep it out.</li>
          <li>The company has a won deal, or a contact is a client or former client: client. An open deal or an eligible prospect: discovery. A partner contact: partner. Otherwise: other. A meeting already recorded (from Granola or by hand) at the same company within three hours is matched, not added again.</li>
          <li>When an event is cancelled or stops qualifying, the record it created is moved to Twenty&apos;s trash, unless you changed its kind. Wrong kind? Change it in Twenty; a kind you set is never overwritten.</li>
        </ul>
      </Section>
    </Shell>
  );
}
