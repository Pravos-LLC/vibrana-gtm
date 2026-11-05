// Pipeline > People: John and Abe side by side, on the numbers that move the goal (deals owned, pipeline, wins,
// meetings, conversations), not activity counts. Abe's day-to-day CRM work stays on Analytics > Team.
import Link from "next/link";
import { Section, Shell, Table } from "@/components/shell";
import { SalesNav, usd } from "@/components/sales/nav";
import { SourceNote } from "@/components/sales/parts";
import type { Owner } from "@/lib/sales/deals";
import { toUsd } from "@/lib/sales/economics";
import { loadDeals, loadDesk, loadLinkedIn, loadMeetings, loadSettings, ownerOfSender, parsePeriod } from "@/lib/sales/load";
import { deskStats, isOpen, linkedinStats, meetingStats, ownerFilter, pipelineHealth, windowFor, wonInWindow } from "@/lib/sales/metrics";
import { sessionDb } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const maxDuration = 30;
export const metadata = { title: "People" };

const PEOPLE: { code: Owner; label: string }[] = [{ code: "JOHN", label: "John" }, { code: "ABE", label: "Abe" }];

export default async function People({ searchParams }: { searchParams: Promise<{ owner?: string; period?: string }> }) {
  const sp = await searchParams;
  const period = parsePeriod(sp.period);
  const now = new Date();
  const w = windowFor(period, now);
  const db = await sessionDb();
  const [{ settings: s }, dealRead, desk, linkedin, meetings] = await Promise.all([loadSettings(db), loadDeals(), loadDesk(db, w.start), loadLinkedIn(db, w.start), loadMeetings(w.start)]);
  const deals = dealRead.data?.deals ?? [];
  const ownerOf = ownerOfSender();
  const col = (code: Owner) => {
    const mine = ownerFilter(code)(deals);
    const h = pipelineHealth(mine, s, now);
    const won = wonInWindow(mine, w);
    const d = desk.data ? deskStats(desk.data, w, ownerOf, code) : null;
    const li = linkedin.data ? linkedinStats(linkedin.data.connections, linkedin.data.threads, w, code) : null;
    const m = meetings.data?.installed ? meetingStats(meetings.data.meetings, w, now, code) : null;
    return {
      open: mine.filter(isOpen).length, openUsd: mine.filter(isOpen).reduce((a, x) => a + (toUsd(x.fee, s.fx) ?? 0), 0), weighted: h.weightedUsd,
      won: won.length, wonUsd: won.reduce((a, x) => a + (toUsd(x.fee, s.fx) ?? 0), 0),
      discovery: m?.discovery ?? null, client: m?.client ?? null,
      touches: d?.firstTouches ?? null, replies: d?.replies ?? null, positive: d?.positive ?? null, liTwoWay: li?.twoWay ?? null,
    };
  };
  const cols = PEOPLE.map((p) => ({ ...p, v: col(p.code) }));
  const unassigned = deals.filter((d) => isOpen(d) && !d.owner);
  const n = (x: number | null) => (x == null ? "not measured" : x.toLocaleString("en-US"));
  const rows: [string, (v: ReturnType<typeof col>) => React.ReactNode][] = [
    ["Open deals", (v) => v.open], ["Open pipeline", (v) => usd(v.openUsd)], ["Weighted pipeline", (v) => usd(v.weighted)],
    ["Deals won in the period", (v) => v.won], ["Won value", (v) => usd(v.wonUsd)],
    ["Discovery meetings held", (v) => n(v.discovery)], ["Client meetings held", (v) => n(v.client)],
    ["First touches", (v) => n(v.touches)], ["Email replies", (v) => n(v.replies)], ["Positive replies", (v) => n(v.positive)], ["Two-way LinkedIn threads", (v) => n(v.liTwoWay)],
  ];
  return (
    <Shell title="People" active="/pipeline">
      <SalesNav active="/pipeline/people" owner={null} period={period} showOwner={false} />
      {dealRead.error && <SourceNote tone="bad">Twenty could not be read ({dealRead.error}).</SourceNote>}
      {dealRead.data?.fields === "standard" && <SourceNote>Twenty does not have the opportunity owner field yet, so every deal shows as unassigned.</SourceNote>}
      <Section title="Who is moving the pipeline" note="deals by oppOwner · meetings by owner · emails by who sent them">
        <Table head={["", ...cols.map((c) => c.label)]} align={["l", ...cols.map(() => "r" as const)]} rows={rows.map(([label, f]) => [label, ...cols.map((c) => f(c.v))])} />
      </Section>
      {unassigned.length > 0 && (
        <Section title="Open deals with no owner" note={`${unassigned.length}`}>
          <Table head={["Deal", "Stage"]} rows={unassigned.map((d) => [<a key={d.id} href={d.url} target="_blank" rel="noreferrer" className="hover:underline">{d.name}</a>, d.stage.toLowerCase()])} />
        </Section>
      )}
      <p className="text-sm text-ink-3">Abe&apos;s CRM activity (contacts added, research notes, his mailbox) is on <Link className="underline" href="/performance/team">Analytics &gt; Team</Link>.</p>
    </Shell>
  );
}
