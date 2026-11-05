// Pipeline > Overview (VIB-499): John's $10k/month take-home goal, whether the pipeline can carry it, the reverse funnel
// from the goal back to first touches, this week's leading numbers and what needs action. Definitions: hub
// gtm/strategy/pipeline-metrics.md. The goal is the whole business's; the owner filter narrows deals and activity.
import Link from "next/link";
import { Section, Shell } from "@/components/shell";
import { StatTile } from "@/components/stat-tile";
import { Card } from "@/components/ui/card";
import { SalesNav, pct, per, usd } from "@/components/sales/nav";
import { ActionList, FunnelTable, GoalBar, SourceNote } from "@/components/sales/parts";
import { adminDb } from "@/lib/db";
import { goalView } from "@/lib/sales/economics";
import { loadDeals, loadDesk, loadHistory, loadInquiries, loadLinkedIn, loadMeetings, loadMilestones, loadSettings, ownerOfSender, parseOwner, parsePeriod } from "@/lib/sales/load";
import { deskStats, linkedinStats, meetingStats, needsAction, ownerFilter, pipelineHealth, reachedInWindow, reverseFunnel, windowFor, wonInWindow, type Action, type Window } from "@/lib/sales/metrics";
import { MIN_MEASURED } from "@/lib/sales/settings";
import { RUN_KEY, runProblems } from "@/lib/sales/run";
import { sessionDb } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const maxDuration = 30;
export const metadata = { title: "Pipeline" };

const LINKEDIN_STALE_DAYS = 8;

