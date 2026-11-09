// The CRM people mirror (VIB-516) against the real LOCAL database, with Twenty played by an in-memory fake that honours
// the filters, sorts and cursors the job sends: the backfill across a deadline and its resume, incremental changes, soft
// deletes, an erasure caught by the count check and the id sweep, the sweep's breaker, the healthz skip, and that the
// team summary SQL agrees with the reference summary. Synthetic data only.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { admin, seed } from "../support/seed.ts";
import { local } from "../support/local-supabase.ts";

const l = local();
Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: l.url, SUPABASE_SECRET_KEY: l.secretKey, TWENTY_API_KEY: "twenty_test", TWENTY_BASE: "https://crm.test" });
const { runMirror, MIRROR_KEY, loadMirrorState, mirrorReadiness } = await import("../../lib/crm/mirror.ts");
const { TwentyReader } = await import("../../lib/twenty.ts");
const { mirrorPeople, summarizePeople, collectActivity } = await import("../../lib/team/crm.ts");
const { parseMembers } = await import("../../lib/team/members.ts");

const WM = "00000000-0000-4000-8000-00000000aa01";
type P = { id: string; createdAt: string; updatedAt: string; deletedAt: string | null; name: string | null; wm: string | null; source: string; email: string | null; verification: string | null; notSendable: string | null };
const uid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const iso = (ms: number) => new Date(ms).toISOString();
const T0 = Date.parse("2026-09-01T00:00:00Z");

function dataset(n: number): P[] {
  return Array.from({ length: n }, (_, i) => ({
    id: uid(i + 1), createdAt: iso(T0 + i * 3_600_000), updatedAt: iso(T0 + i * 3_600_000 + 60_000), deletedAt: null,
    name: i % 3 === 0 ? "sync-key" : "John", wm: i % 3 === 0 ? null : WM, source: i % 3 === 0 ? "API" : "MANUAL",
    email: i % 2 ? `p${i}@example.test` : null, verification: i % 4 === 1 ? "VERIFIED" : null, notSendable: i % 8 === 1 ? "EMAIL_BOUNCED" : null,
  }));
}

