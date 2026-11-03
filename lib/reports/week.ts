// Which week a report covers. Weeks run Monday to Sunday (lib/week.ts). With no seasons (John, 2026-11-02) a report covers
// a calendar week, numbered by its ISO week; a season week is used only when one is asked for. "Today" is John's date in Bali.
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveSeason } from "../seasons";
import { addDays, isoWeek, mondayOf, seasonWeek, seasonWeekCount, seasonWeekSelector } from "../week";

export const REPORT_TZ = () => process.env.REPORT_TZ ?? process.env.SIGNALS_DIGEST_TZ ?? "Asia/Makassar";

/** YYYY-MM-DD of `at` in the report timezone (Bali by default). */
export function localDate(at: Date | string, tz = REPORT_TZ()): string {
  const d = typeof at === "string" ? new Date(at) : at;
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export type ReportWeek = {
  /** Only for a season week asked for by --season/--week; a calendar week has none. */
  season: { id: string; starts_on: string; ends_on: string } | null;
  week: number; from: string; to: string; today: string;
  /** Monday of the previous week, and the window the next two weeks' calendar is read from. */
  prev: { week: number; from: string; to: string };
  next: { from: string; to: string };
};

/**
 * The week to report on: `week` of `seasonId` (or the current season), else the week holding today. The
 * cron runs Sunday 08:00 in Bali, so "the week holding today" is the week ending that day.
 */
export async function resolveReportWeek(db: SupabaseClient, opts: { week?: number; seasonId?: string; monday?: string; now?: Date } = {}): Promise<ReportWeek> {
  const today = localDate(opts.now ?? new Date());
  if (opts.week === undefined && opts.seasonId === undefined) return calendarReportWeek(opts.monday ?? today, today);
  const season = await resolveSeason(db, opts.seasonId, today);
  const count = seasonWeekCount(season.starts_on, season.ends_on);
  const n = opts.week ?? Math.min(count, Math.max(1, seasonWeek(season.starts_on, today)));
  const sel = seasonWeekSelector(season, String(n));
  if (sel.kind !== "season") throw new Error("unreachable");
  return {
    season: { id: season.id, starts_on: season.starts_on, ends_on: season.ends_on },
    week: n, from: sel.from, to: sel.to, today,
    prev: { week: n - 1, from: addDays(sel.from, -7), to: addDays(sel.from, -1) },
    next: { from: addDays(sel.to, 1), to: addDays(sel.to, 14) },
  };
}

/** The calendar week holding `date` (Monday to Sunday), numbered by its ISO week. No season. */
export function calendarReportWeek(date: string, today: string): ReportWeek {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`--monday takes YYYY-MM-DD (got ${JSON.stringify(date)})`);
  const from = mondayOf(date), to = addDays(from, 6), prevFrom = addDays(from, -7);
  return {
    season: null, week: isoWeek(from).week, from, to, today,
    prev: { week: isoWeek(prevFrom).week, from: prevFrom, to: addDays(from, -1) },
    next: { from: addDays(to, 1), to: addDays(to, 14) },
  };
}
