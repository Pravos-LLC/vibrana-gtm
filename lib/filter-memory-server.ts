import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { filterCookie, restoredHref } from "./filter-memory";

/** On a bare visit, send the view to the filters John last chose there (lib/filter-memory.ts). */
export async function restoreFilters(path: string, params: Record<string, unknown>, names: string[]) {
  const href = restoredHref(path, params, (await cookies()).get(filterCookie(path))?.value, names);
  if (href) redirect(href);
}
