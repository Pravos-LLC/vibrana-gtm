import { Shell } from "@/components/shell";
import { CalendarBoard } from "@/components/calendar/calendar-board";
import { CalendarToolbar } from "@/components/calendar/calendar-toolbar";
import { STATUSES } from "@/lib/calendar";
import { calendarConfig, PILLARS } from "@/lib/calendar-db";
import { filterPosts, groupForList } from "@/lib/posts";
import { parsePostFilters } from "@/lib/posts-parse";
import { loadPosts, todayIn } from "@/lib/posts-db";
import { addDays, mondayOf, monthLastDay, shiftMonth } from "@/lib/week";
import { sessionDb } from "@/lib/supabase/server";
import { cookies } from "next/headers";
import { CALENDAR_VIEW_COOKIE, calendarView } from "@/lib/filter-memory";
import { WeekLint } from "@/components/calendar/week-lint";
import { gapsFor, lintCalendar, dayLabels, WEEKDAYS } from "@/lib/rhythm";
import { loadLintPosts } from "@/lib/rhythm-db";

export const dynamic = "force-dynamic";

export const metadata = { title: "Calendar" };

/** One calendar, three views: week (default), month and the whole calendar as a list. All share search and filters; the last view chosen is remembered. */
export default async function CalendarPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const filters = parsePostFilters(params);
  const view = calendarView(params, (await cookies()).get(CALENDAR_VIEW_COOKIE)?.value);
  const { timezone } = calendarConfig();
  const today = todayIn(timezone);
  const db = await sessionDb();
  const plural = (n: number) => `${n} ${n === 1 ? "post" : "posts"}`;

  if (view === "list") {
    const { posts, error } = await loadPosts(db);
    const shown = filterPosts(posts, filters);
    return (
      <Shell title="Calendar" active="/calendar" wide>
        {error && <p className="mb-4 text-sm text-red-strong">The calendar could not load: {error}</p>}
        <CalendarToolbar view="list" week={null} filters={filters} statuses={STATUSES} pillars={PILLARS}
          summary={`Whole calendar · ${shown.length === posts.length ? plural(posts.length) : `${shown.length} of ${plural(posts.length)}`}`} />
        <CalendarBoard rhythmLabels={Object.fromEntries([...WEEKDAYS, ...shown.map(p => p.date)].map(d => [d, dayLabels(d)]))} view="list" groups={groupForList(shown, today, mondayOf)} />
      </Shell>
    );
  }

  if (view === "week") {
    const week = typeof params.week === "string" && /^\d{4}-\d{2}-\d{2}$/.test(params.week) ? params.week : null;
    const monday = mondayOf(week ?? today);
    const end = addDays(monday, 6);
    // The rhythm check reads two weeks either side: topic spacing and the look of the day before reach across weeks.
    const [{ posts, error }, around] = await Promise.all([loadPosts(db, { from: monday, to: end }), loadLintPosts(db, addDays(monday, -14), addDays(end, 14)).catch(() => null)]);
    const shown = filterPosts(posts, filters);
    return (
      <Shell title="Calendar" active="/calendar" wide>
        {error && <p className="mb-4 text-sm text-red-strong">The calendar could not load: {error}</p>}
        <CalendarToolbar view="week" week={week} filters={filters} statuses={STATUSES} pillars={PILLARS}
          summary={`${range(monday, end)} · ${timezone} · ${plural(shown.length)} · drag a post to another day`}
          nav={{ param: "week", labels: ["This week", "Previous week", "Next week"], today: "", previous: addDays(monday, -7), next: addDays(monday, 7) }} />
        {around && <WeekLint report={lintCalendar(around, monday)[0]} gaps={gapsFor(around, monday < today ? today : monday, end)} />}
        <CalendarBoard rhythmLabels={Object.fromEntries([...WEEKDAYS, ...shown.map(p => p.date)].map(d => [d, dayLabels(d)]))} view="week" posts={shown} monday={monday} today={today} />
      </Shell>
    );
  }

  const month = typeof params.month === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(params.month) ? params.month : null;
  const current = month ?? today.slice(0, 7);
  const from = mondayOf(`${current}-01`);
  const to = addDays(mondayOf(monthLastDay(current)), 6);
  const { posts, error } = await loadPosts(db, { from, to });
  const shown = filterPosts(posts, filters);
  const inMonth = shown.filter((p) => p.date.startsWith(current)).length;
  return (
    <Shell title="Calendar" active="/calendar" wide>
      {error && <p className="mb-4 text-sm text-red-strong">The calendar could not load: {error}</p>}
      <CalendarToolbar view="month" week={month} filters={filters} statuses={STATUSES} pillars={PILLARS}
        summary={`${monthName(current)} · ${timezone} · ${plural(inMonth)} · drag a post to another day`}
        nav={{ param: "month", labels: ["This month", "Previous month", "Next month"], today: "", previous: shiftMonth(current, -1), next: shiftMonth(current, 1) }} />
      <CalendarBoard rhythmLabels={Object.fromEntries([...WEEKDAYS, ...shown.map(p => p.date)].map(d => [d, dayLabels(d)]))} view="month" posts={shown} month={current} today={today} />
    </Shell>
  );
}

function monthName(month: string) {
  return new Date(`${month}-15T12:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

function range(from: string, to: string) {
  const f = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  return `${f(from)} – ${f(to)}`;
}
