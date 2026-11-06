// Team performance (/performance/team): attribution, the outreach classifier, the mailbox secrets, the metrics math,
// the paced Twenty reader, the mailbox sync and the cron schedule.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { installFetchMock, type Route } from "./support/fetch-mock.ts";

const KEY = randomBytes(32).toString("base64");
Object.assign(process.env, { TEAM_MAILBOX_KEY: KEY, TWENTY_API_KEY: "twenty_test", TWENTY_BASE: "https://crm.test", NEXT_PUBLIC_SUPABASE_URL: "https://db.test", SUPABASE_SECRET_KEY: "sb_secret_test" });
const { parseMembers, isMemberRow, createdByFilter, teamMembers } = await import("../lib/team/members.ts");
const { classifyMessage, threadOutcome, recipients, recipientsOf, eligibleForOutreach, policyFlags, verificationOf } = await import("../lib/team/classify.ts");
const R = await import("../lib/team/restrictions.ts");
const { sealToken, openToken, signState, verifyState, addressHash, pkceChallenge } = await import("../lib/team/crypto.ts");
const M = await import("../lib/team/metrics.ts");
const { TwentyReader } = await import("../lib/twenty.ts");
const { authUrl, requestedScopes, canReadBodies, episodeFor, lookupPeople, resetPersonFields, READONLY_SCOPE, METADATA_SCOPE } = await import("../lib/team/mailbox.ts");
const { messageKey } = await import("../lib/team/crypto.ts");

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

const match = (id: string, extra: Record<string, unknown> = {}) => ({ person: { ...person(id), ...extra } as import("../lib/team/classify.ts").CrmPerson });
const to = (...a: string[]) => a.map((address) => ({ address, field: "to" as const }));

test("each recipient is an attempt: matched cold, ambiguous, other CRM mail; correspondence is not counted", () => {
  const people = new Map<string, import("../lib/team/classify.ts").PersonMatch>([
    ["ana@prospect.test", match("p1")], ["cli@client.test", match("p2", { gtmRelationship: "CLIENT" })],
    ["pa@partner.test", match("p3", { gtmQueue: "PARTNER" })], ["mum@gmail.com", match("p4", { gtmRelationship: "PERSONAL" })],
    ["w@warm.test", match("p6", { prospectReviewState: "WARM_INTRO" })], ["shared@prospect.test", { ambiguous: true }]]);
  const companies = new Map([["prospect.test", ["c1"]], ["client.test", ["c2"]], ["gmail.com", ["c9"]]]);
  const c = classifyMessage(to("ana@prospect.test", "bob@else.test", "shared@prospect.test"), people, companies)!;
  assert.equal(c.kind, "outreach"); assert.deepEqual(c.personIds, ["p1"]);
  assert.deepEqual(c.attempts.map((a) => [a.address, a.match, a.stream, a.personId]), [
    ["ana@prospect.test", "matched", "cold", "p1"], ["bob@else.test", "unmatched", "unknown", null], ["shared@prospect.test", "ambiguous", "unknown", null]]);
  for (const a of ["cli@client.test", "pa@partner.test", "mum@gmail.com"]) assert.equal(classifyMessage(to(a), people, companies), null, a);
  assert.equal(classifyMessage(to("w@warm.test"), people, companies)?.kind, "outreach", "a warm intro is outreach");
  assert.deepEqual(classifyMessage(to("new@prospect.test"), people, companies)?.companyIds, ["c1"]);
  assert.equal(classifyMessage(to("new@prospect.test"), people, companies)?.kind, "other_crm");
  assert.equal(classifyMessage(to("stranger@gmail.com"), people, companies), null, "freemail never matches a company");
  assert.equal(classifyMessage(to("shared@prospect.test"), people, new Map()), null, "an ambiguous address alone is not counted, only reported");
  assert.equal(eligibleForOutreach(person("p", { gtmRelationship: "FORMER_CLIENT" })), false);
});