/** Twenty, as the mirror sees it: page size from the query, cursor = the boundary row's index (repeated, as Twenty does). */
function fakeTwenty(people: P[], seen: string[] = []) {
  return async (_url: RequestInfo | URL, init?: RequestInit) => {
    const { query, variables } = JSON.parse(String(init!.body)) as { query: string; variables: { f?: Record<string, { gte?: string }>; a?: string | null } };
    seen.push(query);
    const node = (p: P) => ({ id: p.id, createdAt: p.createdAt, updatedAt: p.updatedAt, deletedAt: p.deletedAt,
      createdBy: { source: p.source, name: p.name, workspaceMemberId: p.wm }, emails: { primaryEmail: p.email }, revEmailVerification: p.verification,
      prospectNotSendable: p.notSendable, companyId: null, lastContactedAt: null });
    const live = people.filter((p) => !p.deletedAt);
    if (/totalCount/.test(query)) return Response.json({ data: { people: { totalCount: live.length } } });
    let rows: P[];
    const f = variables.f ?? {};
    if (/orderBy:\[\{updatedAt/.test(query)) rows = live.filter((p) => p.updatedAt >= f.updatedAt!.gte!).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id));
    else if (/orderBy:\[\{deletedAt/.test(query)) rows = people.filter((p) => p.deletedAt && p.deletedAt >= f.deletedAt!.gte!).sort((a, b) => a.deletedAt!.localeCompare(b.deletedAt!) || a.id.localeCompare(b.id));
    else rows = [...live].sort((a, b) => a.id.localeCompare(b.id));
    const size = Number(/first:(\d+)/.exec(query)![1]);
    const start = variables.a ? Number(JSON.parse(Buffer.from(variables.a, "base64").toString()).i) : 0;
    const slice = rows.slice(start, start + size);
    const more = start + size < rows.length;
    const endCursor = slice.length ? Buffer.from(JSON.stringify({ i: start + slice.length - 1 })).toString("base64") : null;
    return Response.json({ data: { people: { pageInfo: { hasNextPage: more, endCursor }, edges: slice.map((p) => ({ node: /node \{ id \}/.test(query) ? { id: p.id } : node(p) })) } } });
  };
}

/** A reader that stops after `requests` Twenty calls (the deadline), with no pacing. */
const reader = (people: P[], requests = 1_000, seen: string[] = []) => {
  let n = 0;
  return new TwentyReader({ pauseMs: 0, sleep: async () => {}, now: () => n++ * 1000, deadline: requests * 1000 - 500, fetcher: fakeTwenty(people, seen) as typeof fetch });
};

const db = () => admin();
async function reset() {
  await db().from("gtm_crm_people").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  await db().from("gtm_sync_state").delete().eq("key", MIRROR_KEY);
}
const live = async () => (await db().from("gtm_crm_people").select("id", { count: "exact", head: true }).is("deleted_at", null)).count;

before(async () => { await seed(); });

test("backfill: stops at the deadline with its place saved, resumes next run, then matches Twenty's count", async () => {
  await reset();
  const people = dataset(250);
  const r1 = await runMirror(db(), reader(people, 2));
  assert.match(r1.stopped ?? "", /deadline/);
  const s1 = await loadMirrorState(db());
  assert.equal(s1?.backfillDone, false);
  assert.ok(s1?.changes.after, "the resume point is saved after each page");
  assert.equal(mirrorReadiness(s1).ready, false, "people are not measured while the mirror is still copying");
  const r2 = await runMirror(db(), reader(people));
  assert.equal(r2.stopped, undefined);
  assert.deepEqual(r2.counts, { twenty: 250, mirror: 250, match: true });
  const s2 = await loadMirrorState(db());
  assert.equal(s2?.backfillDone, true);
  assert.equal(mirrorReadiness(s2).ready, true);
  assert.equal(s2?.changes.since, people[249].updatedAt, "the cursor moves to the newest change seen");
  const row = (await db().from("gtm_crm_people").select("*").eq("id", uid(2)).single()).data!;
  assert.equal(row.has_email, true); assert.equal(row.email_verification, "VERIFIED"); assert.equal(row.not_sendable, true);
  assert.equal(row.created_by_member, WM);
  assert.equal(Object.keys(row).some((k) => /email$|name$/.test(k) && typeof row[k] === "string" && row[k].includes("@")), false, "no address is stored");
});

test("incremental: an hour later only changed and new people are read", async () => {
  await reset();
  const people = dataset(120);
  await runMirror(db(), reader(people));
  const later = iso(Date.parse("2026-11-09T00:00:00Z"));
  people[5] = { ...people[5], email: null, updatedAt: later };
  people.push({ ...dataset(121)[120], id: uid(999), createdAt: later, updatedAt: later });
  const seen: string[] = [];
  const r = await runMirror(db(), reader(people, 1_000, seen));
  assert.equal(r.changes.rows, 3, "the changed person, the new one, and the boundary row read again (the cursor is inclusive)");
  assert.equal(await live(), 121);
  assert.equal((await db().from("gtm_crm_people").select("has_email").eq("id", people[5].id).single()).data!.has_email, false);
});

test("a soft delete in Twenty marks the mirror row deleted, and counts still match", async () => {
  await reset();
  const people = dataset(60);
  await runMirror(db(), reader(people));
  const when = iso(Date.now() + 1000);
  people[3].deletedAt = when; people[4].deletedAt = when;
  const r = await runMirror(db(), reader(people));
  assert.equal(r.deletes.rows, 2);
  assert.deepEqual(r.counts, { twenty: 58, mirror: 58, match: true });
});

test("an erasure: two disagreeing count checks start a resync, and the id sweep marks the destroyed rows", async () => {
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
  assert.deepEqual(r3.counts, { twenty: 226, mirror: 226, match: true });
  const { data } = await db().from("gtm_crm_people").select("id").in("id", [...gone]).not("deleted_at", "is", null);
  assert.equal(data?.length, 4);
});

test("the sweep's breaker: it refuses to remove most of a page's range at once, and removes nothing", async () => {
  await reset();
  let people = dataset(200);
  await runMirror(db(), reader(people));
  people = people.filter((_, i) => i % 5 === 0);
  await runMirror(db(), reader(people));
  await runMirror(db(), reader(people));
  const r = await runMirror(db(), reader(people));
  assert.match(r.sweep?.error ?? "", /would remove/);
  assert.equal(await live(), 200, "nothing was marked deleted");
});

test("Twenty unhealthy: the run reads nothing", async () => {
  await reset();
  const seen: string[] = [];
  const r = await runMirror(db(), reader(dataset(10), 1_000, seen), { health: async () => false });
  assert.match(r.skipped ?? "", /healthz/);
  assert.equal(seen.length, 0);
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
  assert.deepEqual(fromSql.added, ref.added.filter((s) => s * 1000 >= Date.parse(fromSql.addedSince)));
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
  assert.ok(JSON.stringify(a).length < 200_000, "the cache row stays small");
});
