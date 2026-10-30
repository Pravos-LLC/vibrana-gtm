// Front doors: the weekly funnel for the AI Readiness, EU AI Act Readiness and Build Sprint funnels (hub
// gtm/programs/ai-readiness/plan.md §8, Workstream G). Counted from the site's own tables in the
// brand.example.com Supabase project, never from Vercel Analytics. What each column means and what the site
// cannot see: brand.example.com docs/funnel-measurement.md.
//
// Read with the secret key (the site's lead tables are service-role only); the page checks the owner
// claim first. Only non-personal columns are selected: timestamps, front door, event, pipeline meta. Pages are
// ordered by timestamp then the primary key, so equal timestamps never straddle a page boundary twice.
import type { SupabaseClient } from "@supabase/supabase-js";
import { addDays, isoWeek, mondayOf } from "./week";

/** The site's front doors (brand.example.com src/lib/funnel/entry.ts), plus rows saved before the site recorded one. */
export const DOORS = ["landing", "eu-ai-act", "video", "roi", "sprint", "email", "simulator", "direct", "unknown"] as const;
export type Door = (typeof DOORS)[number];

export const DOOR_LABELS: Record<Door, string> = {
  landing: "Readiness page",
  "eu-ai-act": "EU AI Act page",
  video: "Social video",
  roi: "ROI calculator",
  sprint: "Sprint page",
  email: "Email",
  simulator: "Simulator",
  direct: "Direct",
  unknown: "Not recorded",
};

/** `completions` are AI Readiness assessments; `euAssessments` are EU AI Act Readiness ones (assessment_type). */
export type DoorCounts = { completions: number; euAssessments: number; roiLeads: number; sprintInquiries: number; callClicks: number };
export type Quality = {
  /** Assessments whose written analysis passed the checks and the judge. */
  stored: number;
  /** Assessments where no analysis passed (the report went out without one). */
  failed: number;
  /** Assessments with no pipeline record (before 2026-10-16, or the pipeline never ran). */
  none: number;
  /** Mean of each assessment's final judge score (1 to 5), over `judged` assessments; null when none. */
  meanJudge: number | null;
  judged: number;
};
export type FrontDoorWeek = {
  /** ISO week label, e.g. "2026-W42". */
  week: string;
  /** Monday, YYYY-MM-DD (UTC). */
  start: string;
  doors: Record<Door, DoorCounts>;
  total: DoorCounts;
  unsubscribes: number;
  quality: Quality;
};
export type FrontDoorReport = {
  weeks: FrontDoorWeek[];
  /** Front doors with at least one count in the window (the rest are left out of tables). */
  active: Door[];
  /** Tables that could not be read, with the error (e.g. funnel_events before the migration). */
  errors: { table: string; error: string }[];
  /** Fixed caveat: bookings happen on Google Calendar, so a call click is the last step we see. */
  notes: string[];
};

export type AssessmentRow = { created_at: string; entry_point: string | null; analysis_meta: AnalysisMeta | null; assessment_type?: string | null };
type AnalysisMeta = { status?: string; attempts?: { judge?: { overall?: unknown } | null }[] };
export type EventRow = { created_at: string; event: string; entry_point: string };
export type InquiryRow = { created_at: string; entry_point: string | null };
export type OptOutRow = { opted_out_at: string };
export type FrontDoorRows = { assessments: AssessmentRow[]; events: EventRow[]; inquiries: InquiryRow[]; optOuts: OptOutRow[] };

export const NOTES = [
  "Calls are booked on Google Calendar, which reports nothing back: \"call clicks\" count clicks on a Book a call link on the site, not bookings. Links in emails are not counted.",
  "Weeks run Monday to Sunday, UTC. Assessments before 2026-10-16 have no front door recorded (\"Not recorded\").",
];

const door = (v: string | null | undefined): Door => (v && (DOORS as readonly string[]).includes(v) && v !== "unknown" ? (v as Door) : "unknown");
const zero = (): DoorCounts => ({ completions: 0, euAssessments: 0, roiLeads: 0, sprintInquiries: 0, callClicks: 0 });

