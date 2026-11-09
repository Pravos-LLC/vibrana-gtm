// The CRM people mirror (VIB-516) against the real LOCAL database, with Twenty played by an in-memory fake that honours
// the filters, sorts and cursors the job sends, including Twenty's millisecond cursor (a row in the boundary millisecond
// comes back on the next page). Covers the backfill across a deadline and its resume, incremental changes, an
// out-of-order commit, a bulk update of more people than a page in one millisecond, soft deletes, an erasure caught by
// the count check and the id sweep, writes in flight that must not trigger a resync, the sweep's breaker, a mirror that
// never gets going, the healthz skip, and that the team summary SQL agrees with the reference summary. Synthetic data only.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { admin, seed } from "../support/seed.ts";
import { local } from "../support/local-supabase.ts";

const l = local();
Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: l.url, SUPABASE_SECRET_KEY: l.secretKey, TWENTY_API_KEY: "twenty_test", TWENTY_BASE: "https://crm.test" });
const { runMirror, MIRROR_KEY, loadMirrorState, mirrorReadiness, mirrorProblems, initialState } = await import("../../lib/crm/mirror.ts");
const { TwentyReader } = await import("../../lib/twenty.ts");
const { mirrorPeople, summarizePeople, collectActivity } = await import("../../lib/team/crm.ts");
const { parseMembers } = await import("../../lib/team/members.ts");

const WM = "00000000-0000-4000-8000-00000000aa01";
type P = { id: string; createdAt: string; updatedAt: string; deletedAt: string | null; name: string | null; wm: string | null; source: string; email: string | null; verification: string | null; notSendable: string | null };
const uid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const iso = (ms: number) => new Date(ms).toISOString();
const T0 = Date.parse("2026-09-01T00:00:00Z");

function dataset(n: number, from = 1): P[] {
  return Array.from({ length: n }, (_, k) => {
    const i = k + from - 1;
    return {
      id: uid(i + 1), createdAt: iso(T0 + i * 3_600_000), updatedAt: iso(T0 + i * 3_600_000 + 60_000), deletedAt: null,
      name: i % 3 === 0 ? "sync-key" : "John", wm: i % 3 === 0 ? null : WM, source: i % 3 === 0 ? "API" : "MANUAL",
      email: i % 2 ? `p${i}@example.test` : null, verification: i % 4 === 1 ? "VERIFIED" : null, notSendable: i % 8 === 1 ? "EMAIL_BOUNCED" : null,
    };
  });
}

type F = { gte?: string; lt?: string };
const inRange = (v: string | null, f: F | undefined) => !f || (v != null && (!f.gte || v >= f.gte) && (!f.lt || v < f.lt));
/** One person filter as the mirror sends it: a field range, or `and` of field ranges. */
function matches(p: P, f: Record<string, unknown>): boolean {
  if (Array.isArray(f.and)) return (f.and as Record<string, unknown>[]).every((c) => matches(p, c));
  return inRange(p.updatedAt, f.updatedAt as F) && inRange(p.deletedAt, f.deletedAt as F) && inRange(p.createdAt, f.createdAt as F);
}

/**
 * Twenty, as the mirror sees it. Under a timestamp sort the cursor carries the boundary row's millisecond, and the next
 * page starts at the first row of that millisecond (Postgres keeps microseconds): one repeat when times are distinct,
 * the same page forever when a page's worth of rows share it. Under an id sort the cursor is exact.
 */
