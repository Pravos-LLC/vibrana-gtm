import { StatTile } from "@/components/stat-tile";
import { sessionDb } from "@/lib/supabase/server";
import { Bar, Section, Shell, Table, fmt } from "@/components/shell";
import { FUNNEL_STEPS } from "@/lib/twenty";
import { MeetingCaptureSection } from "@/components/meeting-capture";
import { pickCapture, withDeadline, type CaptureHealth } from "@/lib/meeting-capture";
import { Card } from "@/components/ui/card";
import { ConversationList, CrmError, DealBoard, TwentyLink } from "@/components/crm/people";
import { PAGE_TIMEOUT, captureHealth, crmRead, opportunities, recentConversations } from "@/lib/twenty";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const STAGES = ["IDENTIFIED", "CONTACTED", "QUALIFIED", "PROPOSAL", "SIGNED", "LOST"];

export const metadata = { title: "Funnel" };

export default async function Funnel() {
  const db = await sessionDb();
  const [{ data: snaps }, { data: runs }, people, deals, liveCapture] = await Promise.all([
    db.from("gtm_crm_snapshots").select("*").order("date"),
    db.from("gtm_enrichment_runs").select("*").order("at", { ascending: false }),
    crmRead(() => recentConversations(20)),
    crmRead(() => opportunities()),
    // Short per-query timeout plus an overall deadline: a slow Twenty falls back to the snapshot instead of a 504.
    crmRead(() => withDeadline(captureHealth(new Date(), PAGE_TIMEOUT), 8_000)),
  ]);
  const all = (snaps ?? []) as { date: string; captured_at: string; metrics: Record<string, number>; opportunities: Record<string, number> }[];
  const latest = all.at(-1);
  const week = all.find((s) => s.date >= new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10));
  const m = latest?.metrics ?? {};
  // Stored inside the metrics JSON by syncCrm; absent on snapshots taken before VIB-411.
  // Live from Twenty when it can be read (VIB-427: a daily snapshot let a failure sit unseen); the snapshot is the fallback.
  const snapCapture = (m as unknown as { meeting_capture?: CaptureHealth }).meeting_capture;
  const { health: capture, live } = pickCapture(liveCapture.data, snapCapture);
  const captureAt = live ? new Date().toISOString() : latest?.captured_at;
  const delta = (k: string) => (week && latest && week !== latest ? m[k] - (week.metrics[k] ?? 0) : null);
  const series = (k: string) => all.map((s) => s.metrics[k] ?? 0);

  return (
    <Shell title="CRM" active="/funnel" updated={latest?.captured_at}>
      <div className="mb-10 grid grid-cols-2 gap-4 md:grid-cols-4">
        {(["enrichment_attempted", "enriched", "contacted", "warm"] as const).map((k) => {
          const d = delta(k);
          return (
            <StatTile key={k} label={FUNNEL_STEPS.find((s) => s.key === k)!.label} value={m[k] == null ? null : fmt(m[k])} missing="no CRM snapshot yet"
              delta={d == null ? null : { value: d, label: "this week", goodWhen: "up" }} spark={all.length > 1 ? series(k).slice(-8) : undefined} />
          );
        })}
      </div>

      <Section title="Opportunities" note={deals.data ? "live from Twenty" : "daily snapshot"}>
        {deals.data ? <DealBoard deals={deals.data} withLost /> : (
          <div className="grid grid-cols-3 gap-4 md:grid-cols-6">
            {STAGES.map((st) => (
              <StatTile key={st} label={st.toLowerCase()} value={latest ? String(latest.opportunities?.[st] ?? 0) : null} missing="no CRM snapshot yet" />
            ))}
          </div>
        )}
      </Section>

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
        {FUNNEL_STEPS.map((s) => (
          <Bar key={s.key} label={s.label} value={m[s.key] ?? 0} max={m.people ?? 1} />
        ))}
        {!m.email_messages_synced && (
          <p className="mt-3 text-sm text-ink-3">
            No send source connected: Twenty has 0 synced email messages, so "Contacted" only counts people with <code>lastContactedAt</code> set. Replies and meetings appear once a sending tool or mailbox sync writes to Twenty.
          </p>
        )}
      </Section>


      <MeetingCaptureSection health={capture} capturedAt={captureAt} live={live} />

      <Section title="Enrichment runs" note="pushed from the local qualification ledger">
        <Table
          head={["Run", "Status", "Selected", "Submitted", "Returned", "No result", "Saved", "Credits", "Updated"]}
          align={["l", "l", "r", "r", "r", "r", "r", "r", "l"]}
          rows={(runs ?? []).map((r: any) => [r.run, r.status, fmt(r.selected), fmt(r.submitted), fmt(r.returned), fmt(r.no_result), fmt(r.saved), fmt(r.credits), r.at?.slice(0, 16).replace("T", " ") ?? "-"])}
        />
      </Section>
    </Shell>
  );
}
