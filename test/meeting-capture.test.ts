// Meeting capture health (VIB-411): query shapes, the red/amber rules, and the not-installed fallback, against a
// mocked Twenty. No live service is reachable.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { installFetchMock } from "./support/fetch-mock.ts";

Object.assign(process.env, {
  NEXT_PUBLIC_SUPABASE_URL: "https://db.test", SUPABASE_SECRET_KEY: "sb_secret_test",
  TWENTY_BASE: "https://twenty.test", TWENTY_API_KEY: "tw_test",
});
const { captureHealth, captureQueries, crmSnapshot } = await import("../lib/twenty.ts");
const { syncCrm } = await import("../lib/sync.ts");
const { ownerStatus, countMap, schemaMiss, toRun, RED_ERROR_KEYS, pickCapture, withDeadline, emptyOwners } = await import("../lib/meeting-capture.ts");
type OwnerCapture = import("../lib/meeting-capture.ts").OwnerCapture;
type CaptureRun = import("../lib/meeting-capture.ts").CaptureRun;

const NOW = new Date("2026-10-05T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

const orig = globalThis.fetch;
afterEach(() => { globalThis.fetch = orig; });

/** Answers Twenty by root resolver; records every query. `answer` returns `data` or `{ errors }`. */
function twenty(answer: (q: string) => { data?: unknown; errors?: unknown[] } | undefined) {
  const queries: string[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    assert.equal(String(url), "https://twenty.test/graphql");
    const q = JSON.parse(String(init.body)).query as string;
    queries.push(q);
    const r = answer(q) ?? { errors: [{ message: `unexpected query ${q}` }] };
    return new Response(JSON.stringify(r), { status: r.errors ? 400 : 200 });
  }) as typeof fetch;
  return queries;
}

const ROOTS = /\b(people|companies|messages|opportunities|notes|meetingProposals|meetingCaptureRuns)\b/g;
const runNode = (owner: string, extra: Record<string, unknown> = {}) => ({
  mcrDay: "2026-10-05", mcrOwner: owner, mcrMode: "shadow", mcrNotesSeen: 6, mcrCaptured: 4, mcrProposalsCreated: 5,
  mcrProposalsApplied: 1, mcrPendingOldestDays: 3, mcrLlmCalls: 4, mcrUsd: 0.12, mcrMonthUsd: 1.5, mcrMonthCapUsd: 20,
  mcrStaleOpen: 0, mcrStates: { DONE: 4, INTERNAL: 1, NO_MATCH: 1 }, mcrErrors: {}, mcrLastSuccessAt: hoursAgo(1), updatedAt: hoursAgo(1), ...extra,
});

function installedAnswer(q: string) {
  if (q.includes("notes(")) return { data: { notes: { totalCount: 4 } } };
  if (q.includes("meetingProposals") && q.includes("totalCount")) return { data: { meetingProposals: { totalCount: q.includes("JOHN") ? 3 : 0 } } };
  if (q.includes("meetingProposals")) return { data: { meetingProposals: { edges: q.includes("JOHN") ? [{ node: { createdAt: hoursAgo(24 * 5 + 1) } }] : [] } } };
  if (q.includes("meetingCaptureRuns")) return { data: { meetingCaptureRuns: { edges: q.includes("JOHN") ? [{ node: runNode("JOHN") }] : [] } } };
}