function fakeTwenty(people: P[], seen: string[] = []) {
  return async (_url: RequestInfo | URL, init?: RequestInit) => {
    const { query, variables } = JSON.parse(String(init!.body)) as { query: string; variables: { f?: Record<string, unknown>; a?: string | null } };
    seen.push(query);
    const node = (p: P) => ({ id: p.id, createdAt: p.createdAt, updatedAt: p.updatedAt, deletedAt: p.deletedAt,
      createdBy: { source: p.source, name: p.name, workspaceMemberId: p.wm }, emails: { primaryEmail: p.email }, revEmailVerification: p.verification,
      prospectNotSendable: p.notSendable, companyId: null, lastContactedAt: null });
    const f = variables.f ?? {};
    const wantsDeleted = JSON.stringify(f).includes("deletedAt");
    const pool = people.filter((p) => (wantsDeleted ? !!p.deletedAt : !p.deletedAt) && matches(p, f));
    if (/totalCount/.test(query)) return Response.json({ data: { people: { totalCount: pool.length } } });
    const key = /orderBy:\[\{updatedAt/.test(query) ? "updatedAt" : /orderBy:\[\{deletedAt/.test(query) ? "deletedAt" : "id";
    const rows = [...pool].sort((a, b) => (key === "id" ? a.id.localeCompare(b.id) : (a[key] as string).localeCompare(b[key] as string) || a.id.localeCompare(b.id)));
    const size = Number(/first:(\d+)/.exec(query)![1]);
    const c = variables.a ? JSON.parse(Buffer.from(variables.a, "base64").toString()) as { k: string; id: string } : null;
    const rest = !c ? rows : key === "id" ? rows.filter((p) => p.id > c.id) : rows.filter((p) => (p[key] as string) >= c.k);
    const slice = rest.slice(0, size);
    const last = slice[slice.length - 1];
    const more = rest.length > size;
    const endCursor = last ? Buffer.from(JSON.stringify({ k: key === "id" ? "" : last[key], id: last.id })).toString("base64") : null;
    return Response.json({ data: { people: { pageInfo: { hasNextPage: more, endCursor }, edges: slice.map((p) => ({ node: /node \{ id \}/.test(query) ? { id: p.id } : node(p) })) } } });
  };
}

/** A reader that stops after `requests` Twenty calls (the deadline), with no pacing. */
const reader = (people: P[], requests = 10_000, seen: string[] = []) => {
  let n = 0;
  return new TwentyReader({ pauseMs: 0, sleep: async () => {}, now: () => n++ * 1000, deadline: requests * 1000 - 500, fetcher: fakeTwenty(people, seen) as typeof fetch });
};

const db = () => admin();
async function reset() {
  await db().from("gtm_crm_people").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  await db().from("gtm_sync_state").delete().eq("key", MIRROR_KEY);
}
const live = async () => (await db().from("gtm_crm_people").select("id", { count: "exact", head: true }).is("deleted_at", null)).count;
const row = async (id: string) => (await db().from("gtm_crm_people").select("*").eq("id", id).single()).data!;

before(async () => { await seed(); });

test("backfill: stops at the deadline with its place saved (progress, not failure), resumes next run, then counts match", async () => {
  await reset();
  const people = dataset(250);
  const r1 = await runMirror(db(), reader(people, 2));
  assert.match(r1.stopped ?? "", /deadline/); assert.equal(r1.failed, undefined);
  const s1 = await loadMirrorState(db());
  assert.equal(s1?.backfillDone, false);
  assert.ok(s1?.changes.after, "the resume point is saved after each page");
  assert.equal(mirrorReadiness(s1).ready, false, "people are not measured while the mirror is still copying");
  const r2 = await runMirror(db(), reader(people));
  assert.equal(r2.stopped, undefined);
  assert.equal(r2.counts?.twenty, 250); assert.equal(r2.counts?.mirror, 250); assert.equal(r2.counts?.match, true);
  const s2 = await loadMirrorState(db());
  assert.equal(s2?.backfillDone, true);
  assert.equal(mirrorReadiness(s2).ready, true);
  assert.equal(s2?.changes.since, people[249].updatedAt, "the cursor moves to the newest change seen");
  const r = await row(uid(2));
  assert.equal(r.has_email, true); assert.equal(r.email_verification, "VERIFIED"); assert.equal(r.not_sendable, true);
  assert.equal(r.created_by_member, WM);
  assert.equal(JSON.stringify(r).includes("@"), false, "no address is stored");
});

test("incremental: an hour later only changed and new people are read", async () => {
  await reset();
  const people = dataset(120);
  await runMirror(db(), reader(people));
  const later = iso(Date.parse("2026-11-09T00:00:00Z"));
  people[5] = { ...people[5], email: null, updatedAt: later };
  people.push({ ...dataset(1, 999)[0], createdAt: later, updatedAt: later });
  const r = await runMirror(db(), reader(people));
  assert.equal(r.changes.rows, 3, "the changed person, the new one, and the last row re-read by the overlap");
  assert.equal(await live(), 121);
  assert.equal((await row(people[5].id)).has_email, false);
});

test("an update that committed out of order (stamped before a change already read) is still read: each pass overlaps", async () => {
  await reset();
  // Live-like times: the CRM's clock and the run's clock agree, as in production.
  const now = Date.now();
  const people = dataset(50).map((p, i) => ({ ...p, updatedAt: iso(now - 3 * 3_600_000 + i * 1000) }));
  await runMirror(db(), reader(people));
  // B commits first, stamped a minute ago, and is read; A was stamped two minutes ago but committed afterwards.
  people[10] = { ...people[10], updatedAt: iso(now - 60_000), verification: "VERIFIED" };
  await runMirror(db(), reader(people));
  people[20] = { ...people[20], updatedAt: iso(now - 120_000), notSendable: "OPTED_OUT" };
  await runMirror(db(), reader(people));
  assert.equal((await row(people[20].id)).not_sendable, true, "the late commit is in the mirror");
});

test("a quiet CRM after a burst: the next pass re-reads only the boundary, not the burst's last 10 minutes (review r2, R3)", async () => {
  await reset();
  // A burst that ended days ago: 300 changes over its last 10 minutes.
  const end = Date.now() - 3 * 86_400_000;
  const people = dataset(300).map((p, i) => ({ ...p, updatedAt: iso(end - (300 - i) * 2000) }));
  await runMirror(db(), reader(people));
  const r = await runMirror(db(), reader(people));
  assert.ok(r.changes.rows <= 2, `re-read ${r.changes.rows} rows`);
});

test("a bulk update of more people than a page in one millisecond: read by id, then the stream carries on", async () => {
  await reset();
  const people = dataset(260);
  await runMirror(db(), reader(people));
  const bulk = iso(Date.parse("2026-11-09T10:00:00.123Z"));
  for (let i = 0; i < 150; i++) people[i] = { ...people[i], updatedAt: bulk, verification: "VERIFIED" };
  people[200] = { ...people[200], updatedAt: iso(Date.parse(bulk) + 5), email: null };
  const r = await runMirror(db(), reader(people));
  assert.equal(r.stopped, undefined, "no stall");
  assert.equal(r.changes.ties, 1);
  assert.equal(r.changes.caughtUp, true);
  const { count } = await db().from("gtm_crm_people").select("id", { count: "exact", head: true }).in("id", people.slice(0, 150).map((p) => p.id)).eq("email_verification", "VERIFIED");
  assert.equal(count, 150, "every person in the bulk millisecond was read");
  assert.equal((await row(people[200].id)).has_email, false, "and the change after it");
});

test("a bulk update too big for one run: the by-id read resumes where it stopped and finishes (review r2, R1)", async () => {
  await reset();
  const people = dataset(650);
  await runMirror(db(), reader(people));
  const bulk = iso(Date.parse("2026-11-09T10:00:00.456Z"));
  for (const p of people) p.updatedAt = bulk;
  let runs = 0, done = false;
  while (!done && runs < 20) {
    runs++;
    const r = await runMirror(db(), reader(people, 4));     // about 3 reads a run
    assert.notEqual(r.failed, true, `run ${runs} made progress`);
    done = r.changes.caughtUp;
  }
  assert.ok(done, "the bulk millisecond was read to the end across runs");
  const { count } = await db().from("gtm_crm_people").select("id", { count: "exact", head: true }).eq("updated_at", bulk);
  assert.equal(count, 650);
});

test("a whole run that moves nothing is not progress: it fails and records why", async () => {
  await reset();
  await runMirror(db(), reader(dataset(30)));
  const r = await runMirror(db(), reader(dataset(30), 1));   // the deadline comes before the first read
  assert.equal(r.failed, true);
  assert.match((await loadMirrorState(db()))!.lastError ?? "", /without moving/);
});

test("a soft delete in Twenty marks the mirror row deleted, and counts still match", async () => {
  await reset();
  const people = dataset(60);
  await runMirror(db(), reader(people));
  const when = iso(Date.now() + 1000);
  people[3].deletedAt = when; people[4].deletedAt = when;
  const r = await runMirror(db(), reader(people));
  assert.equal(r.deletes.rows, 2);
  assert.equal(r.counts?.twenty, 58); assert.equal(r.counts?.match, true);
});

test("writes in flight: a person created after the cutoff, or a one-off difference, never starts a resync", async () => {
  await reset();
  const people = dataset(80);
  await runMirror(db(), reader(people));
  // Created a minute ago in Twenty and not mirrored by the count: past the cutoff, so not compared.
  const justNow = { ...dataset(1, 500)[0], createdAt: iso(Date.now() - 60_000), updatedAt: iso(Date.now() + 3_600_000) };
  const r1 = await runMirror(db(), reader([...people, justNow]));
  assert.equal(r1.counts?.match, true, "a create in flight is past the cutoff");
  // A difference that shows once and heals does not resync.
  const r2 = await runMirror(db(), reader(people.filter((p) => p.id !== uid(7))));
  assert.equal(r2.counts?.match, false); assert.equal(r2.resync, undefined);
  const r3 = await runMirror(db(), reader([...people, justNow]));
  assert.equal(r3.counts?.match, true); assert.equal(r3.resync, undefined);
  assert.equal((await loadMirrorState(db()))?.diffRuns, 0);
});

test("an erasure: the same difference twice starts a resync, and the id sweep marks the destroyed rows", async () => {
  await reset();
  let people = dataset(230);
  await runMirror(db(), reader(people));
  const gone = new Set([uid(10), uid(11), uid(150), uid(229)]);
  people = people.filter((p) => !gone.has(p.id));
  const r1 = await runMirror(db(), reader(people));
  assert.equal(r1.counts?.match, false); assert.equal(r1.resync, undefined, "one disagreement can be a write in flight");
  const r2 = await runMirror(db(), reader(people));
  assert.equal(r2.resync, true);
  const r3 = await runMirror(db(), reader(people));
  assert.equal(r3.sweep?.done, true); assert.equal(r3.sweep?.removed, 4);
  assert.equal(r3.counts?.twenty, 226); assert.equal(r3.counts?.match, true);
  const { data } = await db().from("gtm_crm_people").select("id").in("id", [...gone]).not("deleted_at", "is", null);
  assert.equal(data?.length, 4);
  assert.equal(mirrorReadiness(await loadMirrorState(db())).ready, true, "a resync keeps people measured");
});

test("a difference a resync cannot fix: one resync, then an incident and no more resyncs that day (review r2, R4)", async () => {
  await reset();
  const people = dataset(120);
  await runMirror(db(), reader(people));
  // Twenty's count is off by 3 for a reason the mirror cannot see (a person Twenty counts but will not list).
  const skewed = () => { let n = 0; const f = fakeTwenty(people); return new TwentyReader({ pauseMs: 0, sleep: async () => {}, now: () => n++ * 1000, deadline: 1e9,
    fetcher: (async (u: RequestInfo | URL, init?: RequestInit) => { const res = await f(u, init); const j = await res.json() as { data: { people: { totalCount?: number } } };
      if (j.data.people.totalCount != null) j.data.people.totalCount += 3; return Response.json(j); }) as typeof fetch }); };
  const results = [];
  for (let i = 0; i < 6; i++) results.push(await runMirror(db(), skewed()));
  assert.equal(results.filter((r) => r.resync).length, 1, "one resync, not one every two runs");
  const s = (await loadMirrorState(db()))!;
  assert.equal(s.unresolvedDiff, 3);
  assert.equal(mirrorProblems(s)[0]?.key, "health_check:crm_mirror:counts");
  assert.equal(mirrorReadiness(s).ready, true, "people stay measured; the incident says why the counts differ");
});

test("the sweep's breaker: it refuses to remove most of a page's range, removes nothing, holds, and raises one incident", async () => {
  await reset();
  let people = dataset(200);
  await runMirror(db(), reader(people));
  people = people.filter((_, i) => i % 5 === 0);
  await runMirror(db(), reader(people));
  await runMirror(db(), reader(people));
  const r = await runMirror(db(), reader(people));
  assert.match(r.sweep?.error ?? "", /would remove/);
  assert.equal(await live(), 200, "nothing was marked deleted");
  const s = await loadMirrorState(db());
  assert.match(s?.sweepError ?? "", /would remove/, "the stop is kept, not retried on its own");
  assert.match(mirrorReadiness(s).reason ?? "", /safety limit/, "people read not measured, with why");
  assert.deepEqual(mirrorProblems(s).map((p) => p.key), ["health_check:crm_mirror:sweep"]);
  const again = await runMirror(db(), reader(people));
  assert.match(again.sweep?.error ?? "", /would remove/); assert.equal(again.sweep?.pages, 0, "held: no sweep reads until cleared");
  assert.equal(await live(), 200);
});

test("a mirror that never gets going (every first read fails) keeps its start and error, and raises an incident after 6 hours", async () => {
  await reset();
  const broken = new TwentyReader({ pauseMs: 0, sleep: async () => {}, retries: 0, fetcher: (async () => Response.json({ errors: [{ message: 'Cannot query field "revEmailVerification"' }] })) as typeof fetch });
  const r = await runMirror(db(), broken);
  assert.equal(r.failed, true);
  const s = (await loadMirrorState(db()))!;
  assert.ok(s.startedAt); assert.match(s.lastError ?? "", /revEmailVerification/);
  assert.deepEqual(mirrorProblems(s), [], "not yet: a young mirror");
  const p = mirrorProblems(s, Date.parse(s.startedAt) + 7 * 3_600_000);
  assert.equal(p[0]?.key, "health_check:crm_mirror:stale"); assert.match(p[0].summary, /revEmailVerification/);
  const again = await runMirror(db(), broken);
  assert.equal((await loadMirrorState(db()))!.startedAt, s.startedAt, "the start time is kept across failing runs");
  assert.equal(again.failed, true);
});

test("Twenty unhealthy: the run reads nothing and records why", async () => {
  await reset();
  const seen: string[] = [];
  const r = await runMirror(db(), reader(dataset(10), 1_000, seen), { health: async () => false });
  assert.match(r.skipped ?? "", /healthz/); assert.equal(r.failed, true);
  assert.equal(seen.length, 0);
  assert.match((await loadMirrorState(db()))!.lastError ?? "", /healthz/);
});

test("health: stale and never-caught-up mirrors are incidents; a healthy one is not", () => {
  const now = Date.parse("2026-11-09T12:00:00Z");
  const s0 = initialState(new Date("2026-11-09T11:00:00Z"));
  assert.deepEqual(mirrorProblems(null), []);
  assert.deepEqual(mirrorProblems(s0, now), [], "a young backfill is expected");
  assert.equal(mirrorProblems({ ...s0, startedAt: "2026-11-09T01:00:00Z" }, now)[0].key, "health_check:crm_mirror:stale");
  const ok = { ...s0, backfillDone: true, lastOkAt: "2026-11-09T11:30:00Z", caughtUpAt: "2026-11-09T11:30:00Z" };
  assert.deepEqual(mirrorProblems(ok, now), []); assert.equal(mirrorReadiness(ok, now).ready, true);
  assert.equal(mirrorProblems({ ...ok, lastOkAt: "2026-11-09T02:00:00Z" }, now)[0].key, "health_check:crm_mirror:stale");
  const behind = { ...ok, caughtUpAt: "2026-11-07T11:00:00Z" };
  assert.match(mirrorProblems(behind, now)[0].summary, /caught up/); assert.equal(mirrorReadiness(behind, now).ready, false);
});

test("the team summary from the mirror equals the reference summary over the same people; lookup keeps only theirs", async () => {
  await reset();
  const people = dataset(300);
  await runMirror(db(), reader(people));
  const member = parseMembers(JSON.stringify([{ code: "JOHN", authEmail: "john@team.test", workspaceMemberId: WM, apiKeyNames: ["sync-key"], mailboxes: [] }]))[0];
  const now = new Date("2026-09-10T00:00:00Z");
  const src = mirrorPeople(db(), async () => ({ ready: true, reason: null }));
  const fromSql = await src.summary(member, new Date(now.getTime() - 190 * 86_400_000));
  const ref = summarizePeople(people.map((p) => ({ id: p.id, createdAt: p.createdAt, hasEmail: !!p.email, verification: p.verification, notSendable: !!p.notSendable })), now);
  for (const k of ["total", "withEmail", "verified", "sendable", "unverified"] as const) assert.equal(fromSql[k], ref[k], k);
  assert.deepEqual(fromSql.added, ref.added.filter((ms) => ms >= Date.parse(fromSql.addedSince)), "creation times in ms, as the reference");
  assert.deepEqual(fromSql.latest.map((x) => x.id), ref.latest.map((x) => x.id));
  const other = parseMembers(JSON.stringify([{ code: "ABE", authEmail: "abe@team.test", apiKeyNames: ["nobody"], mailboxes: [] }]))[0];
  assert.equal((await src.summary(other, now)).total, 0);
  const found = await src.lookup(member, [uid(1), uid(2), "not-a-uuid", uid(9999)]);
  assert.deepEqual(Object.keys(found).sort(), [uid(1), uid(2)]);
});

test("collectActivity counts a 13k-person member from the mirror, with no full Twenty people read", async () => {
  await reset();
  const people = dataset(13_000);
  const rows = people.map((p) => ({ id: p.id, created_at: p.createdAt, updated_at: p.updatedAt, created_by_source: p.source, created_by_name: p.name,
    created_by_member: p.wm, has_email: !!p.email, email_verification: p.verification, not_sendable: !!p.notSendable }));
  for (let i = 0; i < rows.length; i += 1000) assert.equal((await db().from("gtm_crm_people").insert(rows.slice(i, i + 1000))).error, null);
  const member = parseMembers(JSON.stringify([{ code: "JOHN", authEmail: "john@team.test", workspaceMemberId: WM, apiKeyNames: ["sync-key"], mailboxes: [] }]))[0];
  const seen: string[] = [];
  const twenty = new TwentyReader({ pauseMs: 0, sleep: async () => {}, fetcher: (async (_u: RequestInfo | URL, init?: RequestInit) => {
    const { query } = JSON.parse(String(init!.body)) as { query: string };
    seen.push(query);
    const object = /\{ (\w+)\(/.exec(query)![1];
    if (/totalCount/.test(query)) return Response.json({ data: { [object]: { totalCount: 0 } } });
    return Response.json({ data: { [object]: { pageInfo: { hasNextPage: false, endCursor: null }, edges: [] } } });
  }) as typeof fetch });
  const a = await collectActivity(twenty, member, mirrorPeople(db(), async () => ({ ready: true, reason: null })), new Date("2027-01-01T00:00:00Z"));
  assert.deepEqual(a.errors, {});
  assert.equal(a.people.total, 13_000);
  assert.equal(seen.some((q) => /\{ people\(/.test(q)), false, "people never read from Twenty");
  assert.ok(JSON.stringify(a).length < 300_000, "the cache row stays small");
});

test("team run: a mirror that is not ready marks people not measured, and still saves the member's other numbers (review of #36, M4)", async () => {
  await reset();
  const { runTeam } = await import("../../lib/team/run.ts");
  const { loadActivity } = await import("../../lib/team/crm.ts");
  const members = parseMembers(JSON.stringify([{ code: "TMIR", authEmail: "tmir@team.test", workspaceMemberId: WM, apiKeyNames: ["sync-key"], mailboxes: [] }]));
  const company = { id: uid(4242), createdAt: "2026-11-01T00:00:00Z", accountOwnerId: null };
  // Twenty: one company for the member, nothing else; the mirror has no state (not ready).
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("https://crm.test")) return original(input, init);
    const { query } = JSON.parse(String(init!.body)) as { query: string };
    const object = /\{ (\w+)\(/.exec(query)?.[1] ?? "people";
    if (/totalCount/.test(query)) return Response.json({ data: { [object]: { totalCount: 0 } } });
    const edges = object === "companies" ? [{ node: company }] : [];
    return Response.json({ data: { [object]: { pageInfo: { hasNextPage: false, endCursor: null }, edges } } });
  }) as typeof fetch;
  // A good people count saved earlier today must survive a later unmeasured run (review r2, R2).
  const today = new Date().toISOString().slice(0, 10);
  await db().from("gtm_team_stock_daily").upsert({ member: "TMIR", date: today, metrics: { people: 5, sendable: 1 } }, { onConflict: "member,date" });
  try {
    const out = await runTeam(db(), members, { deadline: Date.now() + 120_000 });
    assert.match(String(out.TMIR?.activity), /partial: people/);
    const a = await loadActivity(db(), "TMIR");
    assert.match(a?.errors.people ?? "", /still copying/, "people say why they are not measured");
    assert.equal(a?.companies.length, 1, "the member's companies were saved, not frozen");
    const { data } = await db().from("gtm_team_stock_daily").select("metrics").eq("member", "TMIR");
    assert.equal(data?.length, 1, "the day's stock snapshot is written");
    const m = data![0].metrics as Record<string, number | null>;
    assert.equal(m.people, 5); assert.equal(m.sendable, 1, "the morning's measured people are kept");
    assert.equal(m.companies_no_owner, 1, "and the rest is today's");
  } finally {
    globalThis.fetch = original;
    await db().from("gtm_sync_state").delete().like("key", "team.%tmir%");
    await db().from("gtm_team_stock_daily").delete().eq("member", "TMIR");
  }
});