test("a send that broke policy is counted with flags, never hidden (AC496-01, AC496-02)", () => {
  const sup = match("p5", { gtmQueue: "SUPPRESSED", gtmMarketingConsent: "UNSUBSCRIBED", prospectNotSendable: "EMAIL_BOUNCED", gtmOrigins: ["PROSPECT_TOOL", "LINKEDIN"] });
  const c = classifyMessage(to("x@sup.test"), new Map([["x@sup.test", sup]]), new Map())!;
  assert.equal(c.kind, "outreach");
  assert.deepEqual(c.attempts[0].policyFlags, ["UNSUBSCRIBED", "QUEUE_SUPPRESSED", "NETWORK", "NOT_SENDABLE"]);
  assert.deepEqual(policyFlags({ ...person("p"), prospectNotSendable: "  " }, "a@b.test"), [], "a blank reason is no reason");
  const restricted = { ...person("p"), emails: { primaryEmail: "a@b.test" }, gtmEmailRestrictions: { version: 1, addresses: { "a@b.test": { reason: "EMAIL_BOUNCED" } } } };
  assert.deepEqual(policyFlags(restricted, "a@b.test"), ["ADDRESS_RESTRICTED"]);
  assert.deepEqual(policyFlags({ ...restricted, gtmEmailRestrictions: "junk" }, "a@b.test"), ["RESTRICTIONS_UNREADABLE"]);
});

test("verification is Twenty's verdict on the exact primary address; an additional address is unknown; nothing is inferred from silence", () => {
  const p = { ...person("p"), revEmailVerification: "UNVERIFIED", emails: { primaryEmail: "Ana@Prospect.test", additionalEmails: ["ana@else.test"] } };
  assert.deepEqual(verificationOf(p, "ana@prospect.test", true), { verification: "unverified", verificationBasis: "at_send" });
  assert.deepEqual(verificationOf(p, "ana@prospect.test", false), { verification: "unverified", verificationBasis: "inferred" }, "a backfilled send reads today's value");
  assert.deepEqual(verificationOf(p, "ana@else.test", true), { verification: "unknown", verificationBasis: "none" });
  assert.deepEqual(verificationOf({ ...p, revEmailVerification: null }, "ana@prospect.test", true), { verification: "unknown", verificationBasis: "none" });
  const c = classifyMessage(to("ana@prospect.test"), new Map([["ana@prospect.test", { person: p }]]), new Map(), true)!;
  assert.equal(c.attempts[0].stream, "cold", "an unverified address still counts as a cold attempt");
});

test("the restriction reader matches the CRM's pinned contract cases", () => {
  const raw = readFileSync(new URL("./fixtures/email-contract-v1.json", import.meta.url));
  assert.equal(createHash("sha256").update(raw).digest("hex"), "23feca577ae8581a20a091d328be6c3e24719e684aa39e9e844967a383ea7b6a",
    "re-copy vibrana-crm tests/fixtures/email_contract_v1.json and update this pin together");
  const contract = JSON.parse(raw.toString("utf8"));
  for (const c of contract.cases) {
    const p = { ...structuredClone(contract.base), ...structuredClone(c.set) };
    assert.equal(R.protectedPerson(p), c.expect.protected, `${c.name}: protected`);
    if ("emailTarget" in c.expect) assert.equal(R.emailTarget(p).address, c.expect.emailTarget, `${c.name}: target`);
    for (const [address, reasons] of Object.entries(c.expect.refusals ?? {})) assert.deepEqual(R.emailRefusals(p, address || null), reasons, `${c.name}: ${address || "no address"}`);
  }
});

test("Bcc recipients are attempts; a recipient appears once", () => {
  const m = msg("s1", 1, { To: "Ana <ana@prospect.test>", Cc: "ana@prospect.test", Bcc: "bo@prospect.test" });
  assert.deepEqual(recipientsOf(m, ["me@hq.test"]), [{ address: "ana@prospect.test", field: "to" }, { address: "bo@prospect.test", field: "bcc" }]);
});