test("capture queries: one root each, counts and heartbeat fields only, never Note bodies or people", () => {
  const all = [captureQueries.pending("JOHN"), captureQueries.oldestPending("ABE"), captureQueries.notes7d("2026-09-28T12:00:00.000Z"), captureQueries.latestRun("JOHN")];
  for (const q of all) {
    assert.equal((q.match(ROOTS) ?? []).length, 1, `one root per request: ${q}`);
    assert.doesNotMatch(q, /bodyV2|body|markdown|people|person|email|name\b/i, q);
  }
  assert.equal(captureQueries.pending("JOHN"), "{ meetingProposals(filter:{mpStatus:{eq:PENDING}, mpOwner:{eq:JOHN}}) { totalCount } }");
  assert.match(captureQueries.oldestPending("ABE"), /mpOwner:\{eq:ABE\}.*orderBy:\[\{createdAt:AscNullsLast\}\], first:1\) \{ edges \{ node \{ createdAt \} \} \}/);
  assert.equal(captureQueries.notes7d("2026-09-28T12:00:00.000Z"), '{ notes(filter:{title:{like:"[meeting-capture]%"}, createdAt:{gte:"2026-09-28T12:00:00.000Z"}}) { totalCount } }');
  const run = captureQueries.latestRun("JOHN");
  assert.match(run, /meetingCaptureRuns\(filter:\{mcrOwner:\{eq:JOHN\}\}, orderBy:\[\{mcrDay:DescNullsLast\}/);
  for (const f of ["mcrMode", "mcrStaleOpen", "mcrStates", "mcrErrors", "mcrMonthCapUsd", "mcrLastSuccessAt", "updatedAt"]) assert.ok(run.includes(f), f);
});

test("captureHealth installed: per-owner pending, oldest pending days, notes in 7 days, latest heartbeat", async () => {
  const queries = twenty(installedAnswer);
  const h = await captureHealth(NOW);
  assert.equal(h.installed, true);
  assert.equal(h.error, undefined);
  assert.equal(h.notes7d, 4);
  assert.equal(h.owners.JOHN.pending, 3);
  assert.equal(h.owners.JOHN.oldestPendingDays, 5, "time in the queue, by createdAt");
  assert.equal(h.owners.ABE.pending, 0);
  assert.equal(h.owners.ABE.oldestPendingDays, null);
  assert.equal(h.owners.ABE.run, null, "no heartbeat row ever");
  assert.equal(h.owners.JOHN.run?.mode, "shadow");
  assert.deepEqual(h.owners.JOHN.run?.states, { DONE: 4, INTERNAL: 1, NO_MATCH: 1 });
  assert.equal(queries.length, 7);
  for (const q of queries) assert.equal((q.match(ROOTS) ?? []).length, 1, q);
  const since = new Date(NOW.getTime() - 7 * 86400_000).toISOString();
  assert.ok(queries.some((q) => q.includes(`createdAt:{gte:"${since}"}`)));
});

test("not installed: unknown object errors give installed=false, no throw, and the funnel snapshot still saves", async () => {
  const miss = (name: string) => ({ errors: [{ message: `Cannot query field "${name}" on type "Query".` }] });
  const queries = twenty((q) => {
    if (q.includes("meetingProposals")) return miss("meetingProposals");
    if (q.includes("meetingCaptureRuns")) return miss("meetingCaptureRuns");
    if (q.includes("notes(")) return { data: { notes: { totalCount: 0 } } };
    if (q.includes("people")) return { data: { people: { totalCount: 10 } } };
    if (q.includes("companies")) return { data: { companies: { totalCount: 2 } } };
    if (q.includes("messages")) return { data: { messages: { totalCount: 0 } } };
    if (q.includes("opportunities")) return { data: { opportunities: { edges: [] } } };
  });
  const snap = await crmSnapshot();
  assert.equal(snap.metrics.people, 10);
  assert.equal(snap.meeting_capture.installed, false);
  assert.deepEqual(snap.meeting_capture.missing?.sort(), ["meetingCaptureRun", "meetingProposal"]);
  assert.equal(snap.meeting_capture.error, undefined);
  // Stops asking for a missing object after the first rejection.
  assert.equal(queries.filter((q) => q.includes("meetingProposals")).length, 1);
  assert.equal(queries.filter((q) => q.includes("meetingCaptureRuns")).length, 1);
});

test("an unknown filter field marks that object missing; proposals missing alone keeps the heartbeat visible", async () => {
  twenty((q) => {
    if (q.includes("meetingProposals")) return { errors: [{ message: 'Field "mpStatus" is not defined by type "MeetingProposalFilterInput".' }] };
    if (q.includes("meetingCaptureRuns")) return { data: { meetingCaptureRuns: { edges: [] } } };
    if (q.includes("notes(")) return { data: { notes: { totalCount: 0 } } };
  });
  const h = await captureHealth(NOW);
  assert.equal(h.installed, true, "installed follows the heartbeat object");
  assert.deepEqual(h.missing, ["meetingProposal"]);
  assert.equal(h.owners.JOHN.pending, null);
  assert.equal(h.error, undefined);
});

test("an unknown enum value is an error, not 'not installed' (John's live capture must still show)", async () => {
  twenty((q) => (q.includes("ABE") && q.includes("meetingCaptureRuns")
    ? { errors: [{ message: 'Value "ABE" does not exist in "MeetingCaptureRunMcrOwnerEnum" enum.' }] } : installedAnswer(q)));
  const h = await captureHealth(NOW);
  assert.equal(h.installed, true);
  assert.equal(h.missing, undefined);
  assert.match(h.error ?? "", /does not exist in/);
  assert.equal(h.owners.JOHN.run?.mode, "shadow");
});

test("a missing heartbeat field is dropped and retried; the rest of the row still shows", async () => {
  const queries = twenty((q) => {
    if (q.includes("meetingCaptureRuns") && q.includes("mcrMode")) return { errors: [
      { message: 'Cannot query field "mcrMode" on type "MeetingCaptureRun".' },
      { message: 'Cannot query field "mcrStaleOpen" on type "MeetingCaptureRun".' },
    ] };
    if (q.includes("meetingCaptureRuns")) {
      assert.doesNotMatch(q, /mcrStaleOpen/);
      const { mcrMode, mcrStaleOpen, ...node } = runNode("JOHN");
      return { data: { meetingCaptureRuns: { edges: q.includes("JOHN") ? [{ node }] : [] } } };
    }
    return installedAnswer(q);
  });
  const h = await captureHealth(NOW);
  assert.equal(h.installed, true);
  assert.deepEqual(h.missingFields, ["meetingCaptureRun.mcrMode", "meetingCaptureRun.mcrStaleOpen"]);
  assert.equal(h.owners.JOHN.run?.mode, null);
  assert.equal(h.owners.JOHN.run?.captured, 4);
  assert.equal(h.error, undefined);
  // JOHN: one rejected + one retried; ABE reuses the reduced field list.
  assert.equal(queries.filter((q) => q.includes("meetingCaptureRuns")).length, 3);
});

test("a schema error on the native notes query is an error, never 'not installed'", async () => {
  twenty((q) => (q.includes("notes(") ? { errors: [{ message: 'Cannot query field "notes" on type "Query".' }] } : installedAnswer(q)));
  const h = await captureHealth(NOW);
  assert.equal(h.installed, true);
  assert.equal(h.missing, undefined);
  assert.match(h.error ?? "", /notes/);
});

test("an outage on a capture query is recorded as an error, never thrown, and is not 'not installed'", async () => {
  twenty((q) => (q.includes("meetingCaptureRuns") ? { errors: [{ message: "Internal server error" }] } : installedAnswer(q)));
  const h = await captureHealth(NOW);
  assert.equal(h.installed, true);
  assert.match(h.error ?? "", /Internal server error/);
  assert.equal(h.owners.JOHN.pending, 3);
});

test("syncCrm stores the capture block inside the metrics JSON, not as a new column", async () => {
  const m = installFetchMock([
    { method: "POST", url: "https://db.test/rest/v1/gtm_crm_snapshots", status: 201 },
  ]);
  const fetchMock = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    if (String(url).startsWith("https://twenty.test")) {
      const q = JSON.parse(String(init.body)).query as string;
      const r = installedAnswer(q) ?? (q.includes("opportunities") ? { data: { opportunities: { edges: [] } } } : { data: { people: { totalCount: 1 }, companies: { totalCount: 1 }, messages: { totalCount: 1 } } });
      return new Response(JSON.stringify(r), { status: 200 });
    }
    return fetchMock(url, init);
  }) as typeof fetch;
  try {
    await syncCrm();
    const row = JSON.parse(m.calls.at(-1)!.body!);
    assert.deepEqual(Object.keys(row).sort(), ["captured_at", "date", "metrics", "opportunities"]);
    assert.equal(row.metrics.meeting_capture.installed, true);
    assert.equal(row.metrics.meeting_capture.owners.JOHN.pending, 3);
  } finally { m.restore(); }
});

