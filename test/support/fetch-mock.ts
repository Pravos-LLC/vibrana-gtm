// Replaces globalThis.fetch for a test. Every request is recorded; anything that matches no route
// throws, so an unmocked call can never reach a live service (Zernio, Twenty, Wise, hosted Supabase).
import { appendFileSync, readFileSync } from "node:fs";

export type Route = {
  method?: string;
  /** Prefix of the full request URL, or a RegExp source string when `regex` is true. */
  url: string;
  regex?: boolean;
  status?: number;
  json?: unknown;
  body?: string;
  headers?: Record<string, string>;
  /** Simulate a network failure (timeout, reset) instead of answering. */
  error?: string;
  /** Answer this many times, then fall through to later routes. */
  times?: number;
  /** Read this file at call time and attach it to the recorded call (e.g. the calendar mid-request). */
  snapshot?: string;
  /** Forward to the real fetch (only ever used for the local Supabase stack). */
  passthrough?: boolean;
};

export type Call = { method: string; url: string; headers: Record<string, string>; body: string | null; snapshot?: string; route: number | null };

export function installFetchMock(routes: Route[], onCall?: (c: Call) => void) {
  const calls: Call[] = [];
  const used = routes.map(() => 0);
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const req = new Request(input, init);
    const body = init.body == null ? null : typeof init.body === "string" ? init.body : Buffer.from(await req.arrayBuffer()).toString("base64");
    const i = routes.findIndex((r, n) =>
      (!r.method || r.method === req.method) && (r.times == null || used[n] < r.times) &&
      (r.regex ? new RegExp(r.url).test(req.url) : req.url.startsWith(r.url)));
    const call: Call = { method: req.method, url: req.url, headers: Object.fromEntries(req.headers), body, route: i < 0 ? null : i };
    if (i >= 0 && routes[i].snapshot) call.snapshot = readFileSync(routes[i].snapshot!, "utf8");
    calls.push(call);
    onCall?.(call);
    if (i < 0) throw new Error(`unmocked fetch: ${req.method} ${req.url}`);
    used[i]++;
    const r = routes[i];
    if (r.passthrough) return original(input, init);
    if (r.error) throw new TypeError("fetch failed", { cause: new Error(r.error) });
    // PostgREST paging: a `.range()` read (offset/limit) gets its slice of a JSON array, and `count=exact` gets the
    // total in Content-Range, like the real server. Reads without a range get the whole array, as before.
    let json = r.json;
    const paging: Record<string, string> = {};
    const url = new URL(req.url);
    if (Array.isArray(json) && url.pathname.startsWith("/rest/v1/") && req.method === "GET") {
      const total = json.length;
      const offset = Number(url.searchParams.get("offset") ?? 0), limit = url.searchParams.get("limit");
      if (url.searchParams.has("offset") || limit != null) json = json.slice(offset, limit == null ? undefined : offset + Number(limit));
      if (/count=exact/.test(req.headers.get("prefer") ?? "")) paging["content-range"] = `${offset}-${offset + (json as unknown[]).length - 1}/${total}`;
    }
    const text = json !== undefined ? JSON.stringify(json) : r.body ?? "";
    return new Response(r.status === 204 ? null : text, {
      status: r.status ?? 200,
      headers: { ...(json !== undefined ? { "content-type": "application/json" } : {}), ...paging, ...r.headers },
    });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

// Subprocess mode (`node --import tsx --import ./test/support/fetch-mock.ts cli/gtm.ts`):
// routes come from the JSON file in GTM_FETCH_MOCK, calls are appended to GTM_FETCH_LOG as JSONL.
if (process.env.GTM_FETCH_MOCK) {
  const routes = JSON.parse(readFileSync(process.env.GTM_FETCH_MOCK, "utf8")) as Route[];
  const log = process.env.GTM_FETCH_LOG;
  installFetchMock(routes, (c) => { if (log) appendFileSync(log, JSON.stringify(c) + "\n"); });
}