test("an outreach effort spans threads and mailboxes: a desk draft's effort, its manual follow-ups, else one manual effort", () => {
  const D = M.DAY, t = Date.parse("2026-11-01T00:00:00Z");
  const drafts = [{ id: "d1", sentAt: t }, { id: "d0", sentAt: null }];
  const a = episodeFor("p1", t + D, drafts);
  assert.equal(a.draftId, "d1");
  const followUp = episodeFor("p1", t + 10 * D, drafts);
  assert.equal(followUp.episodeId, a.episodeId, "a later manual send continues the desk effort");
  assert.equal(followUp.draftId, null);
  const manual = episodeFor("p1", t - 10 * D, drafts);
  assert.notEqual(manual.episodeId, a.episodeId);
  assert.equal(episodeFor("p1", t - 20 * D, []).episodeId, manual.episodeId, "one manual effort per person: no quiet-period reset");
  assert.deepEqual(episodeFor("p1", t, [{ id: "x", sentAt: t }, { id: "y", sentAt: t + D }]), { episodeId: null, draftId: null }, "two candidate drafts: unresolved");
  assert.notEqual(episodeFor("p2", t + D, drafts).episodeId, a.episodeId, "efforts are per person");
});

test("CRM lookup: primary and additional addresses match exactly; an address on two people is ambiguous", async () => {
  resetPersonFields();
  const node = (id: string, primary: string, extra: string[] = []) => ({ id, gtmRelationship: null, prospectReviewState: null, gtmQueue: null, emails: { primaryEmail: primary, additionalEmails: extra } });
  const page = (nodes: unknown[]) => ({ data: { people: { pageInfo: { hasNextPage: false, endCursor: null }, edges: nodes.map((n) => ({ node: n })) } } });
  use([{ url: "https://crm.test/graphql", json: page([node("p1", "Ana@Prospect.test", ["ana.alt@prospect.test"]), node("p2", "shared@x.test"), node("p3", "other@x.test", ["shared@x.test", "anabelle@prospect.test"])]) }]);
  const reader = new TwentyReader({ pauseMs: 0, sleep: async () => {}, now: () => 0 });
  const m = await lookupPeople(reader, ["ana@prospect.test", "ana.alt@prospect.test", "shared@x.test", "ana@else.test"]);
  assert.deepEqual(m.get("ana@prospect.test"), { person: { ...node("p1", "Ana@Prospect.test", ["ana.alt@prospect.test"]) } });
  assert.equal((m.get("ana.alt@prospect.test") as { person: { id: string } }).person.id, "p1");
  assert.deepEqual(m.get("shared@x.test"), { ambiguous: true });
  assert.equal(m.has("ana@else.test"), false);
  assert.equal(m.has("anabelle@prospect.test"), false, "a like-match is re-checked exactly");
  assert.equal(mock!.calls.length, 1, "one request for the batch");
  assert.match(mock!.calls[0].body!, /gtmEmailRestrictions/);
});

test("CRM lookup still works before the CRM has the restrictions field", async () => {
  resetPersonFields();
  use([
    { url: "https://crm.test/graphql", json: { errors: [{ message: "Cannot query field \"gtmEmailRestrictions\" on type \"Person\"." }] }, times: 1 },
    { url: "https://crm.test/graphql", json: { data: { people: { pageInfo: { hasNextPage: false, endCursor: null }, edges: [] } } } },
  ]);
  const reader = new TwentyReader({ pauseMs: 0, sleep: async () => {}, now: () => 0 });
  assert.equal((await lookupPeople(reader, ["a@b.test"])).size, 0);
  assert.doesNotMatch(mock!.calls[1].body!, /gtmEmailRestrictions/);
  resetPersonFields();
});

