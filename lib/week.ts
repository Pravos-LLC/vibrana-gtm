export function addDays(iso: string, days: number) {
  const date = new Date(`${iso}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function mondayOf(iso: string) {
  const date = new Date(`${iso}T12:00:00Z`);
  const day = date.getUTCDay();
  const delta = day === 0 ? -6 : 1 - day;
  return addDays(iso, delta);
}

// ---- week numbers ----------------------------------------------------------------------------------------
// One definition of "week N", shared by `gtm season`, `gtm plan --week` and `gtm schedule --week`.
// Weeks run Monday to Sunday. A calendar item's week is always derived from its date, never stored.

const DAY = 86_400_000;
const utc = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

/** 1-based season week of `date`: week 1 is the Monday-to-Sunday week holding the season's first day. 0 or less is before it. */
export function seasonWeek(startsOn: string, date: string): number {
  return Math.floor((utc(mondayOf(date)) - utc(mondayOf(startsOn))) / DAY / 7) + 1;
}

/** How many season weeks a season spans (at least 1). */
export function seasonWeekCount(startsOn: string, endsOn: string): number {
  return Math.max(1, seasonWeek(startsOn, endsOn));
}

/** Monday of season week `n`. */
export function seasonWeekStart(startsOn: string, n: number): string {
  return addDays(mondayOf(startsOn), (n - 1) * 7);
}

/** ISO 8601 week of `date`: the week-numbering year and week 1 to 53 (week 1 holds the year's first Thursday). */
export function isoWeek(date: string): { year: number; week: number } {
  const thursday = addDays(mondayOf(date), 3);
  const year = Number(thursday.slice(0, 4));
  return { year, week: Math.floor((utc(thursday) - utc(`${year}-01-01`)) / DAY / 7) + 1 };
}

/** Which week `--week`, `--iso-week` (and `--season`) pick. */
export type WeekSelector =
  | { kind: "season"; season: { id: string; starts_on: string; ends_on: string }; week: number; from: string; to: string }
  | { kind: "iso"; week: number; year: number | null };

/** "41" (any year) or "2026-W41". */
export function parseIsoWeekArg(arg: string): { week: number; year: number | null } {
  const m = /^(?:(\d{4})-?W)?(\d{1,2})$/i.exec(arg.trim());
  const week = m ? Number(m[2]) : NaN;
  if (!m || week < 1 || week > 53) throw new Error(`--iso-week takes a week number 1 to 53 or YYYY-Www (got ${JSON.stringify(arg)})`);
  return { week, year: m[1] ? Number(m[1]) : null };
}

/** Season week `n` of `season`, checked against the season's length. */
export function seasonWeekSelector(season: { id: string; starts_on: string; ends_on: string }, arg: string): WeekSelector {
  const count = seasonWeekCount(season.starts_on, season.ends_on);
  const week = /^\d+$/.test(arg.trim()) ? Number(arg) : NaN;
  if (!(week >= 1 && week <= count)) throw new Error(`--week counts weeks of ${season.id} (${season.starts_on} to ${season.ends_on}): give 1 to ${count} (got ${JSON.stringify(arg)}); use --iso-week N for calendar weeks`);
  const from = seasonWeekStart(season.starts_on, week);
  return { kind: "season", season: { id: season.id, starts_on: season.starts_on, ends_on: season.ends_on }, week, from, to: addDays(from, 6) };
}

/** True when `date` (YYYY-MM-DD) falls in the selected week. */
export function inWeek(sel: WeekSelector, date: string): boolean {
  if (sel.kind === "season") return seasonWeek(sel.season.starts_on, date) === sel.week;
  const iso = isoWeek(date);
  return iso.week === sel.week && (sel.year === null || iso.year === sel.year);
}

// ---- months (the calendar's month view) ------------------------------------------------------------------

/** `month` is YYYY-MM. Moves it by `by` months. */
export function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function monthLastDay(month: string): string {
  return addDays(`${shiftMonth(month, 1)}-01`, -1);
}
