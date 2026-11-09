// Meetings from Google Calendar (VIB-518): which events count, the kind rules (same as the Granola meeting ledger), the
// deny-list, and the sync end to end against fake Google, Twenty and database: create, adopt, update, withdraw, the
// person's word, the breaker and the never-recreate rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";

Object.assign(process.env, {
  TEAM_MAILBOX_KEY: randomBytes(32).toString("base64"), TWENTY_API_KEY: "twenty_test", TWENTY_BASE: "https://crm.test",
  TEAM_GMAIL_CLIENT_ID: "client.apps.test", TEAM_GMAIL_CLIENT_SECRET: "secret", TEAM_IGNORE_DOMAINS: "", GTM_TEAM_MEMBERS: "",
  MEETING_DENY_LIST: JSON.stringify({ domains: ["secret-client.test"], organizations: ["Hush Corp"] }),
});
delete process.env.DEMO_MODE;
const C = await import("../lib/team/calendar.ts");
const { sealToken, eventKey } = await import("../lib/team/crypto.ts");
const { TwentyReader } = await import("../lib/twenty.ts");
const { authUrl } = await import("../lib/team/mailbox.ts");
const { runProblems } = await import("../lib/sales/run.ts");
const TW = await import("../lib/twenty.ts");

const SELF = "john@example-founder.test";
const ev = (id: string, start: string, emails: string[], extra: Partial<import("../lib/team/calendar.ts").GEvent> = {}) => ({
  id, status: "confirmed", start: { dateTime: start },
  attendees: [{ email: SELF, self: true, responseStatus: "accepted" }, ...emails.map((email) => ({ email, displayName: email.split("@")[0], responseStatus: "accepted" }))],
  ...extra,
});

/* ------------------------------------------------------------------------------------------------ pure rules */

test("a private event without outside guests is just internal; with guests it is withheld as private", () => {
  const s = C.sortEvents([
    ev("solo", "2026-11-04T16:00:00+08:00", [], { visibility: "private" }),
    ev("guests", "2026-11-04T16:00:00+08:00", ["rob@pikl.test"], { visibility: "private" }),
  ], SELF, [], [], (x) => x);
  assert.deepEqual(Object.fromEntries(s.gone.map((g) => [g.key, g.why])), { solo: "internal", guests: "private" });
});

test("a gmail calendar does not drop gmail guests as its own domain", () => {
  const s = C.sortEvents([ev("g", "2026-11-04T16:00:00+08:00", ["friend@gmail.com"])], "me@gmail.com", [], [], (x) => x);
  assert.deepEqual(s.live.map((e) => e.externals), [["friend@gmail.com"]]);
});

