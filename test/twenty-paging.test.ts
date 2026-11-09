// VIB-516: the cockpit reads the whole CRM and never truncates a Twenty read without saying so.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.TWENTY_BASE = "https://crm.test";
process.env.TWENTY_API_KEY = "twenty_test";
const { pages, TwentyReader, twentyHealthy } = await import("../lib/twenty.ts");
const { recentApiWriters, normalizeActivity, summarizePeople } = await import("../lib/team/crm.ts");
const { salesDeals } = await import("../lib/sales/deals.ts");
const { mirrorReadiness, toRow, initialState } = await import("../lib/crm/mirror.ts");

/** n rows served `size` at a time, each page repeating the previous page's last row (as Twenty does). */
function served(n: number, size: number) {
  const rows = Array.from({ length: n }, (_, i) => ({ id: `o${String(i).padStart(4, "0")}`, stage: i % 2 ? "SIGNED" : "LOST" }));
  return async <T>(q: string): Promise<T> => {
    const m = /after:"([^"]+)"/.exec(q);
    const start = m ? Number(m[1]) : 0;
    const slice = rows.slice(start, start + size);
    const more = start + size < rows.length;
    return { opportunities: { pageInfo: { hasNextPage: more, endCursor: more ? String(start + size - 1) : null }, edges: slice.map((node) => ({ node })) } } as T;
  };
}

test("pages: 450 opportunities over several pages come back in full, each once", async () => {
  const got = await pages<{ id: string }>("opportunities", (after) => `{ opportunities(first:200${after ? `, after:"${after}"` : ""}) { pageInfo { hasNextPage endCursor } edges { node { id } } } }`, { run: served(450, 200) });
  assert.equal(got.length, 450);
  assert.equal(new Set(got.map((r) => r.id)).size, 450);
});

test("pages: a cursor that stops moving, or more rows than allowed, throws instead of truncating", async () => {
  const stuck = async <T>(): Promise<T> => ({ opportunities: { pageInfo: { hasNextPage: true, endCursor: "x" }, edges: [{ node: { id: "a" } }] } } as T);
  await assert.rejects(pages("opportunities", () => "q", { run: stuck }), /cursor did not advance/);
  await assert.rejects(pages("opportunities", (after) => `q${after ? `, after:"${after}"` : ""}`, { run: served(450, 200), max: 300 }), /more than 300 rows/);
});

test("TwentyReader.all: a page of nothing but repeats throws (it used to return what it had)", async () => {
  const reader = new TwentyReader({ pauseMs: 0, sleep: async () => {}, fetcher: (async () => Response.json({ data: { people: { pageInfo: { hasNextPage: true, endCursor: "c" }, edges: [{ node: { id: "p1" } }] } } })) as typeof fetch });
  await assert.rejects(reader.all("people", "id", null, "PersonFilterInput"), /cursor did not advance/);
});

test("salesDeals reads every opportunity, not the first 200", async () => {
  const node = (i: number) => ({ id: `d${i}`, name: `Deal ${i}`, stage: "PROPOSAL", closeDate: null, createdAt: "2026-11-01T00:00:00Z", updatedAt: null, amount: null, company: null, pointOfContact: null });
  const all = Array.from({ length: 230 }, (_, i) => node(i));
  const r = await salesDeals({ query: async (q) => {
    const m = /after:"([^"]+)"/.exec(q);
    const start = m ? Number(m[1]) : 0;
    const more = start + 200 < all.length;
    return { opportunities: { pageInfo: { hasNextPage: more, endCursor: more ? String(start + 200) : null }, edges: all.slice(start, start + 200).map((n) => ({ node: n })) } };
  } });
  assert.equal(r.deals.length, 230);
});

