// Meetings from Google Calendar (VIB-518): which events count, the kind rules (same as the Granola meeting ledger), the
// deny-list, and the sync end to end against fake Google, Twenty and database: create, adopt, update, withdraw, the
// person's word, the breaker and the never-recreate rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
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

const SELF = "john@example-founder.test";
const ev = (id: string, start: string, emails: string[], extra: Partial<import("../lib/team/calendar.ts").GEvent> = {}) => ({
  id, status: "confirmed", start: { dateTime: start },
  attendees: [{ email: SELF, self: true, responseStatus: "accepted" }, ...emails.map((email) => ({ email, displayName: email.split("@")[0], responseStatus: "accepted" }))],
  ...extra,
});

/* ------------------------------------------------------------------------------------------------ pure rules */

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
  ], SELF, ["abe@vibranahq.com"], []);
  assert.deepEqual(s.live.map((e) => e.id), ["ok"]);
  assert.deepEqual(s.live[0].externals, ["rob@pikl.test"], "team, resource and self addresses are not outside guests");
  assert.equal(s.live[0].day, "2026-11-04", "the record's date is the event's own local date");
  assert.equal(s.live[0].start, "2026-11-04T08:00:00.000Z");
  assert.deepEqual(Object.fromEntries(s.gone.map((g) => [g.id, g.why])),
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
  assert.deepEqual(Object.keys(C.rowChanges({ ...row, mtgKind: "OTHER" }, want)).sort(), ["mtgAt", "mtgAutoKind", "mtgCompanyId", "mtgExternalCount", "mtgKind", "name"]);
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
function fakeDb(tables: Record<string, Row[]>) {
  const from = (table: string) => {
    const st: { op: string; payload: Row | null; filters: [string, unknown][]; range?: [number, number] } = { op: "select", payload: null, filters: [] };
    const run = () => {
      const arr = (tables[table] ??= []);
      const hit = (r: Row) => st.filters.every(([k, v]) => r[k] === v);
      if (st.op === "select") { const rows = arr.filter(hit); return { data: st.range ? rows.slice(st.range[0], st.range[1] + 1) : rows, error: null }; }
      if (st.op === "update") for (const r of arr.filter(hit)) Object.assign(r, st.payload);
      if (st.op === "upsert") {
        const p = st.payload!;
        const i = arr.findIndex((r) => r.member === p.member && r.event_key === p.event_key);
        if (i >= 0) Object.assign(arr[i], p); else arr.push({ removed_at: null, ...p });
      }
      return { data: null, error: null };
    };
    const api: Record<string, unknown> = {
      select: () => api, order: () => api, limit: () => api,
      eq: (k: string, v: unknown) => { st.filters.push([k, v]); return api; },
      range: (a: number, b: number) => { st.range = [a, b]; return api; },
      update: (p: Row) => { st.op = "update"; st.payload = p; return api; },
      upsert: (p: Row) => { st.op = "upsert"; st.payload = p; return api; },
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
    };
    return api;
  };
  return { from } as unknown as SupabaseClient;
}

type Meeting = Row & { id: string };
function fakeTwenty(state: { people: Row[]; companies: Row[]; opps: Row[]; meetings: Meeting[] }) {
  const writes: { op: string; id?: string; data?: Row }[] = [];
  let n = 0;
  const conn = (rows: Row[]) => ({ pageInfo: { hasNextPage: false, endCursor: null }, edges: rows.map((node) => ({ node })) });
  const fetcher = (async (_url: string, init: RequestInit) => {
    const { query, variables } = JSON.parse(String(init.body)) as { query: string; variables: { f?: Row; d?: Row; id?: string } };
    const reply = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
    if (query.includes("createMeeting")) { const id = `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`; state.meetings.push({ id, ...variables.d }); writes.push({ op: "create", id, data: variables.d }); return reply({ createMeeting: { id } }); }
    if (query.includes("updateMeeting")) { Object.assign(state.meetings.find((m) => m.id === variables.id)!, variables.d); writes.push({ op: "update", id: variables.id, data: variables.d }); return reply({ updateMeeting: { id: variables.id } }); }
    if (query.includes("deleteMeeting")) { state.meetings = state.meetings.filter((m) => m.id !== variables.id); writes.push({ op: "delete", id: variables.id }); return reply({ deleteMeeting: { id: variables.id } }); }
    if (query.includes("people(")) return reply({ people: conn(state.people) });
    if (query.includes("companies(")) return reply({ companies: conn(state.companies) });
    if (query.includes("opportunities(")) return reply({ opportunities: conn(state.opps) });
    if (query.includes("meetings(")) {
      const f = variables.f as { id?: { in: string[] } };
      return reply({ meetings: conn(f.id ? state.meetings.filter((m) => f.id!.in.includes(m.id)) : state.meetings) });
    }
    throw new Error(`unexpected Twenty query ${query.slice(0, 60)}`);
  }) as unknown as typeof fetch;
  return { fetcher, writes, state };
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
const conn = () => ({ member: "JOHN", address: SELF, token_ciphertext: sealToken("refresh", C.calendarAad("JOHN", SELF)) });
const reader = (fetcher: typeof fetch) => new TwentyReader({ fetcher, pauseMs: 0, sleep: async () => undefined });

test("sync: creates a CRM meeting, adopts an existing one, follows a move, withdraws on cancel, never recreates", async () => {
  const twenty = fakeTwenty({
    people: [{ id: "pr", emails: { primaryEmail: "rob@pikl.test" }, companyId: "pikl", company: { id: "pikl", name: "Pikl", domainName: { primaryLinkUrl: "pikl.test" } } }],
    companies: [{ id: "peri", name: "Peridot", domainName: { primaryLinkUrl: "https://peri.test" } }],
    opps: [{ id: "won", stage: "SIGNED", companyId: "pikl" }, { id: "open", stage: "PROPOSAL", companyId: "peri" }],
    // A Granola row for the Peridot call, an hour off the calendar time.
    meetings: [{ id: "granola-row", name: "2026-11-05 meeting: Peridot", mtgAt: "2026-11-05T09:00:00.000Z", mtgOwner: "JOHN", mtgKind: "DISCOVERY", mtgKindSource: "AUTO", mtgAutoKind: "DISCOVERY", mtgCompanyId: "peri", mtgPersonId: null, mtgOpportunityId: "open", mtgExternalCount: 1, mtgCaptureKey: "granola:x" }],
  });
  let events = [
    ev("rob-call", "2026-11-04T16:00:00+08:00", ["rob@pikl.test"]),
    ev("peri-call", "2026-11-05T16:00:00+08:00", ["ramsay@peri.test"]),
    ev("dentist", "2026-11-06T10:00:00+08:00", ["front-desk@clinic.test"]),
    ev("nda", "2026-11-06T12:00:00+08:00", ["pat@secret-client.test", "rob@pikl.test"]),
  ];
  const g = google(() => events);
  const db = fakeDb({ gtm_team_calendars: [conn()], gtm_team_mailboxes: [], gtm_calendar_meetings: [] });
  const run1 = await C.syncCalendars(db, reader(twenty.fetcher), { now: NOW, fetcher: g.fetcher });
  const r1 = run1.calendars![`JOHN:${SELF}`];
  assert.equal(r1.error, undefined);
  assert.deepEqual({ events: r1.events, business: r1.business, created: r1.created, adopted: r1.adopted }, { events: 4, business: 2, created: 1, adopted: 1 });
  const made = twenty.writes.find((w) => w.op === "create")!.data!;
  assert.deepEqual({ name: made.name, kind: made.mtgKind, company: made.mtgCompanyId, person: made.mtgPersonId, deal: made.mtgOpportunityId, owner: made.mtgOwner },
    { name: "2026-11-04 meeting: Pikl", kind: "CLIENT", company: "pikl", person: "pr", deal: "won", owner: "JOHN" });
  assert.ok(!twenty.writes.some((w) => w.op !== "create"), "the Granola row is adopted, not edited");
  assert.ok(!JSON.stringify(twenty.writes).includes("clinic") && !JSON.stringify(twenty.writes).includes("secret-client"), "no unmatched or NDA meeting is written");
  assert.ok(g.seen.some((u) => u.includes("fields=") && !/summary/.test(decodeURIComponent(u))), "events are read through the fields mask");

  // The Pikl call moves an hour: the row follows. Run again with no change: nothing is written.
  events = [ev("rob-call", "2026-11-04T17:00:00+08:00", ["rob@pikl.test"]), events[1], events[2], events[3]];
  await C.syncCalendars(db, reader(twenty.fetcher), { now: NOW, fetcher: g.fetcher });
  const upd = twenty.writes.filter((w) => w.op === "update");
  assert.equal(upd.length, 1); assert.equal(upd[0].data!.mtgAt, "2026-11-04T09:00:00.000Z");
  const before = twenty.writes.length;
  await C.syncCalendars(db, reader(twenty.fetcher), { now: NOW, fetcher: g.fetcher });
  assert.equal(twenty.writes.length, before, "an unchanged calendar writes nothing");

  // Cancelled: the created row is deleted (Twenty's trash); the adopted Granola row is never touched.
  events = [{ ...events[0], status: "cancelled" }, { ...events[1], status: "cancelled" }];
  const r4 = (await C.syncCalendars(db, reader(twenty.fetcher), { now: NOW, fetcher: g.fetcher })).calendars![`JOHN:${SELF}`];
  assert.equal(r4.removed, 1);
  assert.ok(twenty.state.meetings.some((m) => m.id === "granola-row"));
  // Un-cancelled later: a withdrawn meeting is final, never recreated.
  events = [ev("rob-call", "2026-11-04T17:00:00+08:00", ["rob@pikl.test"])];
  const creates = twenty.writes.filter((w) => w.op === "create").length;
  await C.syncCalendars(db, reader(twenty.fetcher), { now: NOW, fetcher: g.fetcher });
  assert.equal(twenty.writes.filter((w) => w.op === "create").length, creates);
  assert.equal(eventKey("rob-call").length, 32);
});

test("sync: a person's kind survives a cancel, a deleted row is not recreated, the breaker holds a mass removal", async () => {
  const people = Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, emails: { primaryEmail: `c${i}@client.test` } }));
  const twenty = fakeTwenty({ people, companies: [], opps: [], meetings: [] });
  let events = people.map((_, i) => ev(`e${i}`, `2026-11-0${(i % 7) + 1}T10:00:00+08:00`, [`c${i}@client.test`]));
  const g = google(() => events);
  const db = fakeDb({ gtm_team_calendars: [conn()], gtm_team_mailboxes: [], gtm_calendar_meetings: [] });
  const r1 = (await C.syncCalendars(db, reader(twenty.fetcher), { now: NOW, fetcher: g.fetcher })).calendars![`JOHN:${SELF}`];
  assert.equal(r1.created, 8);
  // Everything cancelled at once (a wrong calendar, an API glitch): held, nothing deleted.
  const all = events;
  events = all.map((e) => ({ ...e, status: "cancelled" }));
  const r2 = (await C.syncCalendars(db, reader(twenty.fetcher), { now: NOW, fetcher: g.fetcher })).calendars![`JOHN:${SELF}`];
  assert.equal(r2.held, 8); assert.match(r2.error!, /breaker/);
  assert.equal(twenty.state.meetings.length, 8);
  // A person marks one row Manual and deletes another in Twenty; then only those two are cancelled.
  const [m0, m1] = twenty.state.meetings;
  m0.mtgKindSource = "MANUAL";
  twenty.state.meetings = twenty.state.meetings.filter((m) => m.id !== m1.id);
  events = all.map((e, i) => (i < 2 ? { ...e, status: "cancelled" } : e));
  const r3 = (await C.syncCalendars(db, reader(twenty.fetcher), { now: NOW, fetcher: g.fetcher })).calendars![`JOHN:${SELF}`];
  assert.equal(r3.kept, 1, "a row with a person's kind is kept");
  assert.ok(twenty.state.meetings.some((m) => m.id === m0.id));
  events = all;
  const creates = twenty.writes.filter((w) => w.op === "create").length;
  await C.syncCalendars(db, reader(twenty.fetcher), { now: NOW, fetcher: g.fetcher });
  assert.equal(twenty.writes.filter((w) => w.op === "create").length, creates, "neither the deleted nor the kept row is recreated");
});

