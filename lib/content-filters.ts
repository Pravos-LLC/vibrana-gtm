import { filtersToQuery, parseFilters, type Filters } from "./season-review";

/** The review queue opens on work awaiting John. Explicit all-status and direct piece links stay inspectable. */
export function contentFilters(params: Record<string, string | string[] | undefined>): Filters {
  return parseFilters({ ...params, status: params.status ?? (params.piece ? "all" : "needs-approval") });
}

/** Keep an explicit all-status choice when removing the last chip or clearing filters. */
export function contentQuery(filters: Filters): string {
  const query = new URLSearchParams(filtersToQuery(filters).slice(1));
  if (!filters.status) query.set("status", "all");
  return `?${query}`;
}
