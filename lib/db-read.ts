// Complete, ordered reads. A failed page must never look like an empty queue, and a server row cap below the
// page size must never look like the end of the table.
import { must } from "./db";

type Page<T> = { data: T[] | null; error: { message: string } | null; count?: number | null };
const PAGE = 500;

/**
 * Reads every page of an ordered query. Ask for `{ count: "exact" }` in the select: the read then ends as soon as
 * it holds the counted rows (one request for a small table) and throws if the pages run dry before the count.
 * Without a count the read ends only on an empty page. Either way the next page starts after the rows actually
 * returned, so a server cap below the page size (PostgREST `max_rows`) is paged through, never truncated.
 */
export async function readPages<T>(page: (from: number, to: number) => PromiseLike<Page<T>>, what: string): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ;) {
    const res = await page(from, from + PAGE - 1);
    const next = must(res, what);
    if (!next) throw new Error(`${what}: response has no rows`);
    rows.push(...next);
    const total = res.count;
    if (typeof total === "number") {
      if (rows.length >= total) return rows;
      if (!next.length) throw new Error(`${what}: read ${rows.length} of ${total} rows`);
    } else if (!next.length) return rows;
    from += next.length;
  }
}

/** Runs `run` over `items` with at most `limit` in flight, keeping the input order in the result. */
export async function bounded<I, O>(items: I[], limit: number, run: (item: I) => Promise<O>): Promise<O[]> {
  const out = new Array<O>(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await run(items[i]); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Bound filter URLs as well as response sizes. The caller supplies a deterministic order. Chunks read four at a time. */
export async function readChunks<T>(ids: string[], page: (ids: string[], from: number, to: number) => PromiseLike<Page<T>>, what: string): Promise<T[]> {
  const unique = [...new Set(ids)];
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += 50) chunks.push(unique.slice(i, i + 50));
  const parts = await bounded(chunks, 4, (chunk) => readPages((from, to) => page(chunk, from, to), what));
  return parts.flat();
}
