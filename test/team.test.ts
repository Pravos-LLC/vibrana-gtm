// Team performance (/performance/team): attribution, the outreach classifier, the mailbox secrets, the metrics math,
// the paced Twenty reader, the mailbox sync and the cron schedule.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { installFetchMock, type Route } from "./support/fetch-mock.ts";

const KEY = randomBytes(32).toString("base64");
Object.assign(process.env, { TEAM_MAILBOX_KEY: KEY, TWENTY_API_KEY: "twenty_test", TWENTY_BASE: "https://crm.test", NEXT_PUBLIC_SUPABASE_URL: "https://db.test", SUPABASE_SECRET_KEY: "sb_secret_test" });
const { parseMembers, isMemberRow, createdByFilter, teamMembers } = await import("../lib/team/members.ts");
const { classifySend, threadOutcome, recipients, eligibleForOutreach } = await import("../lib/team/classify.ts");
const { sealToken, openToken, signState, verifyState, addressHash, pkceChallenge } = await import("../lib/team/crypto.ts");
const M = await import("../lib/team/metrics.ts");
const { TwentyReader } = await import("../lib/twenty.ts");
const { authUrl } = await import("../lib/team/mailbox.ts");

let mock: ReturnType<typeof installFetchMock> | null = null;
const use = (routes: Route[]) => (mock = installFetchMock(routes));
afterEach(() => { mock?.restore(); mock = null; });

const WM = "00000000-0000-4000-8000-0000000000ab";
const member = parseMembers(JSON.stringify([{ code: "ABE", label: "Abe", authEmail: "Abe@Team.test", workspaceMemberId: WM, apiKeyNames: ["abe-agent"], mailboxes: ["abe@hq.test"] }]))[0];

/* ---------------------------------------------------------------- members and attribution */

test("GTM_TEAM_MEMBERS parses, lowercases addresses and refuses anything malformed", () => {
  assert.equal(member.authEmail, "abe@team.test");
  assert.deepEqual(parseMembers(undefined), []);
  for (const bad of ["{", "{}", '[{"code":"abe","authEmail":"a@b.co","apiKeyNames":["k"]}]', '[{"code":"ABE","authEmail":"nope","apiKeyNames":["k"]}]',
    '[{"code":"ABE","authEmail":"a@b.co"}]', '[{"code":"ABE","authEmail":"a@b.co","workspaceMemberId":"x","apiKeyNames":["k"]}]',
    '[{"code":"ABE","authEmail":"a@b.co","apiKeyNames":["k"]},{"code":"ABE","authEmail":"c@b.co","apiKeyNames":["j"]}]']) {
    assert.throws(() => parseMembers(bad), /GTM_TEAM_MEMBERS/, bad);
  }
});

test("sample mode shows a sample member only when none is configured", () => {
  assert.equal(teamMembers({ CONTENT_MODE: "sample" })[0].code, "SAMPLE");
  assert.equal(teamMembers({ CONTENT_MODE: "sample", GTM_TEAM_MEMBERS: JSON.stringify([{ code: "ABE", authEmail: "a@b.co", apiKeyNames: ["k"] }]) })[0].code, "ABE");
});

test("a row is the member's when created in the app as them or through one of their API keys, never another key", () => {
  assert.ok(isMemberRow({ source: "MANUAL", name: "Abe", workspaceMemberId: WM }, member));
  assert.ok(isMemberRow({ source: "API", name: "abe-agent", workspaceMemberId: null }, member));
  assert.ok(!isMemberRow({ source: "API", name: "conversation-sync (VIB-165)", workspaceMemberId: null }, member));
  assert.ok(!isMemberRow({ source: "MANUAL", name: "abe-agent", workspaceMemberId: "other" }, member), "a person named like the key is not the key");
  assert.ok(!isMemberRow(null, member));
  assert.deepEqual(createdByFilter(member), { or: [{ createdBy: { name: { eq: "abe-agent" } } }, { createdBy: { workspaceMemberId: { eq: WM } } }] });
});

/* ---------------------------------------------------------------- classification */

