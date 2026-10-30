import { redirect } from "next/navigation";
import { Section, Shell, Table } from "@/components/shell";
import { StatTile } from "@/components/stat-tile";
import { adminDb } from "@/lib/db";
import { DOOR_LABELS, loadFrontDoors, type FrontDoorWeek } from "@/lib/front-doors";
import { todayIn } from "@/lib/posts-db";
import { sessionDb } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const WEEKS = 8;

const judge = (w: FrontDoorWeek) => (w.quality.meanJudge == null ? "none" : `${w.quality.meanJudge.toFixed(2)} / 5`);

export const metadata = { title: "Front doors" };

/**
 * Front doors: the weekly funnel for the AI Readiness and EU AI Act Readiness assessments, the ROI calculator and the Sprint page
 * (hub gtm/programs/ai-readiness/plan.md §8). Counts come from the site's tables (lib/front-doors.ts).
 */
export default async function FrontDoors() {
  const session = await sessionDb();
  const { data: claims } = await session.auth.getClaims();
  // The site's lead tables are service-role only, so the owner claim is checked here before the secret-key read.
  if ((claims?.claims?.app_metadata as { gtm_owner?: boolean } | undefined)?.gtm_owner !== true) redirect("/login");

  const report = await loadFrontDoors(adminDb(), { today: todayIn("UTC"), weeks: WEEKS });
  const [now, prev] = report.weeks;
  const oldestFirst = [...report.weeks].reverse();
  const spark = (pick: (w: FrontDoorWeek) => number | null) => oldestFirst.map(pick);
  const delta = (pick: (w: FrontDoorWeek) => number) => ({ value: pick(now) - pick(prev), label: "vs last week", goodWhen: "up" as const });

  const doorRows = report.weeks.flatMap((w) =>
    report.active
      .filter((d) => Object.values(w.doors[d]).some((n) => n > 0))
      .map((d) => [w.week, DOOR_LABELS[d], w.doors[d].completions, w.doors[d].euAssessments, w.doors[d].roiLeads, w.doors[d].sprintInquiries, w.doors[d].callClicks]),
  );

  return (
    <Shell title="Front doors" active="/front-doors">
      {report.errors.map((e) => (
        <p key={e.table} className="mb-4 text-sm text-red-strong">Could not read {e.table}: {e.error}. Its counts show as 0.</p>
      ))}
      <div className="mb-10 grid grid-cols-2 gap-4 md:grid-cols-4 xl:grid-cols-7">
        <StatTile label="Assessments completed" value={String(now.total.completions)} note={`week ${now.week}`} delta={delta((w) => w.total.completions)} spark={spark((w) => w.total.completions)} />
        <StatTile label="EU AI Act assessments" value={String(now.total.euAssessments)} note="/eu-ai-act-readiness" delta={delta((w) => w.total.euAssessments)} spark={spark((w) => w.total.euAssessments)} />
        <StatTile label="ROI calculator leads" value={String(now.total.roiLeads)} note="estimates emailed" delta={delta((w) => w.total.roiLeads)} spark={spark((w) => w.total.roiLeads)} />
        <StatTile label="Sprint requests" value={String(now.total.sprintInquiries)} note="fit-call form" delta={delta((w) => w.total.sprintInquiries)} spark={spark((w) => w.total.sprintInquiries)} />
        <StatTile label="Call clicks" value={String(now.total.callClicks)} note="clicks, not bookings" delta={delta((w) => w.total.callClicks)} spark={spark((w) => w.total.callClicks)} />
        <StatTile label="Report quality" value={now.quality.meanJudge == null ? null : now.quality.meanJudge.toFixed(2)} missing="no judged reports this week"
          note={`${now.quality.stored} stored, ${now.quality.failed} failed`} spark={spark((w) => w.quality.meanJudge)} />
        <StatTile label="Unsubscribes" value={String(now.unsubscribes)} note="follow-up emails" delta={{ ...delta((w) => w.unsubscribes), goodWhen: "down" }} spark={spark((w) => w.unsubscribes)} />
      </div>

      <Section title="Week by week" note={`last ${WEEKS} ISO weeks, newest first`}>
        <Table
          head={["Week", "Assessments", "EU AI Act", "ROI leads", "Sprint requests", "Call clicks", "Unsubscribes", "Analyses stored", "Analyses failed", "Mean judge"]}
          align={["l", "r", "r", "r", "r", "r", "r", "r", "r", "r"]}
          rows={report.weeks.map((w) => [w.week, w.total.completions, w.total.euAssessments, w.total.roiLeads, w.total.sprintInquiries, w.total.callClicks, w.unsubscribes, w.quality.stored, w.quality.failed, judge(w)])}
        />
      </Section>

      <Section title="By front door" note="weeks and doors with any count">
        <Table head={["Week", "Front door", "Assessments", "EU AI Act", "ROI leads", "Sprint requests", "Call clicks"]} align={["l", "l", "r", "r", "r", "r", "r"]} rows={doorRows} />
      </Section>

      <Section title="What these numbers are">
        <ul className="list-disc space-y-1 pl-5 text-sm text-ink-2">
          {report.notes.map((n) => <li key={n}>{n}</li>)}
          <li>Report quality is the mean of each assessment&apos;s final judge score (1 to 5) from its stored analysis record; &quot;failed&quot; reports went out without a written analysis.</li>
          <li>Definitions and every event: brand.example.com <code>docs/funnel-measurement.md</code>. Terminal: <code>gtm front-doors [--weeks N] [--json]</code>.</li>
        </ul>
      </Section>
    </Shell>
  );
}
