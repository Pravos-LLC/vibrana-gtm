// Pipeline > Deals: every opportunity by stage with owner, source and next step; what each deal is worth to John; the
// payment milestones take-home is computed from; where deals come from and why they are lost. Below that, the CRM's own
// health (the page that used to be /funnel): people funnel, conversations, meeting capture and enrichment runs.
import { Bar, Section, Shell, Table, fmt } from "@/components/shell";
import { StatTile } from "@/components/stat-tile";
import { Card } from "@/components/ui/card";
import { ConversationList, CrmError, TwentyLink } from "@/components/crm/people";
import { MeetingCaptureSection } from "@/components/meeting-capture";
import { SalesDealBoard } from "@/components/sales/deal-board";
import { MilestoneEditor } from "@/components/sales/milestones";
import { SalesNav, native, pct, usd } from "@/components/sales/nav";
import { SourceNote } from "@/components/sales/parts";
import { pickCapture, withDeadline, type CaptureHealth } from "@/lib/meeting-capture";
import { LOST_LABELS, SOURCE_LABELS, type Source } from "@/lib/sales/deals";
import { takeHomeShare, toUsd } from "@/lib/sales/economics";
import { loadDeals, loadHistory, loadMilestones, loadSettings, parseOwner, parsePeriod } from "@/lib/sales/load";
import { isOpen, ownerFilter, pipelineHealth } from "@/lib/sales/metrics";
import { sessionDb } from "@/lib/supabase/server";
import { FUNNEL_STEPS, PAGE_TIMEOUT, captureHealth, crmRead, recentConversations } from "@/lib/twenty";
import { addMilestone, deleteMilestone, markMilestone } from "../actions";

export const dynamic = "force-dynamic";
export const maxDuration = 30;
export const metadata = { title: "Deals" };

const STAGES = ["IDENTIFIED", "CONTACTED", "QUALIFIED", "PROPOSAL", "SIGNED", "LOST"];

