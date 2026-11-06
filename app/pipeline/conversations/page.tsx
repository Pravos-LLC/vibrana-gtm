// Pipeline > Conversations: outreach that turns into conversations. Email from the writing desk (first touches,
// follow-ups, replies and John's positive label, per track), LinkedIn from the weekly export, and website inquiries.
// No opens: there is no tracking pixel.
import Link from "next/link";
import { Section, Shell, Table } from "@/components/shell";
import { StatTile } from "@/components/stat-tile";
import { TrendChart } from "@/components/performance/trend-chart";
import { SalesNav, pct } from "@/components/sales/nav";
import { SourceNote } from "@/components/sales/parts";
import { adminDb } from "@/lib/db";
import { loadDesk, loadInquiries, loadLinkedIn, ownerOfSender, parseOwner, parsePeriod } from "@/lib/sales/load";
import { deskStats, linkedinStats, windowFor, type ChannelStats, type Window } from "@/lib/sales/metrics";
import { sessionDb } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const maxDuration = 30;
export const metadata = { title: "Conversations" };

const WEEKS = 12;
// Email contract v1 (VIB-496): alert above 2%. The cohort-based alert over the last 7 days, at any n, runs in email health;
// this tile shows the period rate against the same threshold.
const BOUNCE_ALARM = 0.02;

