// The pipeline cron's work (app/api/cron/pipeline, hourly): stage history, outreach outcomes from the HQ mailbox, the
// lastContactedAt write-back to Twenty, yesterday's site traffic, and meetings from connected Google Calendars (VIB-518). Every step is nonfatal: a failure is recorded for
// that step and the others still run.
import type { SupabaseClient } from "@supabase/supabase-js";
import { TwentyReader } from "../twenty";
import { salesDeals } from "./deals";
import { syncOutcomes, type OutcomeRun } from "./outcomes";
import { loadSalesSettings } from "./settings";
import { recordStages } from "./stages";
import { syncWeb, type WebRun } from "./web";
import { writeContacted, type WritebackRun } from "./writeback";
import { syncCalendars, type CalendarRun } from "../team/calendar";

export type PipelineRun = { stages?: number | string; outcomes?: OutcomeRun | string; contacted?: WritebackRun | string; web?: WebRun | string; calendar?: CalendarRun | string };
const failed = (e: unknown) => `error: ${(e as Error).message.slice(0, 200)}`;

export async function runPipeline(db: SupabaseClient, opts: { now?: Date; deadline: number }): Promise<PipelineRun> {
  const now = opts.now ?? new Date();
  const out: PipelineRun = {};
  try { out.stages = await recordStages(db, (await salesDeals({ timeoutMs: 20_000 })).deals, now); } catch (e) { out.stages = failed(e); }
  try { out.outcomes = await syncOutcomes(db, { deadline: opts.deadline - 120_000 }); } catch (e) { out.outcomes = failed(e); }
  try { out.contacted = await writeContacted(db, new TwentyReader({ deadline: opts.deadline - 60_000 }), now); } catch (e) { out.contacted = failed(e); }
  try { out.web = await syncWeb(db, (await loadSalesSettings(db)).settings, now, { deadline: opts.deadline - 10_000 }); } catch (e) { out.web = failed(e); }
  try { out.calendar = await syncCalendars(db, new TwentyReader({ deadline: opts.deadline - 5_000 }), { now, deadline: opts.deadline - 5_000 }); } catch (e) { out.calendar = failed(e); }
  // Kept so the pages can say when a step is failing: the cron's own response is seen by nobody.
  const { error } = await db.from("gtm_sync_state").upsert({ key: RUN_KEY, value: { at: now.toISOString(), result: out }, updated_at: now.toISOString() }, { onConflict: "key" });
  if (error) (out as PipelineRun & { saved?: string }).saved = `error: ${error.message.slice(0, 200)}`;
  return out;
}

export const RUN_KEY = "pipeline.run";

/** One line per step that failed or could not run, from the last stored run; stale when older than three hours. */
export function runProblems(stored: { at?: string; result?: PipelineRun } | null, now: Date): string[] {
  if (!stored?.at || !stored.result) return ["The pipeline cron has not stored a run yet."];
  const out: string[] = [];
  const hours = (now.getTime() - Date.parse(stored.at)) / 3_600_000;
  if (hours > 3) out.push(`The pipeline cron last ran ${Math.round(hours)} hours ago.`);
  const r = stored.result;
  const err = (name: string, v: unknown) => { if (typeof v === "string" && v.startsWith("error")) out.push(`${name}: ${v.slice(7)}`); };
  err("Stage history", r.stages); err("Inbox outcomes", r.outcomes); err("CRM write-back", r.contacted); err("Site traffic", r.web); err("Calendar meetings", r.calendar);
  if (r.outcomes && typeof r.outcomes === "object" && r.outcomes.skipped) out.push(`Inbox outcomes: ${r.outcomes.skipped}`);
  if (r.calendar && typeof r.calendar === "object") {
    // "no calendar connected" is a state, not a failure; a missing client or deny-list is.
    if (r.calendar.skipped && !/no calendar connected|demo mode/.test(r.calendar.skipped)) out.push(`Calendar meetings: ${r.calendar.skipped}`);
    for (const [cal, v] of Object.entries(r.calendar.calendars ?? {})) if (v.error) out.push(`Calendar ${cal.split(":")[0]}: ${v.error}`);
  }
  if (r.web && typeof r.web === "object") {
    if (r.web.skipped) out.push(`Site traffic: ${r.web.skipped}`);
    for (const [site, v] of Object.entries(r.web)) if (v && typeof v === "object" && "error" in v && v.error) out.push(`Site traffic ${site}: ${v.error}`);
  }
  return out;
}