const run = (extra: Partial<CaptureRun> = {}): CaptureRun => ({
  ...toRun(runNode("JOHN")), ...extra,
});
const owner = (r: CaptureRun | null, extra: Partial<OwnerCapture> = {}): OwnerCapture => ({ pending: 0, oldestPendingDays: null, run: r, ...extra });

test("rules: no heartbeat row ever is not onboarded, never red", () => {
  const s = ownerStatus(owner(null, { pending: 2 }), NOW);
  assert.equal(s.status, "not_onboarded");
  assert.deepEqual(s.flags, []);
});

test("rules: a fresh heartbeat with clean counts is ok", () => {
  const s = ownerStatus(owner(run()), NOW);
  assert.equal(s.status, "ok");
  assert.deepEqual(s.flags, []);
  assert.ok(Math.abs(s.heartbeatHours! - 1) < 0.01);
});

test("rules: heartbeat older than 26 hours is red; 25 hours is not", () => {
  assert.equal(ownerStatus(owner(run({ updatedAt: hoursAgo(25), lastSuccessAt: hoursAgo(25) })), NOW).status, "ok");
  const s = ownerStatus(owner(run({ updatedAt: hoursAgo(27), lastSuccessAt: hoursAgo(27) })), NOW);
  assert.equal(s.status, "red");
  assert.ok(s.flags.some((f) => /Heartbeat 27h old/.test(f.text)));
});

