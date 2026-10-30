// Each filtered view remembers the filters John last chose (John, 2026-10-13: "I almost always only want to see what
// Needs Approval, but I have to select that every time I load the page"). FilterToolbar writes the panel's selects to a
// cookie as he changes them; the page reads it on a bare visit (no query at all) and redirects to that view. A link that
// carries a query (a finding's ?piece=&channel=, a shared filtered view) is never changed. Search text is not kept.
// Clearing the filters clears the memory too.

/** What each view keeps for the next visit: every select but /content's Piece, which is a one-off lookup. */
export const CONTENT_REMEMBERED = ["platform", "status", "pillar", "series", "stage"];

/** The cookie that holds one view's remembered filters. */
export const filterCookie = (path: string) => `gtm_filters${path.replace(/[^a-z0-9]+/gi, "_")}`;

/** The query to remember: only the named filters that are set, in a stable order. */
export function rememberedQuery(entries: Iterable<[string, string]>, names: string[]): string {
  const keep = new Map([...entries].filter(([k, v]) => names.includes(k) && v));
  return new URLSearchParams(names.filter((n) => keep.has(n)).map((n) => [n, keep.get(n)!])).toString();
}

/**
 * Where a bare visit should go instead, or null. `params` is the page's searchParams; `stored` the cookie's value;
 * `names` the filters this view remembers (anything else in the cookie is dropped).
 */
export function restoredHref(path: string, params: Record<string, unknown>, stored: string | undefined, names: string[]): string | null {
  if (Object.keys(params).length || !stored) return null;
  const query = rememberedQuery(new URLSearchParams(stored).entries(), names);
  return query ? `${path}?${query}` : null;
}

// The calendar remembers its view (John, 2026-10-17: "I want /calendar to remember what view I selected last; week should
// be the default"). The toolbar writes the view it shows to this cookie; a visit that names no view opens the remembered one.
export const CALENDAR_VIEW_COOKIE = "gtm_calendar_view";
export type CalendarView = "month" | "week" | "list";

/** The view to show: the address bar's, else what its cursor implies (a month or a week), else the remembered one, else week. */
export function calendarView(params: Record<string, unknown>, stored: string | undefined): CalendarView {
  const asked = params.view;
  if (asked === "list" || asked === "week" || asked === "month") return asked;
  if (typeof params.month === "string") return "month";
  if (typeof params.week === "string") return "week";
  return stored === "month" || stored === "list" ? stored : "week";
}
