// Pipeline > Conversations: outreach that turns into conversations. Email from the writing desk (first touches,
// follow-ups, replies and John's positive label, per track), John's own network week by week and tier by tier (VIB-522),
// LinkedIn from the weekly export, and website inquiries. No opens: there is no tracking pixel.
import Link from "next/link";
import { Section, Shell, Table } from "@/components/shell";
import { StatTile } from "@/components/stat-tile";
import { TrendChart } from "@/components/performance/trend-chart";
import { SalesNav, pct } from "@/components/sales/nav";
import { SourceNote } from "@/components/sales/parts";
import { adminDb } from "@/lib/db";
import { loadDesk, loadInquiries, loadLinkedIn, loadNetworkTiers, ownerOfSender, parseOwner, parsePeriod } from "@/lib/sales/load";
import { deskStats, linkedinStats, networkWeekly, windowFor, type ChannelStats, type Window } from "@/lib/sales/metrics";
import { RUN_KEY, type PipelineRun } from "@/lib/sales/run";
import { REPORT_TZ } from "@/lib/reports/week";
import { sessionDb } from "@/lib/supabase/server";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { gmailConfig } from "@/lib/team/mailbox";
import { viewer } from "@/lib/team/connect";
import { NETWORK_OWNER, networkStatus, type NetworkStatus } from "@/lib/outreach/network-mailbox";
import { connectNetworkMailbox, disconnectNetworkMailbox } from "./actions";

export const dynamic = "force-dynamic";
export const maxDuration = 30;
export const metadata = { title: "Conversations" };

const WEEKS = 12;
/** Calendar weeks on the network scoreboard. */
const NETWORK_WEEKS = 6;
// Email contract v1 (VIB-496): alert above 2%. The cohort-based alert over the last 7 days, at any n, runs in email health;
// this tile shows the period rate against the same threshold.
const BOUNCE_ALARM = 0.02;

/** What the network mailbox connection's return (`?network=`) says. */
const NETWORK_STATUS: Record<string, string> = {
  connected: "Network mailbox connected. The pipeline job reads replies and bounces to network desk emails within the hour.",
  disconnected: "Network mailbox disconnected. Network replies are again the ones you mark on the desk.",
  "not-connected": "The network mailbox was not connected.",
  declined: "Google consent was cancelled. Nothing was connected.",
  expired: "The connection request expired or came from another browser. Start again.",
  invalid: "Google sent back an incomplete answer. Start again.",
  "wrong-user": "The signed-in account changed during the connection. Start again from your own login.",
  "wrong-account": "That Google account is not the network desk's mailbox, so it was not connected. Pick the account the network alias belongs to.",
  "scope-missing": "Google did not grant Gmail read access (the box may have been unticked). Start again and allow it.",
  "google-refused": "Google did not grant offline, read-only Gmail access. Start again and accept the permission.",
  "not-configured": "The Google connection is not set up in this deployment (TEAM_GMAIL_CLIENT_ID / TEAM_GMAIL_CLIENT_SECRET).",
  "no-account": "The network desk's account is not configured in this deployment (NETWORK_GMAIL_ACCOUNT, or the JOHN entry in GTM_TEAM_MEMBERS).",
  "not-owner": "Only the network desk's owner can connect its mailbox.",
  env: "The network mailbox is already set in the deployment settings (NETWORK_GMAIL_*), which take precedence.",
  "save-failed": "The connection could not be saved. Try again.",
  busy: "Another Google connection change was in progress. Start again in a moment.",
  "disconnect-failed": "The network mailbox could not be disconnected. Try again.",
};