test("rules: a row with a missing heartbeat time or no successful cycle is red", () => {
  assert.equal(ownerStatus(owner(run({ updatedAt: null })), NOW).status, "red");
  const s = ownerStatus(owner(run({ lastSuccessAt: null })), NOW);
  assert.equal(s.status, "red");
  assert.ok(s.flags.some((f) => /No successful cycle/.test(f.text)));
});

test("rules: any note seen but not terminal after 24h (mcrStaleOpen > 0) is red", () => {
  const s = ownerStatus(owner(run({ staleOpen: 1 })), NOW);
  assert.equal(s.status, "red");
  assert.deepEqual(s.flags, [{ level: "red", text: "1 note seen but not finished after 24h" }]);
});

test("rules: each of granolaAuth, breaker, UNCERTAIN, budgetCap non-zero is red; other codes are not", () => {
  for (const k of RED_ERROR_KEYS) {
    const s = ownerStatus(owner(run({ errors: { [k]: 1 } })), NOW);
    assert.equal(s.status, "red", k);
    assert.ok(s.flags.some((f) => f.text === `${k}: 1`), k);
    assert.equal(ownerStatus(owner(run({ errors: { [k]: 0 } })), NOW).status, "ok", `${k}: 0`);
  }
  assert.equal(ownerStatus(owner(run({ errors: { twentyTimeout: 5 } })), NOW).status, "ok");
});

test("rules: alert keys raised by the capture host are red with readable text (VIB-427)", () => {
  const s = ownerStatus(owner(run({ errors: { "ValueError:write": 4, "alert:failingCycles": 4, "alert:poisonedPlans": 1 } })), NOW);
  assert.equal(s.status, "red");
  assert.ok(s.flags.some((f) => f.text === "Failing: 4 consecutive cycles ended with an error"));
  assert.ok(s.flags.some((f) => f.text === "1 meeting stuck: the same error repeats on every retry"));
  assert.equal(ownerStatus(owner(run({ errors: { "alert:failingCycles": 0, "alert:poisonedPlans": 0 } })), NOW).status, "ok");
});