export default async function Deals({ searchParams }: { searchParams: Promise<{ owner?: string; period?: string }> }) {
  const sp = await searchParams;
  const owner = parseOwner(sp.owner), period = parsePeriod(sp.period);
  const now = new Date();
  const db = await sessionDb();
  const [{ settings: s }, dealRead, milestones, history, { data: snaps }, { data: runs }, people, liveCapture] = await Promise.all([
    loadSettings(db), loadDeals(), loadMilestones(db), loadHistory(db),
    db.from("gtm_crm_snapshots").select("*").order("date"),
    db.from("gtm_enrichment_runs").select("*").order("at", { ascending: false }),
    crmRead(() => recentConversations(20)),
    // Short per-query timeout plus an overall deadline: a slow Twenty falls back to the snapshot instead of a 504.
    crmRead(() => withDeadline(captureHealth(new Date(), PAGE_TIMEOUT), 8_000)),
  ]);
  const all = dealRead.data?.deals ?? [];
  const deals = ownerFilter(owner)(all);
  const ms = milestones.data ?? [];
  const health = pipelineHealth(deals, s, now, history.data ?? []);
  const lost = deals.filter((d) => d.stage === "LOST");
  const lostReasons = Object.entries(lost.reduce<Record<string, number>>((a, d) => { const k = d.lostReason ?? "not recorded"; a[k] = (a[k] ?? 0) + 1; return a; }, {})).sort((a, b) => b[1] - a[1]);
  const byId = new Map(all.map((d) => [d.id, d]));

  const snapsAll = (snaps ?? []) as { date: string; captured_at: string; metrics: Record<string, number>; opportunities: Record<string, number> }[];
  const latest = snapsAll.at(-1);
  const m = latest?.metrics ?? {};
  const snapCapture = (m as unknown as { meeting_capture?: CaptureHealth }).meeting_capture;
  const { health: capture, live } = pickCapture(liveCapture.data, snapCapture);
  const captureAt = live ? new Date().toISOString() : latest?.captured_at;
  const week = snapsAll.find((x) => x.date >= new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10));
  const delta = (k: string) => (week && latest && week !== latest ? m[k] - (week.metrics[k] ?? 0) : null);

  return (
    <Shell title="Deals" active="/pipeline" updated={latest?.captured_at}>
      <SalesNav active="/pipeline/deals" owner={owner} period={period} />
      {dealRead.error && <SourceNote tone="bad">Twenty could not be read ({dealRead.error}). The board below shows the last daily snapshot.</SourceNote>}
      {dealRead.data?.fields === "standard" && <SourceNote>Twenty does not have the pipeline fields yet, so owner, source, partner, costs and next steps are blank.</SourceNote>}
      {dealRead.data?.sample && <SourceNote>Sample deals: this is a demo or preview, not the CRM.</SourceNote>}

      <div className="mb-10 grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatTile label="Open pipeline" value={usd(deals.filter(isOpen).reduce((a, d) => a + (toUsd(d.fee, s.fx) ?? 0), 0))} missing="no deals read" note={`${health.openCount} open deals`} />
        <StatTile label="Weighted pipeline" value={usd(health.weightedUsd)} note="fee × stage weight" />
        <StatTile label="Win rate" value={pct(health.winRate.value)} note={health.winRate.measured ? `${health.winRate.n} closed` : "planning rate"} />
        <StatTile label="Lost" value={String(lost.length)} note={lostReasons[0] ? `most often: ${LOST_LABELS[lostReasons[0][0]] ?? lostReasons[0][0]}` : undefined} />
      </div>

      <Section title="Opportunities" note={dealRead.data ? (dealRead.data.sample ? "sample" : "live from Twenty") : "daily snapshot"}>
        {dealRead.data ? <SalesDealBoard deals={deals} fx={s.fx} now={now} /> : (
          <div className="grid grid-cols-3 gap-4 md:grid-cols-6">
            {STAGES.map((st) => <StatTile key={st} label={st.toLowerCase()} value={latest ? String(latest.opportunities?.[st] ?? 0) : null} missing="no CRM snapshot yet" />)}
          </div>
        )}
      </Section>

      <Section title="What each deal is worth to John" note="fee − delivery cost − referral fee, in USD at the planning rates">
        <Table head={["Deal", "Stage", "Fee", "Costs", "Take-home share", "Take-home", "Source"]} align={["l", "l", "r", "r", "r", "r", "l"]}
          rows={deals.filter((d) => d.stage !== "LOST" && d.fee).map((d) => {
            const fee = toUsd(d.fee, s.fx), share = takeHomeShare(d, s.fx);
            const costs = [d.deliveryCost, d.referralFee].filter(Boolean).map((c) => native(c)).join(" + ");
            return [d.name, d.stage.toLowerCase(), native(d.fee), costs || "none recorded", pct(share), usd(fee == null ? null : fee * share) ?? "no FX rate", d.source ? SOURCE_LABELS[d.source] : "not set"];
          })} />
      </Section>

      <section id="milestones" className="mb-12 scroll-mt-20">
        <div className="mb-4 flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
          <h2 className="font-display text-pl-lg font-semibold tracking-tight text-ink">Payment milestones</h2>
          <span className="text-xs text-ink-3">take-home counts cash when it arrives; only signed deals count as scheduled</span>
        </div>
        {milestones.error && <SourceNote tone="bad">Milestones could not be read ({milestones.error}).</SourceNote>}
        <MilestoneEditor
          deals={all.filter((d) => d.stage !== "LOST").map((d) => ({ id: d.id, name: d.name, currency: d.fee?.currency ?? null, stage: d.stage }))}
          rows={ms.filter((x) => !owner || byId.get(x.opportunity_id)?.owner === owner).map((x) => ({ ...x, dealName: byId.get(x.opportunity_id)?.name ?? "Deal not in Twenty", stage: byId.get(x.opportunity_id)?.stage ?? "UNKNOWN" }))}
          add={addMilestone} mark={markMilestone} remove={deleteMilestone} />
      </section>

      <div className="mb-12 grid gap-8 lg:grid-cols-2">
        <Section title="Where deals come from" note="open and won, by originating source">
          <Table head={["Source", "Open", "Open value", "Won", "Won value"]} align={["l", "r", "r", "r", "r"]}
            rows={health.bySource.map((r) => [r.source === "UNSET" ? "Not set" : SOURCE_LABELS[r.source as Source], r.open, usd(r.openUsd), r.won, usd(r.wonUsd)])} />
        </Section>
        <Section title="Why deals are lost">
          <Table head={["Reason", "Deals"]} align={["l", "r"]} rows={lostReasons.map(([k, n]) => [LOST_LABELS[k] ?? k, n])} />
        </Section>
      </div>

      <h2 className="mb-6 mt-4 border-t border-line pt-8 font-display text-pl-xl font-semibold tracking-tight text-ink">CRM health</h2>
      <div className="mb-10 grid grid-cols-2 gap-4 md:grid-cols-4">
        {(["enrichment_attempted", "enriched", "contacted", "warm"] as const).map((k) => {
          const d = delta(k);
          return <StatTile key={k} label={FUNNEL_STEPS.find((x) => x.key === k)!.label} value={m[k] == null ? null : fmt(m[k])} missing="no CRM snapshot yet"
            delta={d == null ? null : { value: d, label: "this week", goodWhen: "up" }} spark={snapsAll.length > 1 ? snapsAll.map((x) => x.metrics[k] ?? 0).slice(-8) : undefined} />;
        })}
      </div>
      <section className="mb-12">
        <div className="mb-4 flex items-baseline justify-between gap-4">
          <h2 className="font-display text-pl-lg font-semibold tracking-tight text-ink">In conversation</h2>
          <TwentyLink path="/objects/people" />
        </div>
        <Card glow={false} className="px-4 py-1">
          {people.error ? <div className="py-3"><CrmError message={people.error} /></div> : <ConversationList contacts={people.data ?? []} />}
        </Card>
      </section>
      <Section title="CRM funnel (Twenty)" note={`${fmt(m.companies)} companies`}>
        {FUNNEL_STEPS.map((x) => <Bar key={x.key} label={x.label} value={m[x.key] ?? 0} max={m.people ?? 1} />)}
        <p className="mt-3 text-sm text-ink-3">&quot;Contacted&quot; counts people with <code>lastContactedAt</code>, which the hourly pipeline cron sets for every desk email that went out (a failing write-back shows on Overview).</p>
      </Section>
      <MeetingCaptureSection health={capture} capturedAt={captureAt} live={live} />
      <Section title="Enrichment runs" note="pushed from the local qualification ledger">
        <Table head={["Run", "Status", "Selected", "Submitted", "Returned", "No result", "Saved", "Credits", "Updated"]} align={["l", "l", "r", "r", "r", "r", "r", "r", "l"]}
          rows={(runs ?? []).map((r: Record<string, any>) => [r.run, r.status, fmt(r.selected), fmt(r.submitted), fmt(r.returned), fmt(r.no_result), fmt(r.saved), fmt(r.credits), r.at?.slice(0, 16).replace("T", " ") ?? "-"])} />
      </Section>
    </Shell>
  );
}