test("message keys are keyed, ignore brackets and case, and never equal the header", () => {
  assert.equal(messageKey("<ABC@mail.test>"), messageKey("abc@mail.test"));
  assert.notEqual(messageKey("abc@mail.test"), "abc@mail.test");
  assert.match(messageKey("abc@mail.test"), /^[A-Za-z0-9_-]{32}$/);
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
  assert.deepEqual(out, { replies: [{ id: "r1", at: 200, from: "ana@prospect.test" }], bounce: null, failures: [] });
  const b = threadOutcome([msg("d1", 120, { From: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>" }), msg("r2", 130, { From: "ana@prospect.test" }),
    msg("d2", 140, { From: "postmaster@prospect.test" })], 100, ["me@hq.test"], isR);
  assert.deepEqual(b.failures, [{ id: "d1", at: 120 }, { id: "d2", at: 140 }], "every failure report, not only the first");
  assert.deepEqual(b.replies.map((r) => r.id), ["r2"], "a reply after a failure is still a reply");
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
  assert.deepEqual(requestedScopes({ TEAM_GMAIL_READONLY: "1" }), ["openid", "email", READONLY_SCOPE], "readonly only once the OAuth client is configured for it");
  assert.equal(canReadBodies([METADATA_SCOPE]), false, "a metadata grant never reads reply text");
  assert.equal(canReadBodies([READONLY_SCOPE]), true);
  assert.equal(canReadBodies(null), false);
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

test("a send seen in two of the member's mailboxes is one conversation: its copy's thread joins it (review of #30, C2)", () => {
  const sends = Array.from({ length: 10 }, (_, k) => ({ ...ev("outreach", 20, `a${k}`, [`p${k}`]), mailbox: "a@hq.test", message_key: `m${k}` }));
  const copies = sends.map((x, k) => ({ ...x, thread_id: `b${k}`, mailbox: "b@hq.test" }));
  const reply = { ...ev("reply", 18, "b0"), mailbox: "b@hq.test" };
  const r = M.teamReport({ ...base, activity: activity(), mail: [...sends, ...copies, reply] });
  assert.deepEqual([r.cur.emailsSent, r.cur.newThreads, r.cur.replies], [10, 10, 1], "copies add no send and no first touch");
  assert.deepEqual(r.cur.reply, { rate: 0.1, replied: 1, n: 10 }, "the reply through the copy's thread answers the original send");
  assert.equal((r.cur.emailsSent ?? 0) - (r.cur.newThreads ?? 0), 0, "never a negative follow-up count");
});

test("threads linked through a chain of mailboxes are one conversation; a cycle resolves too (review of #30, D2)", () => {
  const others = Array.from({ length: 9 }, (_, k) => ({ ...ev("outreach", 20, `o${k}`, [`q${k}`]), mailbox: "a@hq.test", message_key: `o${k}` }));
  const m1a = { ...ev("outreach", 20, "a", ["p1"]), mailbox: "a@hq.test", message_key: "m1" }, m1b = { ...m1a, thread_id: "b", mailbox: "b@hq.test" };
  const m2b = { ...ev("outreach", 16, "b", ["p1"]), mailbox: "b@hq.test", message_key: "m2" }, m2c = { ...m2b, thread_id: "c", mailbox: "c@hq.test" };
  const reply = { ...ev("reply", 15, "c"), mailbox: "c@hq.test" };
  const r = M.teamReport({ ...base, activity: activity(), mail: [...others, m1a, m1b, m2b, m2c, reply] });
  assert.deepEqual(r.cur.reply, { rate: 0.1, replied: 1, n: 10 }, "the reply in C's thread answers the conversation that began in A");
  assert.equal(r.cur.newThreads, 10);
  // A cycle: m3 links a-b, m4 links b-a in the opposite direction.
  const cyc = M.logicalMail([{ ...m1a, message_key: "m3" }, { ...m1b, message_key: "m3" }, { ...m2b, message_key: "m4" }, { ...m2b, thread_id: "a", mailbox: "a@hq.test", message_key: "m4" }, { ...ev("reply", 15, "b"), mailbox: "b@hq.test" }]);
  assert.equal(new Set(cyc.map((e) => e.thread_id)).size, 1);
});