test("recentApiWriters asks only for names it has not seen, a request per new name, at any volume", async () => {
  const queries: { object: string; exclude: string[] }[] = [];
  let sentNotNull = false;
  const writers: Record<string, string[]> = { people: ["sync", "abe-cortx", "brand-new"], companies: ["sync"], notes: [], opportunities: [] };
  const reader = new TwentyReader({ pauseMs: 0, sleep: async () => {}, fetcher: (async (_u: RequestInfo | URL, init?: RequestInit) => {
    const { query, variables } = JSON.parse(String(init!.body)) as { query: string; variables: { f: { and: Record<string, { createdBy?: { name?: { in?: string[] } } }>[] } } };
    const object = /\{ (\w+)\(/.exec(query)![1];
    const not = variables.f.and.find((c) => "not" in c) as { not: { createdBy: { name: { in: string[] } } } } | undefined;
    const exclude = not?.not.createdBy.name.in ?? [];
    queries.push({ object, exclude });
    if (variables.f.and.some((c) => (c as { createdBy?: { name?: { is?: string } } }).createdBy?.name?.is === "NOT_NULL")) sentNotNull = true;
    const name = writers[object].find((n) => !exclude.includes(n));
    return Response.json({ data: { [object]: { edges: name ? [{ node: { createdBy: { name } } }] : [] } } });
  }) as typeof fetch });
  const found = await recentApiWriters(reader, new Date("2026-11-09T00:00:00Z"), ["sync", "abe-cortx"]);
  assert.deepEqual(found, ["brand-new"]);
  assert.equal(queries.length, 2 + 1 + 1 + 1, "people: one hit, one empty; then one empty read per other object");
  assert.deepEqual(queries[0].exclude, ["sync", "abe-cortx"]);
  assert.ok(sentNotNull, "rows without a key name are filtered out in Twenty, so they cannot end the search (review of #36, F3)");
});

test("a cache written before VIB-516 (every person as a row) is read as the summary", () => {
  const capturedAt = "2026-11-07T08:00:00Z";
  const legacy = { member: "ABE", capturedAt, errors: {}, captureRuns: 0, notes: [], opportunities: [], tasks: [], meetings: [], companies: [],
    people: [{ id: "p1", createdAt: "2026-11-01T00:00:00Z", hasEmail: true, verification: "VERIFIED", companyId: null, notSendable: false, lastContactedAt: null }] };
  const a = normalizeActivity(legacy as never)!;
  assert.equal(a.people.total, 1); assert.equal(a.people.verified, 1);
  assert.deepEqual(a.people.mine, { p1: "2026-11-01T00:00:00Z" });
  assert.deepEqual(a.people.added, [Date.parse("2026-11-01T00:00:00Z") / 1000]);
  assert.equal(normalizeActivity(a), a, "a new cache passes through");
  assert.equal(summarizePeople([], new Date()).total, 0);
});

test("mirror: readiness, rows without addresses, and Twenty health", async () => {
  assert.equal(mirrorReadiness(null).ready, false);
  assert.equal(mirrorReadiness({ ...initialState(), backfillDone: true, lastOkAt: new Date().toISOString() }).ready, true);
  assert.match(mirrorReadiness({ ...initialState(), backfillDone: true, lastOkAt: "2026-01-01T00:00:00Z" }).reason ?? "", /6 hours/);
  const row = toRow({ id: "x", createdAt: "a", updatedAt: "b", deletedAt: null, createdBy: { source: "API", name: "k", workspaceMemberId: null },
    emails: { primaryEmail: "someone@example.test" }, revEmailVerification: "VERIFIED", prospectNotSendable: " ", companyId: null, lastContactedAt: null }, "now");
  assert.equal(row.has_email, true); assert.equal(row.not_sendable, false, "a blank reason does not block");
  assert.equal(JSON.stringify(row).includes("@"), false, "the address itself is never in the row");
  assert.equal(await twentyHealthy((async () => new Response("ok", { status: 200 })) as typeof fetch), true);
  assert.equal(await twentyHealthy((async () => new Response("no", { status: 503 })) as typeof fetch), false);
  assert.equal(await twentyHealthy((async () => { throw new Error("down"); }) as typeof fetch), false);
});

test("the mirror cron runs hourly at :05 under its own route, ahead of the team run at :20", () => {
  const crons = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8")).crons as { path: string; schedule: string }[];
  assert.ok(crons.some((c) => c.path === "/api/cron/crm-mirror" && c.schedule === "5 * * * *"));
  const src = readFileSync(new URL("../app/api/cron/crm-mirror/route.ts", import.meta.url), "utf8");
  assert.match(src, /cronAuthorized\(request\)/); assert.match(src, /gtm_take_lease/); assert.match(src, /twentyHealthy/);
});