export function weekLabel(dateIso: string): string {
  const { year, week } = isoWeek(dateIso.slice(0, 10));
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** The final judge score of one assessment's pipeline run: the last attempt that has one. */
export function finalJudge(meta: AnalysisMeta | null | undefined): number | null {
  const attempts = Array.isArray(meta?.attempts) ? meta!.attempts : [];
  for (let i = attempts.length - 1; i >= 0; i--) {
    const o = attempts[i]?.judge?.overall;
    if (typeof o === "number" && Number.isFinite(o)) return o;
  }
  return null;
}

/** Counts per ISO week (newest first) for the `weeks` weeks ending with the week holding `today`. Pure. */
export function buildFrontDoors(rows: FrontDoorRows, opts: { today: string; weeks: number }): Omit<FrontDoorReport, "errors"> {
  const lastMonday = mondayOf(opts.today);
  const starts = Array.from({ length: opts.weeks }, (_, i) => addDays(lastMonday, -7 * i));
  const byStart = new Map<string, FrontDoorWeek & { judges: number[] }>();
  for (const start of starts) {
    byStart.set(start, {
      week: weekLabel(start), start,
      doors: Object.fromEntries(DOORS.map((d) => [d, zero()])) as Record<Door, DoorCounts>,
      total: zero(), unsubscribes: 0,
      quality: { stored: 0, failed: 0, none: 0, meanJudge: null, judged: 0 },
      judges: [],
    });
  }
  const at = (ts: string) => byStart.get(mondayOf(ts.slice(0, 10)));
  const bump = (w: FrontDoorWeek, d: Door, k: keyof DoorCounts) => { w.doors[d][k]++; w.total[k]++; };

  for (const a of rows.assessments) {
    const w = at(a.created_at);
    if (!w) continue;
    // EU AI Act rows (from 2026-10-17) have no written analysis, so they stay out of report quality.
    if (a.assessment_type === "eu-ai-act") {
      bump(w, door(a.entry_point), "euAssessments");
      continue;
    }
    bump(w, door(a.entry_point), "completions");
    const status = a.analysis_meta?.status;
    if (status === "stored") w.quality.stored++;
    else if (status === "failed") w.quality.failed++;
    else w.quality.none++;
    const j = finalJudge(a.analysis_meta);
    if (j != null) w.judges.push(j);
  }
  for (const e of rows.events) {
    const w = at(e.created_at);
    if (!w) continue;
    if (e.event === "call_click") bump(w, door(e.entry_point), "callClicks");
    else if (e.event === "roi_lead") bump(w, door(e.entry_point), "roiLeads");
  }
  for (const q of rows.inquiries) {
    const w = at(q.created_at);
    // A sprint request saved before the site recorded a front door came through the sprint form.
    if (w) bump(w, q.entry_point ? door(q.entry_point) : "sprint", "sprintInquiries");
  }
  for (const o of rows.optOuts) {
    const w = at(o.opted_out_at);
    if (w) w.unsubscribes++;
  }

  const weeks = starts.map((s) => {
    const { judges, ...w } = byStart.get(s)!;
    w.quality.judged = judges.length;
    w.quality.meanJudge = judges.length ? Math.round((judges.reduce((a, b) => a + b, 0) / judges.length) * 100) / 100 : null;
    return w;
  });
  const active = DOORS.filter((d) => weeks.some((w) => Object.values(w.doors[d]).some((n) => n > 0)));
  return { weeks, active, notes: NOTES };
}

const PAGE = 1000;
async function readAll<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return out;
  }
}

/** Reads the window's rows and builds the report. A table that can't be read is reported, the rest still count. */
export async function loadFrontDoors(db: SupabaseClient, opts: { today: string; weeks: number }): Promise<FrontDoorReport> {
  const since = `${addDays(mondayOf(opts.today), -7 * (opts.weeks - 1))}T00:00:00Z`;
  const errors: FrontDoorReport["errors"] = [];
  const read = async <T>(table: string, build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> => {
    try {
      return await readAll(build);
    } catch (e) {
      errors.push({ table, error: (e as Error).message });
      return [];
    }
  };
  const [assessments, events, inquiries, optOuts] = await Promise.all([
    read<AssessmentRow>("assessments", (f, t) => db.from("assessments").select("created_at, entry_point, analysis_meta, assessment_type").gte("created_at", since).order("created_at").order("id").range(f, t)),
    read<EventRow>("funnel_events", (f, t) => db.from("funnel_events").select("created_at, event, entry_point").gte("created_at", since).order("created_at").order("id").range(f, t)),
    read<InquiryRow>("engagement_inquiries", (f, t) => db.from("engagement_inquiries").select("created_at, entry_point:metadata->>entry_point").eq("intent", "ai_build_sprint").gte("created_at", since).order("created_at").order("id").range(f, t)),
    read<OptOutRow>("email_opt_outs", (f, t) => db.from("email_opt_outs").select("opted_out_at").gte("opted_out_at", since).order("opted_out_at").order("email").range(f, t)),
  ]);
  return { ...buildFrontDoors({ assessments, events, inquiries, optOuts }, opts), errors };
}