const person = (id: string, extra: Record<string, string | null> = {}) => ({ id, gtmRelationship: null, prospectReviewState: null, gtmQueue: null, ...extra });
const msg = (id: string, at: number, headers: Record<string, string>, labelIds: string[] = []) =>
  ({ id, internalDate: String(at), labelIds, payload: { headers: Object.entries(headers).map(([name, value]) => ({ name, value })) } });

test("an exact address match to an eligible CRM person is outreach; clients, partners, personal and suppressed are not", () => {
  const people = new Map([["ana@prospect.test", person("p1")], ["cli@client.test", person("p2", { gtmRelationship: "CLIENT" })],
    ["pa@partner.test", person("p3", { gtmQueue: "PARTNER" })], ["mum@gmail.com", person("p4", { gtmRelationship: "PERSONAL" })],
    ["x@sup.test", person("p5", { gtmQueue: "SUPPRESSED" })], ["w@warm.test", person("p6", { prospectReviewState: "WARM_INTRO" })]]);
  const companies = new Map([["prospect.test", ["c1"]], ["client.test", ["c2"]], ["gmail.com", ["c9"]]]);
  assert.deepEqual(classifySend(["ana@prospect.test", "bob@else.test"], people, companies), { kind: "outreach", personIds: ["p1"], recipients: ["ana@prospect.test"] });
  for (const a of ["cli@client.test", "pa@partner.test", "mum@gmail.com", "x@sup.test"]) assert.equal(classifySend([a], people, companies), null, a);
  assert.equal(classifySend(["w@warm.test"], people, companies)?.kind, "outreach", "a warm intro is outreach");
  assert.deepEqual(classifySend(["new@prospect.test"], people, companies), { kind: "other_crm", companyIds: ["c1"] });
  assert.equal(classifySend(["stranger@gmail.com"], people, companies), null, "freemail never matches a company");
  assert.equal(classifySend(["someone@nowhere.test"], people, companies), null);
  assert.equal(eligibleForOutreach(person("p", { gtmRelationship: "FORMER_CLIENT" })), false);
});

test("recipients drop the member's own addresses, their domain and ignored team domains", () => {
  const m = msg("a1", 1, { To: "Ana <ana@prospect.test>, me@hq.test", Cc: "col@hq.test, boss@team.test, x@prospect.test" });
  assert.deepEqual(recipients(m, ["me@hq.test"], ["team.test"]), ["ana@prospect.test", "x@prospect.test"]);
});