test("an event's identity is its iCalendar UID (plus the instance start), the same on every attendee's copy", () => {
  assert.equal(C.eventIdentity({ id: "a1", iCalUID: "uid@outlook" }), "uid@outlook");
  assert.equal(C.eventIdentity({ id: "a1_20261104", iCalUID: "uid@google", originalStartTime: { dateTime: "2026-11-04T08:00:00Z" } }), "uid@google|2026-11-04T08:00:00.000Z");
  assert.equal(C.eventIdentity({ id: "a1" }), "a1");
  assert.match(C.rowId("k".repeat(32), "JOHN"), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(C.rowId("k".repeat(32), "JOHN"), C.rowId("k".repeat(32), "JOHN"), "deterministic");
  assert.notEqual(C.rowId("k".repeat(32), "JOHN"), C.rowId("j".repeat(32), "JOHN"));
  assert.notEqual(C.rowId("k".repeat(32), "JOHN"), C.rowId("k".repeat(32), "ABE"), "per member");
  assert.equal(C.eventIdentity({ id: "x", iCalUID: "u", originalStartTime: { dateTime: "2026-11-04T16:00:00+08:00" } }),
    C.eventIdentity({ id: "y", iCalUID: "u", originalStartTime: { dateTime: "2026-11-04T09:00:00+01:00" } }), "an instance is the same instant in any calendar's time zone");
});

test("the breaker matches the ledger: more than 3, or at least 2 and more than 20%", () => {
  assert.equal(C.breakerTripped(1, 1), false);
  assert.equal(C.breakerTripped(2, 20), false);
  assert.equal(C.breakerTripped(2, 5), true);
  assert.equal(C.breakerTripped(4, 100), true);
});

test("a stored error never carries an address or Twenty's echoed text", () => {
  const { TwentyError } = TW;
  assert.equal(C.safeError(new TwentyError("Twenty: value ann@x.test is invalid", [{ message: "ann@x.test", extensions: { code: "BAD_USER_INPUT" } }])), "Twenty refused a request (BAD_USER_INPUT)");
  assert.equal(C.safeError(new Error("no match for bob@acme.test")), "no match for <address>");
});

test("only real meetings with an outside guest are candidates, each skip with its reason", () => {
  const s = C.sortEvents([
    ev("ok", "2026-11-04T16:00:00+08:00", ["rob@pikl.test", "abe@vibranahq.com", "room@resource.calendar.google.com"]),
    ev("cancelled", "2026-11-04T16:00:00+08:00", ["rob@pikl.test"], { status: "cancelled" }),
    ev("focus", "2026-11-04T16:00:00+08:00", ["rob@pikl.test"], { eventType: "focusTime" }),
    ev("private", "2026-11-04T16:00:00+08:00", ["doctor@clinic.test"], { visibility: "private" }),
    { id: "allday", start: { date: "2026-11-04" }, attendees: [{ email: "rob@pikl.test" }] },
    ev("declined", "2026-11-04T16:00:00+08:00", ["rob@pikl.test"], { attendees: [{ email: SELF, self: true, responseStatus: "declined" }, { email: "rob@pikl.test" }] }),
    ev("internal", "2026-11-04T16:00:00+08:00", ["abe@vibranahq.com", "x@john-ellison.com"]),
    ev("webinar", "2026-11-04T16:00:00+08:00", Array.from({ length: 16 }, (_, i) => `p${i}@big.test`)),
  ], SELF, ["abe@vibranahq.com"], [], (x) => x);
  assert.deepEqual(s.live.map((e) => e.key), ["ok"]);
  assert.deepEqual(s.live[0].externals, ["rob@pikl.test"], "team, resource and self addresses are not outside guests");
  assert.equal(s.live[0].day, "2026-11-04", "the record's date is the event's own local date");
  assert.equal(s.live[0].start, "2026-11-04T08:00:00.000Z");
  assert.deepEqual(Object.fromEntries(s.gone.map((g) => [g.key, g.why])),
    { cancelled: "cancelled", focus: "not_a_meeting", private: "private", allday: "all_day", declined: "declined", internal: "internal", webinar: "large_event" });
});

test("the event mask never asks Google for titles, descriptions or locations", () => {
  assert.doesNotMatch(C.EVENT_FIELDS, /summary|description|location|hangout|conference/);
});

test("kinds follow the ledger: won deal or client, then open deal or prospect, then partner, else other", () => {
  assert.equal(C.kindOf([], [{ id: "o", stage: "SIGNED", companyId: "c" }]), "CLIENT");
  assert.equal(C.kindOf([{ id: "p", gtmRelationship: "Former client" }], []), "CLIENT");
  assert.equal(C.kindOf([], [{ id: "o", stage: "PROPOSAL", companyId: "c" }]), "DISCOVERY");
  assert.equal(C.kindOf([{ id: "p", gtmQueue: "BUYER_CHAMPION" }], []), "DISCOVERY");
  assert.equal(C.kindOf([{ id: "p", gtmQueue: "BUYER_CHAMPION", gtmMarketingConsent: "UNSUBSCRIBED" }], []), "OTHER", "a protected person is not an eligible prospect");
  assert.equal(C.kindOf([{ id: "p", gtmQueue: "PARTNER" }], []), "PARTNER");
  assert.equal(C.kindOf([{ id: "p" }], [{ id: "o", stage: "LOST", companyId: "c" }]), "OTHER");
});

test("choose: strongest kind wins, a suppressed person is never linked, a domain falls back to the company", () => {
  const opps = [{ id: "won", stage: "SIGNED", companyId: "pikl" }, { id: "open", stage: "PROPOSAL", companyId: "peri" }];
  const byEmail = new Map([
    ["a@x.test", [{ id: "pa", name: { firstName: "Ann", lastName: "Lee" } }]],
    ["rob@pikl.test", [{ id: "pr", companyId: "pikl", company: { id: "pikl", name: "Pikl" } }]],
    ["gone@pikl.test", [{ id: "ps", gtmQueue: "SUPPRESSED", companyId: "pikl", company: { id: "pikl", name: "Pikl" } }]],
    ["solo@x.test", [{ id: "pz", gtmQueue: "SUPPRESSED" }]],
    ["twin@x.test", [{ id: "t1" }, { id: "t2" }]],
  ]);
  const byDomain = new Map([["peri.test", [{ id: "peri", name: "Peridot", domainName: { primaryLinkUrl: "https://www.peri.test" } }]]]);
  const c1 = C.choose(["a@x.test", "rob@pikl.test"], byEmail, byDomain, opps)!;
  assert.equal(c1.kind, "CLIENT"); assert.equal(c1.person!.id, "pr"); assert.equal(c1.deal!.id, "won");
  const c2 = C.choose(["gone@pikl.test"], byEmail, byDomain, opps)!;
  assert.equal(c2.person, null, "a suppressed person is not linked"); assert.equal(c2.company!.id, "pikl");
  assert.equal(C.choose(["solo@x.test"], byEmail, byDomain, opps), null, "a suppressed person with no company is no meeting");
  assert.equal(C.choose(["twin@x.test"], byEmail, byDomain, opps), null, "an address two CRM people share is skipped");
  const c3 = C.choose(["ramsay@peri.test"], byEmail, byDomain, opps)!;
  assert.equal(c3.kind, "DISCOVERY"); assert.equal(c3.company!.name, "Peridot"); assert.equal(c3.deal!.id, "open");
  assert.equal(C.composeName("2026-11-04", c3), "2026-11-04 meeting: Peridot");
  assert.equal(C.composeName("2026-11-04", C.choose(["a@x.test"], byEmail, byDomain, opps)!), "2026-11-04 meeting: Ann Lee");
});

test("the deny-list fails closed and catches domains, organization names and matched companies", () => {
  assert.equal(C.denyList({}), null);
  assert.equal(C.denyList({ MEETING_DENY_LIST: "not json" }), null);
  for (const bad of ["{}", "[]", '{"domains":[],"organisations":["Hush Corp"]}', '{"domains":[]}', '{"domains":"x","organizations":[]}'])
    assert.equal(C.denyList({ MEETING_DENY_LIST: bad }), null, `a malformed list fails closed: ${bad}`);
  assert.equal(C.denyList({ MEETING_DENY_LIST: '{"domains":[],"organizations":[],"organisations":["Hush Corp"]}' }), null, "an unknown key fails closed");
  assert.deepEqual(C.denyList({ MEETING_DENY_LIST: '{"domains":[],"organizations":[]}' }), { domains: [], organizations: [] }, "an intentionally empty list");
  const d = C.denyList()!;
  assert.ok(C.eventDenied(["a@mail.secret-client.test"], [], d));
  assert.ok(C.eventDenied(["a@gmail.com"], ["Pat (Hush Corp)"], d));
  assert.ok(C.eventDenied(["a@hush-corp.test"], [], d), "an organization in the domain labels");
  assert.ok(!C.eventDenied(["a@hushcorporate.test"], ["Pat"], d), "a longer word that merely starts with the name is not a hit");
  assert.ok(C.companyDenied({ name: "Hush Corp Ltd", domain: null }, d));
  assert.ok(!C.companyDenied({ name: "Pikl", domain: "pikl.test" }, d));
});

test("a person's word: manual kinds keep kind and links, time and name still follow the event", () => {
  const want = C.rowFields({ key: "k".repeat(32), start: "2026-11-05T08:00:00.000Z", day: "2026-11-05", externals: 2,
    choice: { person: null, company: { id: "c2", name: "New Co", domain: null }, deal: null, kind: "DISCOVERY" } }, "JOHN");
  const row = { id: "r", name: "2026-11-04 meeting: Old", mtgAt: "2026-11-04T08:00:00.000Z", mtgOwner: "JOHN", mtgKind: "CLIENT", mtgKindSource: "AUTO",
    mtgAutoKind: "OTHER", mtgCompanyId: "c1", mtgPersonId: null, mtgOpportunityId: null, mtgExternalCount: 1, mtgCaptureKey: want.mtgCaptureKey };
  assert.ok(C.isManual(row), "a kind different from the automatic one is a person's word");
  assert.deepEqual(Object.keys(C.rowChanges(row, want)).sort(), ["mtgAt", "mtgExternalCount", "name"]);
  assert.equal(C.rowChanges(row, want).name, "2026-11-05 meeting: Old", "a manual row keeps its own label; only the date follows the event");
  assert.deepEqual(Object.keys(C.rowChanges({ ...row, mtgKind: "OTHER" }, want)).sort(), ["mtgAt", "mtgAutoKind", "mtgCompanyId", "mtgExternalCount", "mtgKind", "name"]);
});

test("disconnecting a calendar revokes only when no mailbox and no other member's calendar uses the account", () => {
  const src = readFileSync(new URL("../app/pipeline/meetings/actions.ts", import.meta.url), "utf8");
  assert.match(src, /from\("gtm_team_mailboxes"\)\.select\("member"\)\.eq\("address", row\.address\)/);
  assert.match(src, /from\("gtm_team_calendars"\)\.select\("member"\)\.eq\("address", row\.address\)\.neq\("member", row\.member\)/);
  assert.match(src, /if \(!mailbox\.error && !mailbox\.data\?\.length && !other\.error && !other\.data\?\.length\) \{\s*try \{ await revokeToken/);
  assert.equal((src.match(/revokeToken\(/g) ?? []).length, 1);
});

test("the consent URL asks only for calendar read access and lets the member pick the account", () => {
  const u = new URL(authUrl({ clientId: "c", redirectUri: "https://gtm.test/api/team/mailbox/callback", state: "s", challenge: "x", scopes: C.calendarScopes(), prompt: "select_account consent" }));
  assert.equal(u.searchParams.get("scope"), "openid email https://www.googleapis.com/auth/calendar.readonly");
  assert.equal(u.searchParams.get("prompt"), "select_account consent");
  assert.equal(u.searchParams.has("login_hint"), false);
});

test("the pipeline run reports a missing deny-list or a calendar error, not an unconnected calendar", () => {
  const at = new Date().toISOString();
  assert.deepEqual(runProblems({ at, result: { calendar: { skipped: "no calendar connected" } } }, new Date()), []);
  assert.match(runProblems({ at, result: { calendar: { skipped: "MEETING_DENY_LIST is not set" } } }, new Date()).join(), /Calendar meetings: MEETING_DENY_LIST/);
  assert.match(runProblems({ at, result: { calendar: { calendars: { "JOHN:j@x.test": { events: 0, business: 0, created: 0, updated: 0, adopted: 0, removed: 0, kept: 0, error: "Google Calendar 403" } } } } }, new Date()).join(), /Calendar JOHN: Google Calendar 403/);
});


/* ------------------------------------------------------------------------------------------------ sync end to end */

type Row = Record<string, unknown>;
/** Just enough of the Supabase client for the sync: filters by eq/neq, range paging, upsert by key, update, delete, leases. */
function fakeDb(tables: Record<string, Row[]>, keys: Record<string, string[]> = { gtm_calendar_meetings: ["member", "event_key"], gtm_sync_state: ["key"] }) {
  const leases = new Set<string>();
  const from = (table: string) => {
    const st: { op: string; payload: Row | null; filters: ((r: Row) => boolean)[]; range?: [number, number] } = { op: "select", payload: null, filters: [] };
    const run = () => {
      const arr = (tables[table] ??= []);
      const hit = (r: Row) => st.filters.every((f) => f(r));
      if (st.op === "select") { const rows = arr.filter(hit).map((r) => ({ ...r })); return { data: st.range ? rows.slice(st.range[0], st.range[1] + 1) : rows, error: null }; }
      if (st.op === "update") for (const r of arr.filter(hit)) Object.assign(r, st.payload);
      if (st.op === "delete") tables[table] = arr.filter((r) => !hit(r));
      if (st.op === "upsert") {
        const p = st.payload!, k = keys[table] ?? ["id"];
        const i = arr.findIndex((r) => k.every((c) => r[c] === p[c]));
        if (i >= 0) Object.assign(arr[i], p); else arr.push({ removed_at: null, removed_reason: null, ...p });
      }
      return { data: null, error: null };
    };
    const api: Record<string, unknown> = {
      select: () => api, order: () => api, limit: () => api,
      eq: (k: string, v: unknown) => { st.filters.push((r) => r[k] === v); return api; },
      neq: (k: string, v: unknown) => { st.filters.push((r) => r[k] !== v); return api; },
      range: (a: number, b: number) => { st.range = [a, b]; return api; },
      update: (p: Row) => { st.op = "update"; st.payload = p; return api; },
      upsert: (p: Row) => { st.op = "upsert"; st.payload = p; return api; },
      delete: () => { st.op = "delete"; return api; },
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
    };
    return api;
  };
  const rpc = async (fn: string, a: { p_job: string; p_holder: string }) => {
    if (fn === "gtm_take_lease") { if (leases.has(a.p_job)) return { data: false, error: null }; leases.add(a.p_job); return { data: true, error: null }; }
    leases.delete(a.p_job); return { data: null, error: null };
  };
  return { from, rpc, tables, leases } as unknown as SupabaseClient & { tables: Record<string, Row[]>; leases: Set<string> };
}

type Meeting = Row & { id: string };
/** A Twenty that honors the filters the sync sends (owner, time, ids, trash), refuses a duplicate id, and soft-deletes. */
function fakeTwenty(state: { people: Row[]; companies: Row[]; opps: Row[]; meetings: Meeting[] }, opts: { failFirstCreate?: boolean } = {}) {
  const writes: { op: string; id?: string; data?: Row }[] = [];
  const trash: Meeting[] = [];
  let failNext = !!opts.failFirstCreate;
  const conn = (rows: Row[]) => ({ pageInfo: { hasNextPage: false, endCursor: null }, edges: rows.map((node) => ({ node })) });
  type F = Record<string, unknown>;
  const match = (r: Row, f: F | undefined): boolean => {
    if (!f) return true;
    if (Array.isArray(f.and)) return (f.and as F[]).every((x) => match(r, x));
    if (Array.isArray(f.or)) return (f.or as F[]).some((x) => match(r, x));
    return Object.entries(f).every(([k, cond]) => {
      if (k === "deletedAt") return true;  // trash is a separate list here
      const c = cond as Record<string, unknown>;
      if (k === "emails") {
        const e = r.emails as { primaryEmail?: string; additionalEmails?: string[] } | undefined;
        const pe = (c.primaryEmail as { ilike?: string } | undefined)?.ilike;
        if (pe) return (e?.primaryEmail ?? "").toLowerCase() === pe.replace(/\\/g, "").toLowerCase();
        const ae = (c.additionalEmails as { like?: string } | undefined)?.like;
        return !!ae && JSON.stringify(e?.additionalEmails ?? []).includes(ae.replace(/%/g, "").replace(/\\/g, ""));
      }
      if (k === "domainName") return String((r.domainName as Row | undefined)?.primaryLinkUrl ?? "").includes(String((c.primaryLinkUrl as { ilike: string }).ilike).replace(/%/g, ""));
      const v = r[k];
      if ("eq" in c) return v === c.eq;
      if ("in" in c) return (c.in as unknown[]).includes(v);
      if ("gte" in c) return !!v && String(v) >= String(c.gte);
      if ("lte" in c) return !!v && String(v) <= String(c.lte);
      return true;
    });
  };
  const wantsTrash = (f: F | undefined) => JSON.stringify(f ?? {}).includes("NOT_NULL");
  const fetcher = (async (_url: string, init: RequestInit) => {
    const { query, variables } = JSON.parse(String(init.body)) as { query: string; variables: { f?: F; d?: Row; id?: string } };
    const reply = (data: unknown, status = 200) => new Response(JSON.stringify(status === 200 ? { data } : {}), { status, headers: { "content-type": "application/json" } });
    if (query.includes("createMeeting")) {
      const d = variables.d!, id = String(d.id);
      if (state.meetings.some((m) => m.id === id) || trash.some((m) => m.id === id))
        return new Response(JSON.stringify({ errors: [{ message: "duplicate key", extensions: { code: "BAD_USER_INPUT" } }] }), { status: 200 });
      state.meetings.push({ ...d, id } as Meeting); writes.push({ op: "create", id, data: d });
      // The row commits, the answer is lost: the reader retries the same create.
      if (failNext) { failNext = false; return reply(null, 502); }
      return reply({ createMeeting: { id } });
    }
    if (query.includes("updateMeeting")) { Object.assign(state.meetings.find((m) => m.id === variables.id)!, variables.d); writes.push({ op: "update", id: variables.id, data: variables.d }); return reply({ updateMeeting: { id: variables.id } }); }
    if (query.includes("deleteMeeting")) {
      const i = state.meetings.findIndex((m) => m.id === variables.id);
      trash.push(...state.meetings.splice(i, 1)); writes.push({ op: "delete", id: variables.id }); return reply({ deleteMeeting: { id: variables.id } });
    }
    const list = (name: string, rows: Row[]) => reply({ [name]: conn(rows.filter((r) => match(r, variables.f))) });
    if (query.includes("people(")) return list("people", wantsTrash(variables.f) ? [] : state.people);
    if (query.includes("companies(")) return list("companies", state.companies);
    if (query.includes("opportunities(")) return list("opportunities", state.opps);
    if (query.includes("meetings(")) return list("meetings", wantsTrash(variables.f) ? trash : state.meetings);
    throw new Error(`unexpected Twenty query ${query.slice(0, 60)}`);
  }) as unknown as typeof fetch;
  return { fetcher, writes, state, trash, creates: () => writes.filter((w) => w.op === "create") };
}

function google(events: () => unknown[]) {
  const seen: string[] = [];
  const fetcher = (async (url: string) => {
    seen.push(String(url));
    if (String(url).startsWith("https://oauth2.googleapis.com/token")) return new Response(JSON.stringify({ access_token: "at" }), { status: 200 });
    if (String(url).startsWith("https://www.googleapis.com/calendar/v3/")) return new Response(JSON.stringify({ items: events() }), { status: 200 });
    throw new Error(`unexpected ${url}`);
  }) as unknown as typeof fetch;
  return { fetcher, seen };
}

const NOW = new Date("2026-11-09T08:00:00Z");
const ABE = "abe@example-team.test";
const conn = (member = "JOHN", address = SELF) => ({ member, address, token_ciphertext: sealToken("refresh", C.calendarAad(member, address)) });
const reader = (fetcher: typeof fetch) => new TwentyReader({ fetcher, pauseMs: 0, sleep: async () => undefined });
const sync = (db: SupabaseClient, t: { fetcher: typeof fetch }, events: () => unknown[]) => C.syncCalendars(db, reader(t.fetcher), { now: NOW, fetcher: google(events).fetcher });
const res = (run: Awaited<ReturnType<typeof C.syncCalendars>>, member = "JOHN", address = SELF) => run.calendars![`${member}:${address}`];
const pikl = () => ({ id: "pr", emails: { primaryEmail: "rob@pikl.test" }, companyId: "pikl", company: { id: "pikl", name: "Pikl", domainName: { primaryLinkUrl: "pikl.test" } } });
const freshDb = (calendars = [conn()]) => fakeDb({ gtm_team_calendars: calendars, gtm_team_mailboxes: [], gtm_calendar_meetings: [], gtm_sync_state: [] });

test("sync: creates with the derived id, adopts the owner's Granola row (not another owner's), follows a move, writes nothing unchanged", async () => {
  const twenty = fakeTwenty({
    people: [pikl()], companies: [{ id: "peri", name: "Peridot", domainName: { primaryLinkUrl: "https://peri.test" } }],
    opps: [{ id: "won", stage: "SIGNED", companyId: "pikl" }, { id: "open", stage: "PROPOSAL", companyId: "peri" }],
    meetings: [
      // Abe's row for the same company and time must never be taken over by John's calendar.
      { id: "abe-row", name: "2026-11-05 meeting: Peridot", mtgAt: "2026-11-05T08:30:00.000Z", mtgOwner: "ABE", mtgKind: "DISCOVERY", mtgKindSource: "AUTO", mtgAutoKind: "DISCOVERY", mtgCompanyId: "peri", mtgPersonId: null, mtgOpportunityId: "open", mtgExternalCount: 1, mtgCaptureKey: "granola:a" },
      { id: "granola-row", name: "2026-11-05 meeting: Peridot", mtgAt: "2026-11-05T09:00:00.000Z", mtgOwner: "JOHN", mtgKind: "DISCOVERY", mtgKindSource: "AUTO", mtgAutoKind: "DISCOVERY", mtgCompanyId: "peri", mtgPersonId: null, mtgOpportunityId: "open", mtgExternalCount: 1, mtgCaptureKey: "granola:x" },
    ],
  });
  let events = [
    ev("rob-call", "2026-11-04T16:00:00+08:00", ["rob@pikl.test"]),
    ev("peri-call", "2026-11-05T16:00:00+08:00", ["ramsay@peri.test"]),
    ev("dentist", "2026-11-06T10:00:00+08:00", ["front-desk@clinic.test"]),
  ];
  const db = freshDb();
  const r1 = res(await sync(db, twenty, () => events));
  assert.equal(r1.error, undefined);
  assert.deepEqual({ events: r1.events, business: r1.business, created: r1.created, adopted: r1.adopted }, { events: 3, business: 2, created: 1, adopted: 1 });
  const [made] = twenty.creates();
  assert.equal(made.id, C.rowId(eventKey("rob-call"), "JOHN"), "the row id is derived from the event");
  assert.deepEqual({ name: made.data!.name, kind: made.data!.mtgKind, person: made.data!.mtgPersonId, deal: made.data!.mtgOpportunityId }, { name: "2026-11-04 meeting: Pikl", kind: "CLIENT", person: "pr", deal: "won" });
  const map = db.tables.gtm_calendar_meetings.find((m) => m.origin === "adopted")!;
  assert.equal(map.meeting_id, "granola-row", "John's own row is adopted, Abe's is not");
  assert.ok(!twenty.writes.some((w) => w.op !== "create"));
  assert.equal(db.leases.size, 0, "the lease is released");

  events = [ev("rob-call", "2026-11-04T17:00:00+08:00", ["rob@pikl.test"]), events[1], events[2]];
  await sync(db, twenty, () => events);
  const upd = twenty.writes.filter((w) => w.op === "update");
  assert.equal(upd.length, 1); assert.equal(upd[0].data!.mtgAt, "2026-11-04T09:00:00.000Z");
  const before = twenty.writes.length, mapsBefore = JSON.stringify(db.tables.gtm_calendar_meetings);
  await sync(db, twenty, () => events);
  assert.equal(twenty.writes.length, before, "an unchanged calendar writes nothing to Twenty");
  assert.equal(JSON.stringify(db.tables.gtm_calendar_meetings).replace(/"updated_at":"[^"]*"/g, ""), mapsBefore.replace(/"updated_at":"[^"]*"/g, ""), "...nor to the map");
});

test("sync: a create whose answer is lost is not made twice; a lost map write is recovered by the id", async () => {
  const twenty = fakeTwenty({ people: [pikl()], companies: [], opps: [], meetings: [] }, { failFirstCreate: true });
  const events = [ev("rob-call", "2026-11-04T16:00:00+08:00", ["rob@pikl.test"])];
  const db = freshDb();
  const r = res(await sync(db, twenty, () => events));
  assert.equal(r.error, undefined);
  assert.equal(twenty.state.meetings.length, 1, "one row, though the reader sent the create twice");
  assert.equal(db.tables.gtm_calendar_meetings[0].meeting_id, C.rowId(eventKey("rob-call"), "JOHN"));
  db.tables.gtm_calendar_meetings = [];                         // the map write was lost
  await sync(db, twenty, () => events);
  assert.equal(twenty.state.meetings.length, 1);
  assert.equal(db.tables.gtm_calendar_meetings[0].origin, "created");
  // A person deletes it while the map is lost: it is not recreated.
  db.tables.gtm_calendar_meetings = [];
  twenty.trash.push(...twenty.state.meetings.splice(0));
  await sync(db, twenty, () => events);
  assert.equal(twenty.state.meetings.length, 0);
  assert.equal(db.tables.gtm_calendar_meetings[0].removed_reason, "person_deleted");
});

test("sync: privacy withdraws whatever made the row and whatever its kind, and holds it for every member", async () => {
  const twenty = fakeTwenty({ people: [pikl()], companies: [], opps: [], meetings: [] });
  let events = [ev("rob-call", "2026-11-04T16:00:00+08:00", ["rob@pikl.test"]), ev("other", "2026-11-05T16:00:00+08:00", ["rob@pikl.test"])];
  const db = freshDb([conn("ABE", ABE), conn()]);
  await sync(db, twenty, () => events);
  const row = twenty.state.meetings.find((m) => m.id === C.rowId(eventKey("rob-call"), "ABE"))!;   // Abe's calendar is synced first
  row.mtgKind = "PARTNER"; row.mtgKindSource = "MANUAL";        // a person's word
  events = [{ ...events[0], visibility: "private" }, events[1]];
  const r = await sync(db, twenty, () => events);
  assert.ok(twenty.trash.some((m) => m.id === row.id && m.name === "Retracted meeting" && m.mtgPersonId === null), "stripped and trashed despite the manual kind");
  assert.ok(!twenty.state.meetings.some((m) => m.id === row.id));
  assert.equal(res(r, "ABE", ABE).error, undefined);
  // The same invite on John's calendar, not private there: still never written.
  const creates = twenty.creates().length;
  await C.syncCalendars(db, reader(twenty.fetcher), { now: NOW, fetcher: google(() => [ev("rob-call", "2026-11-04T16:00:00+08:00", ["rob@pikl.test"])]).fetcher });
  assert.equal(twenty.creates().length, creates);
});

test("sync: a private invite never seen before is withheld, so another member's copy is not written either", async () => {
  const twenty = fakeTwenty({ people: [pikl()], companies: [], opps: [], meetings: [] });
  const priv = { ...ev("shared", "2026-11-04T16:00:00+08:00", ["rob@pikl.test"]), visibility: "private", iCalUID: "shared@uid" };
  const open = { ...ev("other-id-on-johns-copy", "2026-11-04T16:00:00+08:00", ["rob@pikl.test"]), iCalUID: "shared@uid" };
  const db = freshDb([conn("ABE", ABE), conn()]);
  const calls: string[] = [];
  const g = (async (url: string, init?: RequestInit) => {
    calls.push(String(url));
    if (String(url).startsWith("https://oauth2.googleapis.com/token")) return new Response(JSON.stringify({ access_token: String(init?.body).includes("refresh") ? `at${calls.length}` : "x" }), { status: 200 });
    // Abe's calendar is listed first (connections are ordered by member), then John's.
    const items = calls.filter((c) => c.includes("/calendar/v3/")).length === 1 ? [priv] : [open];
    return new Response(JSON.stringify({ items }), { status: 200 });
  }) as unknown as typeof fetch;
  const r = await C.syncCalendars(db, reader(twenty.fetcher), { now: NOW, fetcher: g });
  assert.equal(res(r, "ABE", ABE).withheld, 1);
  assert.equal(twenty.creates().length, 0, "matched across calendars by iCalendar UID, though Google's ids differ");
});

test("sync: an NDA company matched by domain on a guest who was not chosen still excludes the meeting", async () => {
  process.env.MEETING_DENY_LIST = JSON.stringify({ domains: [], organizations: ["Zeta Holdings"] });
  try {
    const twenty = fakeTwenty({ people: [{ id: "ann", emails: { primaryEmail: "ann@acme.test" }, name: { firstName: "Ann" } }],
      companies: [{ id: "z", name: "Zeta Holdings", domainName: { primaryLinkUrl: "https://zh-group.test" } }], opps: [], meetings: [] });
    const db = freshDb();
    const r = res(await sync(db, twenty, () => [ev("nda", "2026-11-04T16:00:00+08:00", ["ann@acme.test", "bob@zh-group.test"])]));
    assert.equal(r.business, 0);
    assert.equal(twenty.creates().length, 0);
    assert.equal(db.tables.gtm_calendar_meetings[0].removed_reason, "deny_list");
  } finally {
    process.env.MEETING_DENY_LIST = JSON.stringify({ domains: ["secret-client.test"], organizations: ["Hush Corp"] });
  }
});

test("sync: a suppressed person withdraws, an unsubscribed one holds (nothing added, nothing removed)", async () => {
  const twenty = fakeTwenty({ people: [pikl(), { id: "u", emails: { primaryEmail: "unsub@x.test" }, gtmMarketingConsent: "UNSUBSCRIBED", companyId: "pikl", company: { id: "pikl", name: "Pikl" } }], companies: [], opps: [], meetings: [] });
  let events = [ev("a", "2026-11-04T16:00:00+08:00", ["rob@pikl.test"]), ev("b", "2026-11-05T16:00:00+08:00", ["unsub@x.test"])];
  const db = freshDb();
  await sync(db, twenty, () => events);
  assert.equal(twenty.state.meetings.length, 1, "the unsubscribed person's meeting is held, not created");
  twenty.state.people[0].gtmQueue = "SUPPRESSED";
  await sync(db, twenty, () => events);
  assert.equal(twenty.state.meetings.length, 0);
  assert.equal(twenty.trash[0].name, "Retracted meeting");
  events = [events[0]];
});

test("sync: cancellations pass the ledger's breaker; an owner releases the held set; a manual row is kept; missing events count", async () => {
  const people = Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, emails: { primaryEmail: `c${i}@client.test` } }));
  const twenty = fakeTwenty({ people, companies: [], opps: [], meetings: [] });
  const all = people.map((_, i) => ev(`e${i}`, `2026-11-0${(i % 7) + 1}T1${i % 10}:00:00+08:00`, [`c${i}@client.test`]));
  let events: unknown[] = all;
  const db = freshDb();
  assert.equal(res(await sync(db, twenty, () => events)).created, 10);
  // One cancellation passes.
  events = all.map((e, i) => (i === 0 ? { ...e, status: "cancelled" } : e));
  assert.equal(res(await sync(db, twenty, () => events)).removed, 1);
  // Two of the rest vanish from the listing and two are cancelled: four at once, held.
  events = all.slice(3).map((e, i) => (i < 2 ? { ...e, status: "cancelled" } : e)).concat([{ ...all[0], status: "cancelled" }]);
  const held = res(await sync(db, twenty, () => events));
  assert.equal(held.held, 4); assert.match(held.error!, /held/);
  assert.equal(twenty.state.meetings.length, 9);
  // A person marks one of them manual, then an owner applies the held set.
  twenty.state.meetings.find((m) => m.id === C.rowId(eventKey("e1"), "JOHN"))!.mtgKindSource = "MANUAL";
  const heldState = db.tables.gtm_sync_state.find((r) => r.key === C.heldKey("JOHN"))!;
  db.tables.gtm_sync_state.push({ key: C.releaseKey("JOHN"), value: heldState.value });
  const applied = res(await sync(db, twenty, () => events));
  assert.deepEqual({ removed: applied.removed, kept: applied.kept, held: applied.held }, { removed: 3, kept: 1, held: undefined });
  assert.ok(!db.tables.gtm_sync_state.some((r) => r.key === C.releaseKey("JOHN") || r.key === C.heldKey("JOHN")), "the release is used once");
  assert.ok(twenty.state.meetings.some((m) => m.id === C.rowId(eventKey("e1"), "JOHN")), "the manual row stays");
  // Everything back on the calendar: nothing withdrawn is recreated.
  const creates = twenty.creates().length;
  await sync(db, twenty, () => all);
  assert.equal(twenty.creates().length, creates);
});

test("sync: the daily sweep withdraws any owned row (Granola's too) for a suppressed person or a denied company, once a day", async () => {
  const twenty = fakeTwenty({
    people: [{ id: "old", emails: { primaryEmail: "x@y.test" }, gtmQueue: "SUPPRESSED" }],
    companies: [{ id: "hush", name: "Hush Corp", domainName: { primaryLinkUrl: "hush.test" } }], opps: [],
    meetings: [
      { id: "g1", name: "2026-06-01 meeting: Someone", mtgAt: "2026-06-01T08:00:00.000Z", mtgOwner: "JOHN", mtgPersonId: "old", mtgCompanyId: null, mtgKindSource: "MANUAL" },
      { id: "g2", name: "2026-06-02 meeting: Hush Corp", mtgAt: "2026-06-02T08:00:00.000Z", mtgOwner: "JOHN", mtgPersonId: null, mtgCompanyId: "hush" },
      { id: "g3", name: "2026-06-03 meeting: Fine", mtgAt: "2026-06-03T08:00:00.000Z", mtgOwner: "JOHN", mtgPersonId: null, mtgCompanyId: null },
      { id: "a1", name: "2026-06-04 meeting: Abe's", mtgAt: "2026-06-04T08:00:00.000Z", mtgOwner: "ABE", mtgPersonId: "old", mtgCompanyId: null },
    ],
  });
  const db = freshDb();
  const r = res(await sync(db, twenty, () => []));
  assert.equal(r.swept, 2);
  assert.deepEqual(twenty.trash.map((m) => m.id).sort(), ["g1", "g2"]);
  assert.ok(twenty.trash.every((m) => m.name === "Retracted meeting" && m.mtgAt === null));
  assert.ok(twenty.state.meetings.some((m) => m.id === "a1"), "only the member's own rows");
  twenty.state.people[0].gtmQueue = null;
  twenty.state.meetings.push({ id: "g4", name: "x", mtgAt: "2026-06-05T08:00:00.000Z", mtgOwner: "JOHN", mtgPersonId: "old", mtgCompanyId: "hush" });
  assert.equal(res(await sync(db, twenty, () => [])).swept, undefined, "once a day");
});

test("sync: people missing from the CRM in bulk are held by the breaker, not withdrawn", async () => {
  const meetings = Array.from({ length: 5 }, (_, i) => ({ id: `m${i}`, name: `2026-06-0${i + 1} meeting: P`, mtgAt: `2026-06-0${i + 1}T08:00:00.000Z`, mtgOwner: "JOHN", mtgPersonId: `gone${i}`, mtgCompanyId: null }));
  const twenty = fakeTwenty({ people: [], companies: [], opps: [], meetings });
  const r = res(await sync(freshDb(), twenty, () => []));
  assert.match(r.error!, /no longer has; held/);
  assert.equal(twenty.trash.length, 0);
});

test("sync: without the deny-list nothing is read or written; a held lease skips the run; an unknown owner code is refused", async () => {
  const saved = process.env.MEETING_DENY_LIST;
  delete process.env.MEETING_DENY_LIST;
  const twenty = fakeTwenty({ people: [], companies: [], opps: [], meetings: [] });
  const g = google(() => []);
  const r = await C.syncCalendars(freshDb(), reader(twenty.fetcher), { now: NOW, fetcher: g.fetcher });
  assert.match(r.skipped!, /MEETING_DENY_LIST/); assert.equal(g.seen.length, 0);
  process.env.MEETING_DENY_LIST = saved;
  const db = freshDb();
  db.leases.add(C.LEASE);
  assert.match((await sync(db, twenty, () => [])).skipped!, /holds the lease/);
  const odd = res(await sync(freshDb([conn("ZED", "zed@x.test")]), twenty, () => []), "ZED", "zed@x.test");
  assert.match(odd.error!, /not an owner option/);
});

const shared = (id: string, extra: Record<string, unknown> = {}) => ({ ...ev(id, "2026-11-04T16:00:00+08:00", ["rob@pikl.test"]), iCalUID: "shared@uid", ...extra });
/** Abe's calendar answers first (connections are ordered by member), then John's. */
function twoCalendars(abe: () => unknown[], john: () => unknown[]) {
  let n = 0;
  return (async (url: string) => {
    if (String(url).startsWith("https://oauth2.googleapis.com/token")) return new Response(JSON.stringify({ access_token: "at" }), { status: 200 });
    n++;
    return new Response(JSON.stringify({ items: n % 2 === 1 ? abe() : john() }), { status: 200 });
  }) as unknown as typeof fetch;
}

test("sync: when the member whose sync wrote a shared meeting declines, the other attending member's sync writes it (review NEW-1)", async () => {
  const twenty = fakeTwenty({ people: [pikl()], companies: [], opps: [], meetings: [] });
  const db = freshDb([conn("ABE", ABE), conn()]);
  let abe: unknown[] = [shared("a-copy")];
  const john = () => [shared("j-copy")];
  await C.syncCalendars(db, reader(twenty.fetcher), { now: NOW, fetcher: twoCalendars(() => abe, john) });
  assert.equal(twenty.state.meetings.length, 1);
  assert.equal(twenty.state.meetings[0].mtgOwner, "ABE");
  abe = [shared("a-copy", { attendees: [{ email: ABE, self: true, responseStatus: "declined" }, { email: "rob@pikl.test" }] })];
  await C.syncCalendars(db, reader(twenty.fetcher), { now: NOW, fetcher: twoCalendars(() => abe, john) });
  assert.deepEqual(twenty.state.meetings.map((m) => m.mtgOwner), ["JOHN"], "John attended: his row replaces Abe's");
  assert.ok(!db.tables.gtm_calendar_meetings.some((m) => m.removed_reason === "person_deleted"));
});

test("sync: one recurring instance on calendars in two time zones is one meeting (review NEW-2)", async () => {
  const twenty = fakeTwenty({ people: [pikl()], companies: [], opps: [], meetings: [] });
  const db = freshDb([conn("ABE", ABE), conn()]);
  const inst = (zoned: string) => ({ ...ev("i", zoned, ["rob@pikl.test"]), iCalUID: "series@uid", originalStartTime: { dateTime: zoned } });
  await C.syncCalendars(db, reader(twenty.fetcher), { now: NOW, fetcher: twoCalendars(() => [inst("2026-11-04T09:00:00+01:00")], () => [inst("2026-11-04T16:00:00+08:00")]) });
  assert.equal(twenty.creates().length, 1);
});

test("sync: marking a shared invite Private on one calendar withdraws the row the other calendar wrote (review NEW-3)", async () => {
  const twenty = fakeTwenty({ people: [pikl()], companies: [], opps: [], meetings: [] });
  const db = freshDb([conn("ABE", ABE), conn()]);
  let john: unknown[] = [shared("j-copy")];
  // Abe has not got the invite yet; John's sync writes the row.
  await C.syncCalendars(db, reader(twenty.fetcher), { now: NOW, fetcher: twoCalendars(() => [], () => john) });
  assert.equal(twenty.state.meetings.length, 1);
  // Abe now has it, marked Private on his copy.
  await C.syncCalendars(db, reader(twenty.fetcher), { now: NOW, fetcher: twoCalendars(() => [shared("a-copy", { visibility: "private" })], () => john) });
  assert.equal(twenty.state.meetings.length, 0);
  assert.equal(twenty.trash[0].name, "Retracted meeting");
  assert.ok(db.tables.gtm_calendar_meetings.some((m) => m.member === "JOHN" && m.removed_reason === "private"));
  john = [shared("j-copy")];
  await C.syncCalendars(db, reader(twenty.fetcher), { now: NOW, fetcher: twoCalendars(() => [shared("a-copy", { visibility: "private" })], () => john) });
  assert.equal(twenty.creates().length, 1, "and it stays out");
});