test("sync: without the deny-list nothing is read or written; one meeting on two calendars is written once", async () => {
  const saved = process.env.MEETING_DENY_LIST;
  delete process.env.MEETING_DENY_LIST;
  const twenty = fakeTwenty({ people: [], companies: [], opps: [], meetings: [] });
  const g = google(() => []);
  const r = await C.syncCalendars(fakeDb({ gtm_team_calendars: [conn()] }), reader(twenty.fetcher), { now: NOW, fetcher: g.fetcher });
  assert.match(r.skipped!, /MEETING_DENY_LIST/); assert.equal(g.seen.length, 0);
  process.env.MEETING_DENY_LIST = saved;

  const t2 = fakeTwenty({ people: [{ id: "pr", emails: { primaryEmail: "rob@pikl.test" } }], companies: [], opps: [], meetings: [] });
  const abe = { member: "ABE", address: "abe@example-team.test", token_ciphertext: sealToken("refresh", C.calendarAad("ABE", "abe@example-team.test")) };
  const shared = { id: "same-invite", status: "confirmed", start: { dateTime: "2026-11-04T16:00:00+08:00" },
    attendees: [{ email: SELF }, { email: "abe@example-team.test" }, { email: "rob@pikl.test" }] };
  const db = fakeDb({ gtm_team_calendars: [abe, conn()], gtm_team_mailboxes: [], gtm_calendar_meetings: [] });
  await C.syncCalendars(db, reader(t2.fetcher), { now: NOW, fetcher: google(() => [shared]).fetcher });
  assert.equal(t2.writes.filter((w) => w.op === "create").length, 1);
});