test("replies come from an outreach recipient after the first send; auto-replies, own mail and others are not replies; bounces are found", () => {
  const isR = (a: string) => a === "ana@prospect.test";
  const out = threadOutcome([
    msg("s1", 100, { From: "me@hq.test", To: "ana@prospect.test" }, ["SENT"]),
    msg("o1", 50, { From: "ana@prospect.test" }),
    msg("a1", 150, { From: "ana@prospect.test", "Auto-Submitted": "auto-replied" }),
    msg("a2", 160, { From: "ana@prospect.test", Precedence: "auto_reply" }),
    msg("x1", 170, { From: "other@prospect.test" }),
    msg("r1", 200, { From: "Ana <ana@prospect.test>" }),
  ], 100, ["me@hq.test"], isR);
  assert.deepEqual(out, { replies: [{ id: "r1", at: 200 }], bounce: null });
  const b = threadOutcome([msg("d1", 120, { From: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>" })], 100, ["me@hq.test"], isR);
  assert.deepEqual(b, { replies: [], bounce: { id: "d1", at: 120 } });
});

/* ---------------------------------------------------------------- secrets */

test("a sealed token opens only with the same member and address, and any tampering fails", () => {
  const sealed = sealToken("refresh-1", "ABE:abe@hq.test");
  assert.notEqual(sealToken("refresh-1", "ABE:abe@hq.test"), sealed, "a fresh IV each time");
  assert.equal(openToken(sealed, "ABE:abe@hq.test"), "refresh-1");
  assert.throws(() => openToken(sealed, "JOHN:abe@hq.test"));
  const buf = Buffer.from(sealed, "base64"); buf[buf.length - 1] ^= 1;
  assert.throws(() => openToken(buf.toString("base64"), "ABE:abe@hq.test"));
  assert.throws(() => sealToken("x", "a", { TEAM_MAILBOX_KEY: "short" }), /32 bytes/);
});

test("OAuth state holds only with its own nonce, before expiry, unaltered", () => {
  const s = signState({ sub: "u1", member: "ABE", nonce: "n1", exp: 2_000 });
  assert.deepEqual(verifyState(s, "n1", 1_000), { sub: "u1", member: "ABE", nonce: "n1", exp: 2_000 });
  assert.equal(verifyState(s, "n2", 1_000), null, "another browser's nonce");
  assert.equal(verifyState(s, undefined, 1_000), null);
  assert.equal(verifyState(s, "n1", 3_000), null, "expired");
  const [body, sig] = s.split(".");
  const forged = Buffer.from(JSON.stringify({ sub: "u2", member: "ABE", nonce: "n1", exp: 2_000 })).toString("base64url");
  assert.equal(verifyState(`${forged}.${sig}`, "n1", 1_000), null);
  assert.equal(verifyState(`${body}.x${sig}`, "n1", 1_000), null);
});

test("recipient hashes are keyed and case-insensitive; PKCE is S256; the auth URL asks for metadata only, offline", () => {
  assert.equal(addressHash("Ana@Prospect.test"), addressHash("ana@prospect.test"));
  assert.notEqual(addressHash("ana@prospect.test"), addressHash("ana@prospect.test", { TEAM_MAILBOX_KEY: randomBytes(32).toString("base64") }));
  assert.equal(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  const u = new URL(authUrl({ clientId: "cid", redirectUri: "https://cockpit.test/api/team/mailbox/callback", state: "st", challenge: "ch", loginHint: "abe@hq.test" }));
  assert.equal(u.searchParams.get("scope"), "openid email https://www.googleapis.com/auth/gmail.metadata");
  assert.equal(u.searchParams.get("access_type"), "offline");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
});

/* ---------------------------------------------------------------- metrics */

const NOW = new Date("2026-11-04T12:00:00Z");
const d = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * M.DAY).toISOString();
const activity = (over: Partial<import("../lib/team/crm.ts").Activity> = {}) => ({
  member: "ABE", capturedAt: NOW.toISOString(), errors: {}, captureRuns: 0, notes: [], opportunities: [], tasks: [], meetings: [],
  people: [
    { id: "p1", createdAt: d(20), hasEmail: true, verification: "VERIFIED", companyId: null, notSendable: false, lastContactedAt: null },
    { id: "p2", createdAt: d(5), hasEmail: true, verification: "VERIFIED", companyId: null, notSendable: true, lastContactedAt: null },
    { id: "p3", createdAt: d(3), hasEmail: false, verification: "UNVERIFIED", companyId: null, notSendable: false, lastContactedAt: null },
  ],
  companies: [
    { id: "c1", createdAt: d(30), hasOwner: false },
    { id: "c2", createdAt: d(10), hasOwner: true },
    { id: "c3", createdAt: d(2), hasOwner: false },
    { id: "c4", createdAt: d(40), hasOwner: true },
  ], ...over,
});
const base = { desk: [], memberEmail: "abe@team.test", stock: [], periodDays: 30, now: NOW };

test("not connected is not measured, never zero", () => {
  const r = M.teamReport({ ...base, activity: null, mail: null, desk: null });
  assert.equal(r.cur.emailsSent, null); assert.equal(r.cur.reply, null); assert.equal(r.cur.contactsAdded, null);
  assert.equal(r.cur.activeDays, null); assert.equal(r.stock.sendable, null); assert.equal(r.funnel[3].value, null);
  const partial = M.teamReport({ ...base, activity: activity({ errors: { people: "timeout" } }), mail: null });
  assert.equal(partial.cur.contactsAdded, null, "an unread object is not measured");
  assert.equal(partial.cur.companiesAdded, 3);
});

test("stock: sendable needs a verified email and no not-sendable flag; review labels are not measured", () => {
  const s = M.stock(activity(), NOW);
  assert.equal(s.sendable, 1); assert.equal(s.verified, 2); assert.equal(s.unverified, 1);
  assert.equal(s.companiesNoOwner, 2);
  for (const k of ["reviewed", "keep", "keepRate", "unreviewed", "unreviewedOver14", "stageMix"]) assert.equal(k in s, false, `${k} is not measured`);
});

const ev = (kind: "outreach" | "reply" | "bounce" | "other_crm", daysAgo: number, thread: string, person_ids: string[] = []) => ({ kind, at: d(daysAgo), thread_id: thread, person_ids });

test("reply rate: first touches at least 7 days old, bounces out, hidden below 10", () => {
  const mail = [
    ...Array.from({ length: 10 }, (_, i) => ev("outreach", 10 + i, `t${i}`, [`p${i}`])),
    ev("reply", 8, "t0"), ev("reply", 9, "t1"), ev("bounce", 9, "t9"),
    ev("outreach", 3, "young", ["py"]), ev("reply", 2, "young"),
  ];
  const r = M.replyRate(mail, NOW.getTime() - 30 * M.DAY, NOW.getTime(), NOW.getTime());
  assert.deepEqual(r, { rate: null, replied: 2, n: 9 }, "9 mature unbounced threads is below 10");
  const more = [...mail, ev("outreach", 12, "t10", ["p10"]), ev("reply", 11, "t10")];
  const r2 = M.replyRate(more, NOW.getTime() - 30 * M.DAY, NOW.getTime(), NOW.getTime());
  assert.equal(r2.n, 10); assert.equal(r2.replied, 3); assert.equal(r2.rate, 0.3);
});

test("emails, first touches and follow-ups; follow-up rate counts a second send on day 3 to 7 of an unanswered thread", () => {
  const mail = [ev("outreach", 20, "a", ["p1"]), ev("outreach", 16, "a", ["p1"]), ev("outreach", 20, "b", ["px"]), ev("outreach", 19, "c", ["py"]), ev("reply", 18, "c"), ev("other_crm", 5, "o")];
  const r = M.teamReport({ ...base, activity: activity(), mail });
  assert.equal(r.cur.emailsSent, 4); assert.equal(r.cur.newThreads, 3); assert.equal(r.cur.otherCrmMail, 1); assert.equal(r.cur.replies, 1);
  assert.deepEqual(r.cur.followUp, { rate: 0.5, n: 2 }, "a followed up on day 4, b never; c was answered");
  assert.equal(r.daysToFirstTouch, 0, "p1 was added 20 days ago and emailed the same day");
});

test("desk sends count only for the member's own login and never twice with the same mailbox send", () => {
  const desk = [
    { person: "p1", email_sent_at: d(20), linkedin_sent_at: null, email_sent_by: "Abe@Team.test", linkedin_sent_by: null },
    { person: "p2", email_sent_at: d(4), linkedin_sent_at: d(4), email_sent_by: "abe@team.test", linkedin_sent_by: "abe@team.test" },
    { person: "p3", email_sent_at: d(4), linkedin_sent_at: null, email_sent_by: "john@team.test", linkedin_sent_by: null },
  ];
  // The mailbox saw p1's email a day before the desk mark (marked late): still the same email.
  const mail = [ev("outreach", 21, "a", ["p1"])];
  const only = M.deskOnly(desk, mail, "abe@team.test");
  assert.deepEqual(only.map((x) => `${x.person}:${x.channel}`), ["p2:email", "p2:linkedin"]);
  assert.equal(M.teamReport({ ...base, activity: null, mail: null, desk }).cur.deskSent, 3, "without a mailbox every own desk send counts");
});

test("period counts, previous-period comparison, active days and the 8-week series", () => {
  const r = M.teamReport({ ...base, periodDays: 7, activity: activity({ notes: [{ createdAt: d(1) }, { createdAt: d(9) }], meetings: [{ createdAt: d(2), status: "PENDING" }] }), mail: [ev("outreach", 1, "a", ["p3"])] });
  assert.equal(r.cur.contactsAdded, 2); assert.equal(r.prev.contactsAdded, 0);
  assert.equal(r.cur.companiesAdded, 1); assert.equal(r.prev.companiesAdded, 1);
  assert.equal(r.cur.notes, 1); assert.equal(r.cur.meetings, 1);
  assert.equal(r.cur.activeDays, 4, "days 5, 3, 2 and 1: the note and the email share day 1, the company and the meeting day 2");
  assert.equal(r.weekly.length, 8);
  assert.equal(r.weekly.at(-1)!.added, 2);
});

test("pipeline touched leaves LOST out and groups by currency; the timeline is by day, newest first", () => {
  const a = activity({ opportunities: [
    { id: "o1", createdAt: d(5), stage: "QUALIFIED", amount: 1000, currency: "EUR", companyId: "c1", personId: null, mine: false },
    { id: "o2", createdAt: d(5), stage: "LOST", amount: 5000, currency: "EUR", companyId: "c2", personId: null, mine: true },
    { id: "o3", createdAt: d(5), stage: "PROPOSAL", amount: 200, currency: "GBP", companyId: null, personId: "p1", mine: false },
  ] });
  assert.deepEqual(M.pipelineValue(a), [{ currency: "EUR", amount: 1000, count: 1 }, { currency: "GBP", amount: 200, count: 1 }]);
  const tl = M.timeline({ ...base, activity: a, mail: [ev("reply", 0.5, "t", [])] });
  assert.equal(tl[0].kind, "Reply received");
  assert.match(tl[0].day, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(tl.every((x, i) => i === 0 || x.day <= tl[i - 1].day));
});

/* ---------------------------------------------------------------- paced reader */

test("the Twenty reader runs one request at a time, pauses, retries 429 and 5xx, and never retries a GraphQL error", async () => {
  const sleeps: number[] = [];
  let clock = 0;
  const reader = new TwentyReader({ pauseMs: 1500, sleep: async (ms) => { sleeps.push(ms); clock += ms; }, now: () => clock });
  use([
    { url: "https://crm.test/graphql", status: 429, json: {}, times: 1 },
    { url: "https://crm.test/graphql", status: 200, json: { data: { a: 1 } }, times: 1 },
    { url: "https://crm.test/graphql", status: 200, json: { errors: [{ message: "bad field" }] }, times: 1 },
  ]);
  assert.deepEqual(await reader.read("{a}"), { a: 1 });
  await assert.rejects(reader.read("{b}"), /bad field/);
  assert.equal(mock!.calls.length, 3);
  assert.ok(sleeps.includes(2000), "backoff after the 429");
  assert.ok(sleeps.filter((s) => s === 1500).length >= 1, "a pause between reads");
});

test("the reader pages with the cursor and stops at the deadline", async () => {
  let clock = 0;
  const reader = new TwentyReader({ pauseMs: 0, sleep: async (ms) => { clock += ms; }, now: () => clock });
  const page = (ids: string[], next: string | null) => ({ data: { people: { pageInfo: { hasNextPage: !!next, endCursor: next }, edges: ids.map((id) => ({ node: { id } })) } } });
  // Twenty repeats the boundary row on the next page under a createdAt sort: it must be counted once.
  use([{ url: "https://crm.test/graphql", json: page(["a", "b"], "c1"), times: 1 }, { url: "https://crm.test/graphql", json: page(["b", "c"], null), times: 1 }]);
  assert.deepEqual((await reader.all<{ id: string }>("people", "createdAt", null, "PersonFilterInput")).map((x) => x.id), ["a", "b", "c"]);
  assert.match(mock!.calls[0].body!, /node \{ id createdAt \}/, "id is always selected");
  assert.match(mock!.calls[1].body!, /"a":"c1"/);
  const late = new TwentyReader({ pauseMs: 0, deadline: 10, now: () => 100 });
  await assert.rejects(late.read("{x}"), /deadline/);
});

/* Mailbox sync runs against the local database: test/db/team-mailbox.test.ts. */

test("a reconnect never revokes the previous token: Google would revoke the new grant with it (review NB1)", () => {
  const src = readFileSync(new URL("../app/api/team/mailbox/callback/route.ts", import.meta.url), "utf8");
  assert.equal((src.match(/revokeToken\(/g) ?? []).length, 2, "only the wrong-mailbox and failed-save paths revoke, both the token just granted");
  assert.doesNotMatch(src, /openToken/);
  assert.match(src, /return !!error \|\| !!data\?\.length/, "a failed in-use lookup keeps the grant");
});

test("the team cron is scheduled hourly in vercel.json", () => {
  const crons = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8")).crons as { path: string; schedule: string }[];
  assert.ok(crons.some((c) => c.path === "/api/cron/team" && /^\d+ \* \* \* \*$/.test(c.schedule)));
});