export default async function Conversations({ searchParams }: { searchParams: Promise<{ owner?: string; period?: string; network?: string }> }) {
  const sp = await searchParams;
  const owner = parseOwner(sp.owner), period = parsePeriod(sp.period);
  const now = new Date();
  const w = windowFor(period, now);
  const trendStart = new Date(now.getTime() - WEEKS * 7 * 86_400_000);
  const since = new Date(Math.min(w.start.getTime(), trendStart.getTime()));
  const db = await sessionDb();
  const { data: claims } = await db.auth.getClaims();
  const isOwner = (claims?.claims?.app_metadata as { gtm_owner?: boolean } | undefined)?.gtm_owner === true;
  // The network scoreboard reaches back NETWORK_WEEKS calendar weeks (one more day covers the time zone).
  const networkSince = new Date(now.getTime() - (NETWORK_WEEKS * 7 + 1) * 86_400_000);
  const v = isOwner ? await viewer() : null;
  // The connection's status is a service-role read (its table is closed to every session), so only for the signed-in owner.
  const netStatus: NetworkStatus | null = isOwner ? await networkStatus(adminDb()).catch(() => ({ source: "error" as const, message: "The network mailbox connection could not be read." })) : null;
  const [desk, linkedin, inquiries, tiers, lastRun] = await Promise.all([
    loadDesk(db, new Date(Math.min(since.getTime(), networkSince.getTime()))), loadLinkedIn(db, since),
    isOwner && !owner ? loadInquiries(adminDb(), since) : Promise.resolve({ data: null, error: owner ? "inquiries are not attributed to a person" : "not the owner" }),
    loadNetworkTiers(db),
    db.from("gtm_sync_state").select("value").eq("key", RUN_KEY).maybeSingle().then((r) => (r.data?.value ?? null) as { result?: PipelineRun } | null, () => null),
  ]);
  // Whether the hourly job read the network mailbox on its last run: until it does, network email replies are only the ones
  // marked on the desk, and bounces are not measured.
  const netRun = lastRun?.result?.networkOutcomes;
  const networkMailbox = !!netRun && typeof netRun === "object" && !netRun.skipped;
  const ownerOf = ownerOfSender();
  const rows = desk.data ?? [];
  const tz = REPORT_TZ();
  const networkWeeks = desk.data ? networkWeekly(rows, (p) => (p ? tiers.data?.get(p) ?? null : null), { tz, weeks: NETWORK_WEEKS, now, ownerOf: ownerOfSender(), owner }) : null;
  const client = deskStats(rows, w, ownerOf, owner, "client"), guest = deskStats(rows, w, ownerOf, owner, "guest"), network = deskStats(rows, w, ownerOf, owner, "network");
  const li = linkedin.data ? linkedinStats(linkedin.data.connections, linkedin.data.threads, w, owner) : null;
  const inq = inquiries.data ? inquiries.data.filter((r) => Date.parse(r.created_at) >= w.start.getTime()).length : null;
  const weeks = Array.from({ length: WEEKS }, (_, i) => {
    const end = new Date(now.getTime() - (WEEKS - 1 - i) * 7 * 86_400_000);
    const win: Window = { start: new Date(end.getTime() - 7 * 86_400_000), end, days: 7 };
    return { x: end.toISOString().slice(5, 10), s: deskStats(rows, win, ownerOf, owner) };
  });
  const totalFor = (k: keyof ChannelStats) => (client[k] as number) + (guest[k] as number) + (network[k] as number);
  const lastImport = linkedin.data?.lastImport;
  const row = (label: string, st: ChannelStats) => [label, st.firstTouches, st.followUps, st.replies, st.positive, pct(st.replyRate) ?? "under 10 sent", pct(st.positiveRate) ?? "-",
    st.bounceRate == null ? `${st.bounces}` : <span className={st.bounceRate > BOUNCE_ALARM ? "text-red-strong" : undefined}>{pct(st.bounceRate)}</span>];
  // Guest and network emails go from John's own mailboxes, which nothing reads yet: replies, bounces and rates there are not measured.
  const nm = <span className="text-ink-3">not measured</span>;
  const guestRow = [ "Podcast guests (own mailbox)", guest.firstTouches, guest.followUps, nm, nm, nm, nm, nm ];
  // Network email replies are counted (the desk's Mark replied, and the mailbox sync once connected); rates stay unmeasured.
  const networkRow = [ "Own network (own mailbox)", network.firstTouches, network.followUps, network.replies, nm, nm, nm, networkMailbox ? network.bounces : nm ];

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
          rows={[row("Clients (HQ mailbox)", client), guestRow, networkRow]} />
        <p className="mt-3 text-sm text-ink-3">Guest replies are not measured: those emails go from your own mailbox, which is not connected. Network replies are {networkMailbox ? "read hourly from the network mailbox, plus any you mark on the desk" : "the ones you mark replied on the desk; the network mailbox is not connected (connect it under Own network below)"}. Abe&apos;s own sends and replies are on <Link className="underline" href="/performance/team">Team</Link>.</p>
        <div className="mt-6 grid gap-6 md:grid-cols-2">
          <TrendChart title="First touches a week" unit="emails" summary={`First touches per week over ${WEEKS} weeks`} data={weeks.map((x) => ({ x: x.x, value: x.s.firstTouches }))} />
          <TrendChart title="Replies a week" unit="replies" summary={`Replies per week over ${WEEKS} weeks`} data={weeks.map((x) => ({ x: x.x, value: x.s.replies }))} />
        </div>
      </Section>

      <Section title="Own network" note={`by week and warm tier · ${networkMailbox ? "email replies and bounces from the network mailbox and your marks" : "replies are the ones you mark on the desk"}`}>
        {sp.network && NETWORK_STATUS[sp.network] && <Card glow={false} className="mb-4 p-4 text-sm text-ink-2" role="status">{NETWORK_STATUS[sp.network]}</Card>}
        {netStatus && <NetworkMailbox status={netStatus} canConnect={v?.member?.code === NETWORK_OWNER} configured={!!gmailConfig()} />}
        {tiers.error && <SourceNote tone="bad">The network tiers could not be read ({tiers.error}); every person shows as No tier.</SourceNote>}
        <div data-testid="network-scoreboard">
          <Table head={["Week of", "Tier", "Email notes", "LinkedIn notes", "Email replies", "LinkedIn replies", "Follow-ups", "Bounces"]} align={["l", "l", "r", "r", "r", "r", "r", "r"]}
            rows={(networkWeeks ?? []).flatMap((w) => w.tiers.map((t, i) => [
              i === 0 ? weekLabel(w.monday) : "", t.tier, t.emailNotes, t.linkedinNotes, t.emailReplies, t.linkedinReplies, t.followUps, networkMailbox ? t.bounces : nm,
            ]))} />
        </div>
        <p className="mt-3 text-sm text-ink-3">Counts, not rates: each note, reply, follow-up and bounce in the week it happened (Monday to Sunday, {tz}). LinkedIn replies are the ones you mark on the desk; LinkedIn has no API. The tier is the one on the person&apos;s dossier.</p>
      </Section>

      <Section title="LinkedIn" note={lastImport ? `from your export, imported ${lastImport.slice(0, 10)}` : "from your weekly LinkedIn export"}>
        {!lastImport && <SourceNote>No LinkedIn export imported yet. Request it in LinkedIn Settings &gt; Data privacy &gt; Get a copy of your data (connections and messages), then run <code>python3 -m qualification.linkedin_import --emit-supabase &lt;export.zip&gt;</code> in vibrana-crm.</SourceNote>}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
          <StatTile label="Notes sent" value={desk.data ? String(totalFor("linkedinNotes")) : null} missing="not measured" note="from the desk" />
          <StatTile label="Acceptance rate" value={pct(client.acceptRate ?? guest.acceptRate ?? network.acceptRate)} missing={`needs 10 notes (${totalFor("linkedinNotes")} so far)`} />
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

/** The network mailbox's connection: connected as, reconnect, or connect. Only the network desk's owner sees the buttons. */
function NetworkMailbox({ status, canConnect, configured }: { status: NetworkStatus; canConnect: boolean; configured: boolean }) {
  const utc = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;
  const connect = (label: string) => (canConnect && configured
    ? <form action={connectNetworkMailbox}><Button type="submit">{label}</Button></form> : null);
  return (
    <Card glow={false} className="mb-4 p-4 text-sm text-ink-2" data-testid="network-mailbox">
      {status.source === "env" && <p>Network mailbox: set in the deployment settings (NETWORK_GMAIL_*). Replies and bounces are read hourly.</p>}
      {status.source === "error" && <p className="text-red-strong">{status.message}</p>}
      {status.source === "none" && (
        <div className="space-y-3">
          <p>Network mailbox: not connected. Connect the Google account the network alias belongs to, and the pipeline job reads replies and bounces to network desk emails every hour (Gmail read-only; it never sends, changes or deletes mail, and stores no text).</p>
          {connect("Connect network mailbox")}
        </div>
      )}
      {status.source === "stored" && (
        <div className="space-y-3">
          <p>Network mailbox: connected as <span className="font-medium text-ink">{status.address}</span> on {status.connectedAt.slice(0, 10)}. {status.lastSyncAt ? `Last read ${utc(status.lastSyncAt)}.` : "Not read yet: the pipeline job runs hourly."}</p>
          {status.reconnect && <p className="text-red-strong">Google no longer accepts this connection, so replies are not being read. Reconnect it.</p>}
          {status.expectedMismatch && <p className="text-red-strong">This is not the account configured for the network desk, so it is not read. Reconnect with the right account.</p>}
          {status.lastError && !status.reconnect && <p className="text-red-strong">Last read failed: {status.lastError}</p>}
          <div className="flex gap-3">
            {connect(status.reconnect || status.expectedMismatch ? "Reconnect network mailbox" : "Reconnect")}
            {canConnect && <form action={disconnectNetworkMailbox}><Button type="submit" variant="secondary">Disconnect</Button></form>}
          </div>
        </div>
      )}
      {!configured && status.source !== "env" && <p className="mt-2 text-ink-3">{NETWORK_STATUS["not-configured"]}</p>}
    </Card>
  );
}

/** "Nov 9" for the Monday a week starts on. */
const weekLabel = (monday: string) => new Date(`${monday}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
