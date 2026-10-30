// What the last auto-schedule passes could not put on Zernio, kept where John looks. An approved post that is not
// scheduled (no pillar to file it under, an Instagram post with no image, a row that already carries the piece) used
// to show only in a server log, so it simply never went out. Every real pass records its skips and failures in one
// gtm_sync_state row; /content shows them at the top of the findings, linked to the piece. A full pass (the daily cron)
// replaces the record; a pass for one Story (an approval) replaces only that Story's lines.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AutoScheduleResult } from "./auto-schedule";
import type { Check } from "./season-analysis";
import { must } from "./db";
import { readChunks } from "./db-read";

export const SCHEDULE_REPORT_KEY = "autoschedule.last";

export type ScheduleLine = { id: string; storyId: string | null; kind: "skipped" | "failed"; reason: string };
export type ScheduleReport = { ran_at: string; lines: ScheduleLine[] };


/**
 * The lines worth John's attention. Holds have their own banner in /content and a hand-published channel (newsletter,
 * website) is skipped on purpose every pass, so neither is repeated here.
 */
export function scheduleLines(r: Pick<AutoScheduleResult, "skipped" | "failed">): ScheduleLine[] {
  // The Story comes from the pass itself (the item's story_id), never guessed from the id: `example-reference-38-linkedin` is an
  // item of no Story's name.
  return [
    ...r.failed.map((f) => ({ id: f.id, storyId: f.storyId ?? null, kind: "failed" as const, reason: f.error })),
    ...r.skipped.filter((s) => !s.reason.startsWith("held:") && !/ is published by hand$/.test(s.reason)).map((s) => ({ id: s.id, storyId: s.storyId ?? null, kind: "skipped" as const, reason: s.reason })),
  ];
}

/** Merges a pass into the last record. Pure. */
export function mergeReport(last: ScheduleReport | null, r: Pick<AutoScheduleResult, "skipped" | "failed">, at: string, storyId?: string): ScheduleReport {
  const fresh = scheduleLines(r);
  if (!storyId) return { ran_at: at, lines: fresh };
  const kept = (last?.lines ?? []).filter((l) => l.storyId !== storyId);
  return { ran_at: at, lines: [...kept, ...fresh] };
}

/** Records a real (not dry-run) pass. Callers treat a failure here as a log line: it never undoes a schedule. */
export async function recordScheduleReport(db: SupabaseClient, r: AutoScheduleResult, storyId?: string): Promise<void> {
  if (r.dryRun) return;
  const at = new Date().toISOString();
  const last = storyId ? (must(await db.from("gtm_sync_state").select("value").eq("key", SCHEDULE_REPORT_KEY).maybeSingle(), "schedule report") as { value: ScheduleReport } | null)?.value ?? null : null;
  must(await db.from("gtm_sync_state").upsert({ key: SCHEDULE_REPORT_KEY, value: mergeReport(last, r, at, storyId), updated_at: at }), "record schedule report");
}

export async function loadScheduleReport(db: SupabaseClient): Promise<ScheduleReport | null> {
  const report = (must(await db.from("gtm_sync_state").select("value").eq("key", SCHEDULE_REPORT_KEY).maybeSingle(), "schedule report") as { value: ScheduleReport } | null)?.value ?? null;
  if (!report?.lines.length) return report;
  const rows = await readChunks<{ id: string; status: string; zernio_post_id: string | null; updated_at: string }>(
    [...new Set(report.lines.map((l) => l.id))], (ids, from, to) => db.from("gtm_content_items")
      .select("id,status,zernio_post_id,updated_at", { count: "exact" }).in("id", ids).order("id").range(from, to), "schedule finding state");
  return reconcileScheduleReport(report, rows);
}

/** A late losing sender must never resurrect an error after the winning sender completed. Unknown rows stay visible. */
export function reconcileScheduleReport(report: ScheduleReport, rows: Array<{ id: string; status: string; zernio_post_id: string | null; updated_at: string }>, now = Date.now()): ScheduleReport {
  return { ...report, lines: report.lines.flatMap((line) => {
    const row = rows.find((r) => r.id === line.id);
    if (!row) return [line];
    if (row.status === "published" || row.status === "skipped" || (row.status === "scheduled" && row.zernio_post_id && row.zernio_post_id !== "pending")) return [];
    if (row.zernio_post_id === "pending" && now - Date.parse(row.updated_at) < 15 * 60_000)
      return [{ ...line, kind: "skipped" as const, reason: "scheduling in progress: another sender is uploading this post; no further approval is needed" }];
    if (row.zernio_post_id === "pending") return [{ ...line, kind: "failed" as const, reason: "scheduling attempt interrupted: verify the existing post on Zernio before retrying; no further approval is needed" }];
    return [line];
  }) };
}

/** A skip that only a copy change clears (over a platform's length limit) is a BLOCK, like a Zernio failure. */
const blocks = (l: ScheduleLine) => l.kind === "failed" || l.reason.startsWith("too long:");

/** Approved, not scheduled: one finding per line (a failure or an over-limit text is a BLOCK, other skips a WARN), linked to its piece. */
export function scheduleChecks(report: ScheduleReport | null): Check[] {
  return (report?.lines ?? []).map((l) => ({
    id: `autoschedule-${l.kind}:${l.id}`, severity: blocks(l) ? "block" as const : "warn" as const, status: "fail" as const,
    message: `${l.reason.startsWith("scheduling in progress:") ? "Scheduling in progress" : l.kind === "failed" ? "Approved, scheduling failed" : "Approved, not scheduled"}: ${l.id}: ${l.reason}`,
    ...(l.storyId ? { storyId: l.storyId } : {}),
  }));
}

/** The same findings on a page that has a Season analysis, with the summary counted. */
export function withScheduleChecks<T extends { checks: Check[]; summary: { block: number; warn: number; info: number } }>(analysis: T, report: ScheduleReport | null): T {
  const extra = scheduleChecks(report);
  if (!extra.length) return analysis;
  const block = extra.filter((c) => c.severity === "block").length;
  return { ...analysis, checks: [...extra, ...analysis.checks], summary: { ...analysis.summary, block: analysis.summary.block + block, warn: analysis.summary.warn + extra.length - block } };
}