export default async function PipelineOverview({ searchParams }: { searchParams: Promise<{ owner?: string; period?: string }> }) {
  const sp = await searchParams;
  const owner = parseOwner(sp.owner), period = parsePeriod(sp.period);
  const now = new Date();
  const w = windowFor(period, now);
  const week: Window = { start: new Date(now.getTime() - 7 * 86_400_000), end: now, days: 7 };
  const since = new Date(Math.min(w.start.getTime(), week.start.getTime()));

  const db = await sessionDb();
  const { data: claims } = await db.auth.getClaims();
  const isOwner = (claims?.claims?.app_metadata as { gtm_owner?: boolean } | undefined)?.gtm_owner === true;
  const [{ settings: s, source: settingsSource, problems }, dealRead, milestones, history, desk, linkedin, meetings, inquiries, tracks] = await Promise.all([
    loadSettings(db), loadDeals(), loadMilestones(db), loadHistory(db), loadDesk(db, since), loadLinkedIn(db, since), loadMeetings(since),
    // The site's inquiry table is service-role only: read with the secret key, and only after the owner check above.
    isOwner ? loadInquiries(adminDb(), since) : Promise.resolve({ data: null, error: "not the owner" }),
    db.from("gtm_outreach_tracks").select("track,daily_target"),
  ]);
  const { data: lastRun } = await db.from("gtm_sync_state").select("value").eq("key", RUN_KEY).maybeSingle();
  const cronProblems = runProblems((lastRun?.value ?? null) as Parameters<typeof runProblems>[0], now);

  const allDeals = dealRead.data?.deals ?? [];
  const deals = ownerFilter(owner)(allDeals);
  const ms = milestones.data ?? [];
  const goal = goalView(allDeals, ms, s, now);
  const health = pipelineHealth(deals, s, now, history.data ?? []);
  const ownerOf = ownerOfSender();
  const deskW = desk.data ? deskStats(desk.data, w, ownerOf, owner) : null;
  const deskWeek = desk.data ? deskStats(desk.data, week, ownerOf, owner) : null;
  const li = linkedin.data ? linkedinStats(linkedin.data.connections, linkedin.data.threads, w, owner) : null;
  const liWeek = linkedin.data ? linkedinStats(linkedin.data.connections, linkedin.data.threads, week, owner) : null;
  const mtg = meetings.data?.installed ? meetingStats(meetings.data.meetings, w, now, owner) : null;
  const mtgWeek = meetings.data?.installed ? meetingStats(meetings.data.meetings, week, now, owner) : null;
  const inquiryCount = (win: Window) => (owner ? 0 : (inquiries.data ?? []).filter((r) => Date.parse(r.created_at) >= win.start.getTime()).length);

  const positive = (d: typeof deskW, l: typeof li, win: Window) => (d && l ? d.positive + l.icpTwoWay + inquiryCount(win) : d ? d.positive + inquiryCount(win) : null);
  const qualifiedIds = reachedInWindow(deals, history.data ?? [], ["QUALIFIED", "PROPOSAL", "SIGNED"], w);
  const proposalsWeek = reachedInWindow(deals, history.data ?? [], ["PROPOSAL"], week).size;
  const posW = positive(deskW, li, w);
  const measuredRate = (hits: number | null, n: number | null) => (hits != null && n != null && n >= MIN_MEASURED ? { value: hits / n, n, measured: true } : undefined);
  // Without a CRM read there are no deal numbers: every deal tile says so instead of showing a zero or a planning rate.
  const ok = !!dealRead.data;
  const noCrm = "not measured: Twenty read failed";
  const steps = reverseFunnel({
    s, health, w,
    actual: { won: ok ? wonInWindow(deals, w).length : null, qualified: ok ? qualifiedIds.size : null, meetings: mtg?.discovery ?? null, positive: posW, touches: deskW?.firstTouches ?? null },
    measured: {
      qualifiedFromMeeting: measuredRate(qualifiedIds.size, mtg?.discovery ?? null),
      meetingFromPositive: measuredRate(mtg?.discovery ?? null, posW),
      positiveFromTouch: measuredRate(deskW?.positive ?? null, deskW?.firstTouches ?? null),
    },
  });

  const extra: Action[] = [];
  if (deskWeek?.unlabeled) extra.push({ key: "unlabeled", tone: "warn", text: `${deskWeek.unlabeled} ${deskWeek.unlabeled === 1 ? "reply" : "replies"} this week not labeled`, detail: "Label them in the inbox so positive conversations count.", href: "/outreach/inbox" });
  const lastImport = linkedin.data?.lastImport;
  if (!lastImport || now.getTime() - Date.parse(lastImport) > LINKEDIN_STALE_DAYS * 86_400_000)
    extra.push({ key: "linkedin-export", tone: "warn", text: lastImport ? `LinkedIn export is ${Math.floor((now.getTime() - Date.parse(lastImport)) / 86_400_000)} days old` : "No LinkedIn export imported yet",
      detail: "Request it in LinkedIn Settings > Data privacy > Get a copy of your data, then run the importer (vibrana-crm linkedin_import --emit-supabase)." });
  const actions = needsAction(deals, ms, now, extra);
  const clientTarget = ((tracks.data ?? []) as { track: string; daily_target: number }[]).find((t) => t.track === "client")?.daily_target ?? null;
  const short = goal.projectedThisMonthUsd < s.goalUsd;
  const windowLabel = period === "qtd" ? "quarter to date" : `last ${w.days} days`;

  return (
    <Shell title="Pipeline" active="/pipeline">
      <SalesNav active="/pipeline" owner={owner} period={period} />
      {dealRead.error && <SourceNote tone="bad">Twenty could not be read ({dealRead.error}). Deal numbers below are empty, not zero.</SourceNote>}
      {dealRead.data?.fields === "standard" && <SourceNote>Twenty does not have the pipeline fields yet (owner, source, next step, costs), so owner filters and the action list are incomplete. Run vibrana-crm <code>pipeline_schema.py --apply</code>.</SourceNote>}
      {dealRead.data?.sample && <SourceNote>Sample deals and meetings: this is a demo or preview, not the CRM.</SourceNote>}
      {cronProblems.length > 0 && !dealRead.data?.sample && <SourceNote>Stored numbers may be behind: {cronProblems.join(" ")}</SourceNote>}
      {s.overheadUsd === 0 && s.taxReserve === 0 && <SourceNote>Take-home here is before tax and overhead: both are set to zero. Set them in <Link className="underline" href="/settings#pipeline">Settings</Link> for a true take-home.</SourceNote>}
      {problems.length > 0 && <SourceNote tone="bad">The saved pipeline settings could not be used ({problems.join(" ")}); the defaults are in place.</SourceNote>}

      <Section title="The goal" note={`${usd(s.goalUsd)} a month take-home · whole business${settingsSource === "default" ? " · default assumptions" : ""}`}>
        <Card glow={false} className="mb-4 p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm text-ink-2">Take-home this month, if what is due arrives</p>
            <p className={short ? "text-pl-2xl font-semibold text-amber-strong" : "text-pl-2xl font-semibold text-emerald-strong"}>{usd(goal.projectedThisMonthUsd)}</p>
          </div>
          <GoalBar collected={goal.current.takeHomeUsd} due={goal.projectedThisMonthUsd - goal.current.takeHomeUsd} goal={s.goalUsd} />
          {short && <p className="mt-2 text-sm text-ink-2">Short {usd(goal.gapThisMonthUsd)} this month.</p>}
          {goal.current.unconverted.length > 0 && <p className="mt-2 text-xs text-red-strong">No FX rate for {goal.current.unconverted.join(", ")}; those amounts are left out. Add the rate in Settings.</p>}
        </Card>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <StatTile label="Last 3 months, average" value={usd(goal.trailingAvgUsd)} note={`take-home a month; goal ${usd(s.goalUsd)}`} tone={goal.trailingAvgUsd < s.goalUsd ? "warn" : undefined} />
          <StatTile label="Next month, scheduled" value={usd(goal.nextTakeHomeUsd)} note="unpaid milestones due next month" tone={goal.nextTakeHomeUsd < s.goalUsd ? "warn" : undefined} href="/pipeline/deals#milestones" />
          <StatTile label="Cash collected this month" value={usd(goal.current.cashUsd)} note="gross, before costs" />
          <StatTile label="Signed this month" value={ok ? usd(goal.current.signedUsd) : null} missing={noCrm} note="fee of deals won" />
        </div>
        {!ms.length && <p className="mt-3 text-sm text-ink-3">No payment milestones yet. Take-home counts cash when it arrives: add the deposit and later payments for each won deal on <Link className="underline" href="/pipeline/deals#milestones">Deals</Link>.</p>}
      </Section>

      <Section title="Can the pipeline carry it?" note={`${usd(health.requiredFeeUsd)} of fees a month needed at a ${pct(health.share)} take-home share`}>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
          <StatTile label="Coverage" value={!ok || health.coverage == null ? null : `${health.coverage.toFixed(1)}×`} missing={ok ? "no fees recorded" : noCrm}
            note={`weighted ${usd(health.weightedUsd)} vs ${usd(health.coverageNeedUsd)} (${s.coverageMonths} months)`} tone={health.coverage != null && health.coverage < 1 ? "bad" : health.coverage != null && health.coverage < 2 ? "warn" : undefined} href="/pipeline/deals" />
          <StatTile label="Open qualified deals" value={ok ? String(health.qualifiedCount) : null} missing={noCrm} note={`${health.openCount} open in all${health.unpriced ? `, ${health.unpriced} without a fee` : ""}`} />
          <StatTile label="Win rate" value={ok ? pct(health.winRate.value) : null} missing={noCrm} note={health.winRate.measured ? `won ÷ (won + lost after qualifying), ${health.winRate.n} closed` : `planning rate; ${health.winRate.n} closed after qualifying so far`} />
          <StatTile label="Average won deal" value={ok ? usd(health.avgDealUsd) : null} missing={noCrm} note={health.avgDealMeasured ? "from won deals" : "planning size until 3 won deals have fees"} />
          <StatTile label="Days to close" value={!ok || health.medianCycleDays == null ? null : String(Math.round(health.medianCycleDays))} missing={ok ? "no won deal with a close date" : noCrm} note="median, created to won" />
        </div>
      </Section>

      <Section title="From the goal back to first touches" note={`needed a month at current rates · actual ${windowLabel}, scaled to 30 days`}>
        <FunnelTable steps={steps} windowLabel={windowLabel} />
        <p className="mt-3 text-sm text-ink-3">Positive conversations are email replies you labeled positive, two-way LinkedIn threads with ICP people, and website inquiries. The last row assumes every conversation came from cold email; partners, clients and your network cut it.</p>
      </Section>

      <Section title="This week" note="last 7 days">
        <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
          <StatTile label="Discovery meetings held" value={mtgWeek ? String(mtgWeek.discovery) : null} missing={meetings.error ? "not measured: Twenty read failed" : "not measured: meeting ledger not installed"} href="/pipeline/meetings" />
          <StatTile label="Client meetings held" value={mtgWeek ? String(mtgWeek.client) : null} missing="not measured" href="/pipeline/meetings" />
          <StatTile label="Positive conversations" value={positive(deskWeek, liWeek, week) == null ? null : String(positive(deskWeek, liWeek, week))} missing="not measured: desk could not be read"
            note={deskWeek ? `${deskWeek.positive} email · ${liWeek?.icpTwoWay ?? "?"} LinkedIn · ${inquiryCount(week)} site` : undefined} href="/pipeline/conversations" />
          <StatTile label="Proposals sent" value={ok ? String(proposalsWeek) : null} missing={noCrm} note="deals that reached Proposal" />
          <StatTile label="First touches" value={deskWeek ? String(deskWeek.firstTouches) : null} missing="not measured"
            note={clientTarget ? `client target ${clientTarget * 5} a working week` : undefined} tone={deskWeek && clientTarget && deskWeek.firstTouches < clientTarget * 5 ? "warn" : undefined} href="/outreach/write" />
        </div>
      </Section>

      <Section title="Needs action" note={`${actions.length} ${actions.length === 1 ? "item" : "items"}`}>
        <ActionList actions={actions} />
      </Section>

      <Section title="Not measured on purpose">
        <ul className="list-disc space-y-1 pl-5 text-sm text-ink-2">
          <li>Email opens: there is no tracking pixel. Apple Mail Privacy Protection inflates opens, and pixels hurt deliverability. Replies are the signal.</li>
          <li>Page views, followers and connection totals are context, not goals. Content performance stays in <Link className="underline" href="/performance">Performance</Link>.</li>
          <li>Planning rates give way to measured ones at {MIN_MEASURED} data points. Assumptions are editable in <Link className="underline" href="/settings#pipeline">Settings</Link>. Definitions: hub <code>gtm/strategy/pipeline-metrics.md</code>.</li>
        </ul>
        <p className="mt-3 text-xs text-ink-3">{per(steps[0].requiredPerMonth)} deals a month at {usd(health.avgDealUsd)} each covers the goal.</p>
      </Section>
    </Shell>
  );
}