test("rules: errors with no clean cycle for 45 minutes before the heartbeat are red; one failed cycle is not (VIB-427)", () => {
  // The live shape of the incident: a fresh heartbeat every 15 minutes, an unlisted code, last success days earlier.
  const stuck = ownerStatus(owner(run({ errors: { "ValueError:write": 39 }, updatedAt: hoursAgo(0.2), lastSuccessAt: hoursAgo(20) })), NOW);
  assert.equal(stuck.status, "red");
  assert.ok(stuck.flags.some((f) => /Every cycle failing since the last clean one \(ValueError:write 39\)/.test(f.text)));
  assert.equal(ownerStatus(owner(run({ errors: { "ValueError:write": 1 }, updatedAt: hoursAgo(0.2), lastSuccessAt: hoursAgo(0.5) })), NOW).status, "ok");
  // A day's earlier error that has since cleared (the heartbeat's last success is the heartbeat itself) stays ok.
  assert.equal(ownerStatus(owner(run({ errors: { twentyTimeout: 5 } })), NOW).status, "ok");
});

test("rules: oldest pending over 14 days is amber (from the heartbeat or the proposals), 14 is not", () => {
  assert.equal(ownerStatus(owner(run({ pendingOldestDays: 14 })), NOW).status, "ok");
  assert.equal(ownerStatus(owner(run({ pendingOldestDays: 15 })), NOW).status, "amber");
  assert.equal(ownerStatus(owner(run({ pendingOldestDays: 0 }), { oldestPendingDays: 20 }), NOW).status, "amber");
  // Red wins over amber.
  assert.equal(ownerStatus(owner(run({ pendingOldestDays: 20, staleOpen: 2 })), NOW).status, "red");
});

test("countMap and schemaMiss parse defensively", () => {
  assert.deepEqual(countMap('{"DONE":3,"bad":"x","EXCLUDED":"1"}'), { DONE: 3, EXCLUDED: 1 });
  assert.deepEqual(countMap(null), {});
  assert.deepEqual(countMap("not json"), {});
  assert.deepEqual(countMap([1, 2]), {});
  assert.deepEqual(schemaMiss([{ message: 'Cannot query field "meetingCaptureRuns" on type "Query".' }]), { objectMissing: true, fields: [] });
  assert.deepEqual(schemaMiss([{ message: 'Cannot query field "mcrUsd" on type "MeetingCaptureRun".' }]), { objectMissing: false, fields: ["mcrUsd"] });
  assert.deepEqual(schemaMiss([{ message: 'Field "mcrDay" is not defined by type "MeetingCaptureRunOrderByInput".' }]), { objectMissing: true, fields: [] });
  assert.equal(schemaMiss([{ message: 'Value "ABE" does not exist in "X" enum.' }]), null);
  assert.equal(schemaMiss([{ message: 'Unknown argument "orderBy" on field "Query.meetingProposals".' }]), null);
  assert.equal(schemaMiss([{ message: "Duplicate root resolver" }]), null);
  assert.equal(schemaMiss([]), null);
  assert.equal(schemaMiss(undefined), null);
});

test("the /funnel card uses a live read only when it is clean and installed, else the snapshot (VIB-427)", () => {
  const snap = { installed: true, notes7d: 4, owners: emptyOwners() };
  const good = { installed: true, notes7d: 2, owners: emptyOwners() };
  assert.deepEqual(pickCapture(good, snap), { health: good, live: true });
  assert.deepEqual(pickCapture({ ...good, error: "Twenty could not be read" }, snap), { health: snap, live: false });
  assert.deepEqual(pickCapture({ ...good, installed: false }, snap), { health: snap, live: false });
  assert.deepEqual(pickCapture(null, snap), { health: snap, live: false });
  assert.deepEqual(pickCapture(null, undefined), { health: undefined, live: false });
});

test("withDeadline gives up on a slow read and passes a fast one through (VIB-427)", async () => {
  await assert.rejects(withDeadline(new Promise(() => {}), 20), /no answer within/);
  assert.equal(await withDeadline(Promise.resolve(7), 1000), 7);
  await assert.rejects(withDeadline(Promise.reject(new Error("boom")), 1000), /boom/);
});