export default async function Conversations({ searchParams }: { searchParams: Promise<{ owner?: string; period?: string }> }) {
  const sp = await searchParams;
  const owner = parseOwner(sp.owner), period = parsePeriod(sp.period);
  const now = new Date();
  const w = windowFor(period, now);
  const trendStart = new Date(now.getTime() - WEEKS * 7 * 86_400_000);
  const since = new Date(Math.min(w.start.getTime(), trendStart.getTime()));
  const db = await sessionDb();
  const { data: claims } = await db.auth.getClaims();
  const isOwner = (claims?.claims?.app_metadata as { gtm_owner?: boolean } | undefined)?.gtm_owner === true;
  const [desk, linkedin, inquiries] = await Promise.all([
    loadDesk(db, since), loadLinkedIn(db, since),
    isOwner && !owner ? loadInquiries(adminDb(), since) : Promise.resolve({ data: null, error: owner ? "inquiries are not attributed to a person" : "not the owner" }),
  ]);
  const ownerOf = ownerOfSender();
  const rows = desk.data ?? [];
  const client = deskStats(rows, w, ownerOf, owner, "client"), guest = deskStats(rows, w, ownerOf, owner, "guest");
  const li = linkedin.data ? linkedinStats(linkedin.data.connections, linkedin.data.threads, w, owner) : null;
  const inq = inquiries.data ? inquiries.data.filter((r) => Date.parse(r.created_at) >= w.start.getTime()).length : null;
  const weeks = Array.from({ length: WEEKS }, (_, i) => {
    const end = new Date(now.getTime() - (WEEKS - 1 - i) * 7 * 86_400_000);
    const win: Window = { start: new Date(end.getTime() - 7 * 86_400_000), end, days: 7 };
    return { x: end.toISOString().slice(5, 10), s: deskStats(rows, win, ownerOf, owner) };
  });
  const totalFor = (k: keyof ChannelStats) => (client[k] as number) + (guest[k] as number);
  const lastImport = linkedin.data?.lastImport;
  const row = (label: string, st: ChannelStats) => [label, st.firstTouches, st.followUps, st.replies, st.positive, pct(st.replyRate) ?? "under 10 sent", pct(st.positiveRate) ?? "-",
    st.bounceRate == null ? `${st.bounces}` : <span className={st.bounceRate > BOUNCE_ALARM ? "text-red-strong" : undefined}>{pct(st.bounceRate)}</span>];
  // Guest emails go from John's own mailbox, which nothing reads yet: replies, bounces and rates there are not measured.
  const nm = <span className="text-ink-3">not measured</span>;
  const guestRow = [ "Podcast guests (own mailbox)", guest.firstTouches, guest.followUps, nm, nm, nm, nm, nm ];

  return (
    <Shell title="Conversations" active="/pipeline">
      <SalesNav active="/pipeline/conversations" owner={owner} period={period} />
      {desk.error && <SourceNote tone="bad">The writing desk could not be read ({desk.error}).</SourceNote>}

      <Section title="Email" note="writing desk · replies stored hourly from the HQ inbox · positive is your label">
        <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-5">
          <StatTile label="First touches" value={desk.data ? String(totalFor("firstTouches")) : null} missing="not measured" note={`${totalFor("followUps")} follow-ups`} href="/outreach/write" />
          <StatTile label="Replies (clients)" value={desk.data ? String(client.replies) : null} missing="not measured" />
          <StatTile label="Positive replies (clients)" value={desk.data ? String(client.positive) : null} missing="not measured"
            note={client.unlabeled ? `${client.unlabeled} not labeled yet` : "all labeled"} tone={client.unlabeled ? "warn" : undefined} href="/outreach/inbox" />
          <StatTile label="Reply rate (clients)" value={pct(client.replyRate)} missing={`needs 10 first touches (${client.firstTouches} so far)`} note="replied ÷ first touches sent in the period" />
          <StatTile label="Bounce rate (clients)" value={pct(client.bounceRate)} missing={`needs 10 first touches (${client.firstTouches} so far)`} note={`alarm above ${pct(BOUNCE_ALARM)}`}
            tone={client.bounceRate != null && client.bounceRate > BOUNCE_ALARM ? "bad" : undefined} />
        </div>
        <Table head={["Track", "First touches", "Follow-ups", "Replies", "Positive", "Reply rate", "Positive rate", "Bounces"]} align={["l", "r", "r", "r", "r", "r", "r", "r"]}
          rows={[row("Clients (HQ mailbox)", client), guestRow]} />
        <p className="mt-3 text-sm text-ink-3">Guest replies are not measured: guest emails go from your own mailbox, which is not connected (it needs the Google Internal OAuth client). Abe&apos;s own sends and replies are on <Link className="underline" href="/performance/team">Team</Link>.</p>
        <div className="mt-6 grid gap-6 md:grid-cols-2">
          <TrendChart title="First touches a week" unit="emails" summary={`First touches per week over ${WEEKS} weeks`} data={weeks.map((x) => ({ x: x.x, value: x.s.firstTouches }))} />
          <TrendChart title="Replies a week" unit="replies" summary={`Replies per week over ${WEEKS} weeks`} data={weeks.map((x) => ({ x: x.x, value: x.s.replies }))} />
        </div>
      </Section>

      <Section title="LinkedIn" note={lastImport ? `from your export, imported ${lastImport.slice(0, 10)}` : "from your weekly LinkedIn export"}>
        {!lastImport && <SourceNote>No LinkedIn export imported yet. Request it in LinkedIn Settings &gt; Data privacy &gt; Get a copy of your data (connections and messages), then run <code>python3 -m qualification.linkedin_import --emit-supabase &lt;export.zip&gt;</code> in vibrana-crm.</SourceNote>}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
          <StatTile label="Notes sent" value={desk.data ? String(totalFor("linkedinNotes")) : null} missing="not measured" note="from the desk" />
          <StatTile label="Acceptance rate" value={pct(client.acceptRate ?? guest.acceptRate)} missing={`needs 10 notes (${totalFor("linkedinNotes")} so far)`} />
          <StatTile label="New connections" value={li ? String(li.connections) : null} missing="no export yet" note={li ? `${li.icpConnections} in ICP queues` : undefined} />
          <StatTile label="New conversations" value={li ? String(li.conversations) : null} missing="no export yet" note={li ? `${li.inbound} started by them` : undefined} />
          <StatTile label="Two-way with ICP" value={li ? String(li.icpTwoWay) : null} missing="no export yet" note={li ? `${li.twoWay} two-way in all` : undefined} />
        </div>
      </Section>

      <Section title="Website" note="sprint and enterprise inquiry forms">
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <StatTile label="Inquiries" value={inq == null ? null : String(inq)} missing={owner ? "not attributed to a person" : "could not be read"} href="/pipeline/traffic" />
        </div>
      </Section>
    </Shell>
  );
}
