// The writing desk (/outreach/write): the dossier contract and its validation, John's profile, desk states and the
// queue, "sent today" in his time zone, the composer's prefill, advisory hints (never his dashes), the Gmail link, and
// which pipeline drafts are about a person, and the second stream (podcast guests, VIB-463): track-aware counting and queues,
// the follow-up due day arithmetic, per-track sender, guest dossiers and templates. Pure functions only; the database paths
// are in test/db/outreach-desk.test.ts.
// Synthetic data only: .example domains and made-up people.
import { test } from "node:test";
import assert from "node:assert/strict";

const desk = await import("../lib/outreach/desk.ts");
const { groupByProspect, importProblems, normalizeImport } = await import("../lib/outreach/model.ts");
type Draft = import("../lib/outreach/model.ts").Draft;

const dossier = (over: Record<string, unknown> = {}) => ({
  twenty_person_id: "p-ada", domain: "acme.example", built_at: "2026-10-16T08:00:00Z",
  prospect: { first_name: "Ada", last_name: "Example", title: "COO", company: "Acme", email: "ada@acme.example", linkedin_url: "https://www.linkedin.com/in/ada-example", score: 82.5 },
  company: { name: "Acme", domain: "acme.example" }, signal: { text: "Posted a Head of AI role", url: "https://acme.example/jobs/1", date: "2026-10-10", type: "hiring" },
  triggers: [], sources: [{ id: "S1", url: "https://acme.example/jobs/1", title: "Head of AI", text: "Full text" }], brief: null, person: null, colleagues: [], history: [],
  client_check: { ok: true, reason: null, checked_at: "2026-10-16T08:00:00Z" }, ...over,
});

test("parseDossiers: normalizes the denormalized columns; domain falls back to the company, then the email", () => {
  const [a, b, c] = desk.parseDossiers(JSON.stringify([
    dossier(),
    dossier({ twenty_person_id: "p-bo", domain: null, company: { name: "Bo Co", domain: "https://www.Bo.Example/about" }, prospect: { first_name: "Bo", score: "40" } }),
    dossier({ twenty_person_id: "p-cy", domain: "", company: null, prospect: { first_name: "Cy", email: "cy@cy.example" }, built_at: "not a date" }),
  ]));
  assert.deepEqual([a.name, a.company, a.title, a.score, a.domain, a.built_at], ["Ada Example", "Acme", "COO", 82.5, "acme.example", "2026-10-16T08:00:00.000Z"]);
  assert.deepEqual([b.domain, b.score, b.company], ["bo.example", 40, "Bo Co"]);
  assert.deepEqual([c.domain, c.built_at, c.score], ["cy.example", null, null]);
  assert.equal(a.dossier.sources?.[0].text, "Full text", "the whole dossier is kept");
});

test("parseDossiers: every problem is reported with its person, nothing half-parsed", () => {
  const msg = (() => { try { desk.parseDossiers(JSON.stringify([
    dossier({ twenty_person_id: "" }), dossier({ twenty_person_id: "p-x", domain: "Not A Domain" }), dossier({ twenty_person_id: "p-y", sources: "S1" }),
    dossier({ twenty_person_id: "p-z", brief: "notes" }), dossier(), dossier(), 7,
  ])); return ""; } catch (e) { return (e as Error).message; } })();
  for (const re of [/entry 1: twenty_person_id is letters/, /p-x: domain "not a domain" is not a hostname/, /p-y: sources must be an array/, /p-z: brief must be an object or null/, /p-ada: listed twice/, /entry 7: not an object/]) assert.match(msg, re);
  assert.throws(() => desk.parseDossiers("{}"), /JSON array/);
  assert.throws(() => desk.parseDossiers("nope"), /not JSON/);
  assert.throws(() => desk.parseDossiers(JSON.stringify([dossier({ sources: [{ text: "x".repeat(desk.MAX_DOSSIER_BYTES) }] })])), /kB \(at most/);
});

test("parseProfile: needs a signature; the lists are lists", () => {
  const p = desk.parseProfile(JSON.stringify({ name: "Jo Fixture", signature: "Jo\nFounder", facts: [{ id: "f1", text: "t" }], gold_examples: [{ subject: "s", body: "b" }] }));
  assert.equal(p.signature, "Jo\nFounder");
  assert.throws(() => desk.parseProfile(JSON.stringify({ name: "x" })), /no signature/);
  assert.throws(() => desk.parseProfile(JSON.stringify({ signature: "x", facts: "many", voice: "warm" })), /facts must be an array of objects[\s\S]*voice must be an array/);
  assert.throws(() => desk.parseProfile("[]"), /JSON object/);
});

test("deskState: sent beats skipped beats written beats to write", () => {
  const none = { status: "pending", email_status: "none", linkedin_status: "none" } as const;
  assert.equal(desk.deskState({ skipped_at: null }, null), "to_write");
  assert.equal(desk.deskState({ skipped_at: null }, none), "written");
  assert.equal(desk.deskState({ skipped_at: "2026-10-16" }, none), "skipped");
  assert.equal(desk.deskState({ skipped_at: "2026-10-16" }, { ...none, status: "accepted", email_status: "sent" }), "sent");
  assert.equal(desk.deskState({ skipped_at: null }, { ...none, status: "accepted", email_status: "replied" }), "sent");
  assert.equal(desk.deskState({ skipped_at: null }, { ...none, status: "accepted", linkedin_status: "sent" }), "written", "a LinkedIn invite alone is not the email");
});

test("buildQueue and counts: highest score first, then by name; each person with their desk draft", () => {
  const row = (id: string, name: string, score: number | null, extra = {}) => ({ twenty_person_id: id, domain: "a.example", name, company: "Co", title: "", score, skipped_at: null, skip_reason: "", email: null, client_ok: null, ...extra });
  const q = desk.buildQueue(
    [row("p1", "Zed", 50), row("p2", "Amy", 50), row("p3", "Top", 90), row("p4", "None", null, { skipped_at: "2026-10-16", client_ok: "false" })],
    [{ id: "d1", person: "p1", status: "accepted", email_status: "sent", linkedin_status: "none", email_sent_at: "2026-10-16T02:00:00Z" }, { id: "d2", person: "p2", status: "pending", email_status: "none", linkedin_status: "none" }],
  );
  assert.deepEqual(q.map((i) => [i.twenty_person_id, i.state]), [["p3", "to_write"], ["p2", "written"], ["p1", "sent"], ["p4", "skipped"]]);
  assert.equal(q[3].client_ok, false);
  assert.equal(q[2].email_sent_at, "2026-10-16T02:00:00Z");
  assert.deepEqual(desk.counts(q), { to_write: 1, written: 1, sent: 1, skipped: 1 });
});

test("sentToday: counted on John's calendar day in his time zone, not UTC", () => {
  const now = new Date("2026-10-16T17:00:00Z"); // 01:00 on 10-17 in Bali (UTC+8)
  const items = [{ email_sent_at: "2026-10-16T16:30:00Z" }, { email_sent_at: "2026-10-16T15:30:00Z" }, { email_sent_at: null }];
  assert.equal(desk.sentToday(items, "Asia/Makassar", "client", now), 1);
  assert.equal(desk.sentToday(items, "UTC", "client", now), 2);
});

test("prefill: his desk draft, else his own rewrite from a pipeline batch, else 'Hey {first},' and his signature", () => {
  const d = desk.normalizeDossier(dossier()).dossier;
  const blank = desk.prefill(d, { signature: "Jo Fixture\nFounder" }, null, null);
  assert.deepEqual([blank.from, blank.to, blank.subject, blank.body, blank.linkedin_note], ["blank", "ada@acme.example", "", "Hey Ada,\n\n\n\nJo Fixture\nFounder", ""]);
  const own = desk.prefill(d, {}, null, { subject: "His subject", body: "His body", linkedin_note: "His note" });
  assert.deepEqual([own.from, own.subject, own.body], ["own", "His subject", "His body"]);
  const saved = desk.prefill(d, {}, { subject: "Desk", body: "Desk body", linkedin_note: "", prospect: { email: "other@acme.example" } }, { subject: "His subject", body: "His body", linkedin_note: "" });
  assert.deepEqual([saved.from, saved.subject, saved.to], ["desk", "Desk", "other@acme.example"]);
  assert.equal(desk.blankBody("", undefined), "Hey,\n\n");
});

test("hints: words not counting his signature; British spellings flagged; dashes never flagged; nothing blocks", () => {
  const sig = "Jo Fixture\nFounder & CEO, Vibrana\nvibrana.ai";
  const h = desk.hints({ subject: "A quick colour question", body: `Hey Ada, we can organise this whilst you hire — or not - fine.\n\n${sig}`, linkedin_note: "" }, sig);
  assert.equal(h.words, 12);
  assert.equal(h.length, "short");
  assert.deepEqual(h.british.sort(), ["colour", "organise", "whilst"]);
  assert.equal(desk.hints({ subject: "", body: "word ".repeat(130), linkedin_note: "" }).length, "ok");
  assert.equal(desk.hints({ subject: "", body: "word ".repeat(200), linkedin_note: "" }).length, "long");
  const dashy = { to: "ada@acme.example", subject: "Hiring — a thought", body: "Hey Ada — a thought.", linkedin_note: "" };
  assert.deepEqual(desk.sendProblems(dashy), [], "his dashes are his own");
});

test("deskEditProblems and sendProblems: only limits stop a save; sending needs an address, a subject and a body", () => {
  const e = { to: "", subject: "", body: "Hey Ada,", linkedin_note: "" };
  assert.deepEqual(desk.deskEditProblems(e), [], "a half-written draft still saves");
  assert.match(desk.deskEditProblems({ ...e, linkedin_note: "x".repeat(301) }).join(), /301 characters; LinkedIn allows 300/);
  assert.deepEqual(desk.sendProblems(e), ["Add the address it goes to.", "Add a subject."]);
  assert.ok(desk.sameDeskEdit(e, { ...e }));
  assert.ok(!desk.sameDeskEdit(e, { ...e, to: "x@y.example" }));
});

test("gmailComposeUrl: compose as the sending mailbox with to, subject and body, all encoded", () => {
  const u = new URL(desk.gmailComposeUrl({ to: " ada@acme.example ", subject: "Hiring & AI?", body: "Hey Ada,\n\nLine two #1" }));
  assert.equal(u.origin + u.pathname, "https://mail.google.com/mail/");
  assert.deepEqual([u.searchParams.get("authuser"), u.searchParams.get("view"), u.searchParams.get("to"), u.searchParams.get("su"), u.searchParams.get("body")],
    ["user-045d73df3c9a@example.com", "cm", "ada@acme.example", "Hiring & AI?", "Hey Ada,\n\nLine two #1"]);
});

test("the draft row behind the desk: prospect with the Twenty id and the address John sends to; filed under the company domain", () => {
  const d = desk.normalizeDossier(dossier()).dossier;
  const p = desk.draftProspect(d, "ada.private@acme.example");
  assert.deepEqual([p.email, p.twenty_person_id, p.score, p.company], ["ada.private@acme.example", "p-ada", 82.5, "Acme"]);
  assert.equal(desk.draftProspect(d, " ").email, "ada@acme.example");
  assert.deepEqual(desk.draftTrigger(d), { what: "Posted a Head of AI role", date: "2026-10-10", url: "https://acme.example/jobs/1" });
  assert.equal(desk.draftDomain({ domain: null }, "x@other.example"), "other.example");
  assert.equal(desk.draftDomain({ domain: null }, ""), null);
});

test("isAbout: a pipeline draft is about this person by Twenty id, else by company domain; a colleague's draft is not", () => {
  assert.ok(desk.isAbout({ domain: "acme.example", prospect: { twenty_person_id: "p-ada" } }, "p-ada", "acme.example"));
  assert.ok(!desk.isAbout({ domain: "acme.example", prospect: { twenty_person_id: "p-bob" } }, "p-ada", "acme.example"));
  assert.ok(desk.isAbout({ domain: "acme.example", prospect: {} }, "p-ada", "acme.example"));
  assert.ok(!desk.isAbout({ domain: "acme.example", prospect: {} }, "p-ada", null));
});

test("the pipeline cannot import into the desk batch; desk drafts group one card per person in /outreach", () => {
  assert.match(importProblems(normalizeImport({ batch: "desk", domain: "a.example", subject: "s", body: "b" })).join(), /writing desk/);
  const d = (person: string) => ({ id: person, batch: "desk", domain: "acme.example", variant: "john", person, status: "pending", prospect: {} }) as unknown as Draft;
  assert.equal(groupByProspect([d("p-ada"), d("p-bob")]).length, 2);
});

test("storable: NUL characters and lone surrogates never reach Postgres; real text and emoji are untouched", () => {
  const raw = JSON.parse('{"twenty_person_id":"p-n","domain":"n.example","sources":[{"id":"S1","text":"a\\u0000b \\ud83d\\ude00 c\\ud800d"}],"prospect":{"first_name":"N\\u0000a"}}');
  const [d] = desk.parseDossiers(JSON.stringify([raw]));
  assert.equal(d.dossier.sources![0].text, "ab \u{1F600} c\uFFFDd");
  assert.equal(d.name, "Na");
  assert.ok(!JSON.stringify(d).includes("\\u0000"));
  assert.equal(desk.parseProfile('{"signature":"Jo\\u0000"}').signature, "Jo");
});

test("links: Cmd+K wraps the selection, counts as text, copies as HTML and plain, Gmail URL leaves a linked body out", () => {
  const b = "Try the AI Transformation Simulator today.";
  const s = b.indexOf("AI"), e = s + "AI Transformation Simulator".length;
  const r = desk.applyLink(b, s, e, "https://brand.example.com/simulator", "");
  assert.equal(r.body, "Try the [AI Transformation Simulator](https://brand.example.com/simulator) today.");
  assert.equal(desk.bodyLinks(r.body).length, 1);
  assert.equal(desk.wordCount(r.body), 6);
  assert.equal(desk.bodyPlain(r.body), "Try the AI Transformation Simulator (https://brand.example.com/simulator) today.");
  assert.match(desk.bodyHtml(r.body), /<a href="https:\/\/brand\.example\.com\/simulator">AI Transformation Simulator<\/a>/);
  const again = desk.applyLink(r.body, s + 2, s + 2, "https://brand.example.com/ai-readiness", "");
  assert.equal(again.body, "Try the [AI Transformation Simulator](https://brand.example.com/ai-readiness) today.");
  assert.equal(desk.removeLink(r.body, desk.bodyLinks(r.body)[0]), b);
  assert.equal(desk.normalizeLinkUrl("brand.example.com/simulator"), "https://brand.example.com/simulator");
  assert.equal(desk.normalizeLinkUrl("not a url"), null);
  assert.equal(new URL(desk.gmailComposeUrl({ to: "user-80305c9bb1bb@example.com", subject: "x", body: r.body })).searchParams.get("body"), null);
  assert.equal(desk.bodyHtml("<b>&"), '<p style="margin:0 0 1em">&lt;b&gt;&amp;</p>');
});

// ---- the guest stream (VIB-463) ----------------------------------------------------------------------------------------

const guestDossier = (over: Record<string, unknown> = {}) => ({
  twenty_person_id: "guest-md:gia-example", domain: "gia-example.guest.invalid", built_at: "2026-10-19T08:00:00Z", track: "guest", score: 88, route: "linkedin", not_in_twenty: true,
  prospect: { first_name: "Gia", last_name: "Example", title: "Founder", company: "Gia Org", email: "", linkedin_url: "https://www.linkedin.com/in/gia-example", country: "NL", city: "Utrecht", lane: "operator" },
  signal: { text: "Gave a talk", url: "https://gia.example/talk", date: "2026-10-12", type: "guest_trigger" }, client_check: { ok: true, reason: null, checked_at: "2026-10-19T08:00:00Z" },
  guest: { season: "2", lane: "operator", tier: "A", pillar: "P", template: "01", trigger: "Gave a talk", prompts: ["a", "b", "c"], contact_line: "Office, office.example" }, ...over,
});

test("parseDossiers: a guest file holds guest rows and a client file client rows; the guest score and synthetic domain parse", () => {
  const [g] = desk.parseDossiers(JSON.stringify([guestDossier()]), "guest");
  assert.deepEqual([g.track, g.score, g.domain, g.twenty_person_id, g.name, g.company], ["guest", 88, "gia-example.guest.invalid", "guest-md:gia-example", "Gia Example", "Gia Org"]);
  assert.equal(g.dossier.guest?.template, "01");
  const wrongWay = (file: unknown[], track: "client" | "guest") => { try { desk.parseDossiers(JSON.stringify(file), track); return ""; } catch (e) { return (e as Error).message; } };
  assert.match(wrongWay([dossier()], "guest"), /p-ada: is a row with no track, but this is a guest import \(--track guest\)/);
  assert.match(wrongWay([guestDossier()], "client"), /is a guest, but this is a client import \(--track client\)/);
  assert.match(wrongWay([dossier({ track: "client" })], "guest"), /is a client, but this is a guest import/);
  assert.equal(desk.parseDossiers(JSON.stringify([dossier({ track: "client" })]))[0].track, "client", "a client row may name its track");
  assert.match(wrongWay([guestDossier({ route: "fax" })], "guest"), /route "fax" is not email, linkedin or intermediary/);
  assert.match(wrongWay([guestDossier({ guest: { template: "09", prompts: "x" } })], "guest"), /guest\.template "09" is not 01 to 04/);
  assert.match(wrongWay([guestDossier({ guest: { prompts: "x" } })], "guest"), /guest\.prompts must be an array/);
});

test("parseDossiers: missing guest fields are fine; the row still parses and the guest helpers fall back", () => {
  const [g] = desk.parseDossiers(JSON.stringify([guestDossier({ guest: null, route: undefined, prospect: { first_name: "Gia" }, score: "55" })]), "guest");
  assert.deepEqual([g.score, g.name, g.company, g.dossier.guest], [55, "Gia", "", null]);
  assert.equal(desk.guestRoute(g.dossier), "email", "no route on the dossier means email");
  assert.equal(desk.guestRoute({ route: "intermediary" }), "intermediary");
  assert.equal(desk.scaffoldFor({ templates: { "01": "x" } }, g.dossier), null, "no template on the guest, no scaffold");
});

test("sentToday per track: a client counts the email only; a guest counts the email or the LinkedIn note; a follow-up never counts", () => {
  const now = new Date("2026-10-19T04:00:00Z"); // 12:00 in Bali
  const items = [
    { email_sent_at: "2026-10-19T01:00:00Z", linkedin_sent_at: null },
    { email_sent_at: null, linkedin_sent_at: "2026-10-19T02:00:00Z" },
    { email_sent_at: "2026-10-12T01:00:00Z", linkedin_sent_at: null, follow_up_sent_at: "2026-10-19T03:00:00Z" },
    { email_sent_at: "2026-10-19T01:30:00Z", linkedin_sent_at: "2026-10-19T01:40:00Z" },
  ];
  assert.equal(desk.sentToday(items, "Asia/Makassar", "client", now), 2, "a LinkedIn note alone is not a client's sent email");
  assert.equal(desk.sentToday(items, "Asia/Makassar", "guest", now), 3, "email, LinkedIn route and both on one person (once); the follow-up row is not counted");
  assert.equal(desk.sentToday(items, "Asia/Makassar", undefined, now), 2, "clients by default");
});

test("buildQueue per track: a guest never shows in the client queue and the reverse; guests carry route and follow-up fields", () => {
  const row = (id: string, name: string, score: number, track: "client" | "guest", extra = {}) => ({ twenty_person_id: id, track, domain: "a.example", name, company: "Co", title: "", score, skipped_at: null, skip_reason: "", email: null, client_ok: null, ...extra });
  const rows = [row("c1", "Cal", 50, "client"), row("g1", "Gia", 90, "guest", { route: "intermediary" }), row("g2", "Gus", 70, "guest", { not_in_twenty: "true" }), row("old", "Old", 10, "client")];
  const drafts = [
    { id: "d1", person: "g1", track: "guest" as const, status: "accepted" as const, email_status: "sent" as const, linkedin_status: "none" as const, email_sent_at: "2026-10-10T01:00:00Z", follow_up_status: "none" as const },
    { id: "d2", person: "g2", track: "guest" as const, status: "accepted" as const, email_status: "none" as const, linkedin_status: "sent" as const, linkedin_sent_at: "2026-10-19T01:00:00Z" },
    { id: "d3", person: "c1", track: "client" as const, status: "pending" as const, email_status: "none" as const, linkedin_status: "none" as const },
  ];
  const clients = desk.buildQueue(rows, drafts, "client");
  const guests = desk.buildQueue(rows, drafts, "guest");
  assert.deepEqual(clients.map((i) => [i.twenty_person_id, i.state, i.track]), [["c1", "written", "client"], ["old", "to_write", "client"]]);
  assert.deepEqual(guests.map((i) => [i.twenty_person_id, i.state, i.track]), [["g1", "sent", "guest"], ["g2", "sent", "guest"]], "a LinkedIn-route note is sent for a guest");
  assert.deepEqual(desk.buildQueue(rows, drafts).map((i) => i.twenty_person_id), ["c1", "old"], "clients by default");
  assert.equal(desk.buildQueue([{ ...row("x", "X", 1, "client"), track: undefined }], []).length, 1, "a row with no track is a client");
  assert.equal(guests[1].linkedin_sent_at, "2026-10-19T01:00:00Z");
  assert.equal(desk.deskState({ skipped_at: null }, drafts[1], "client"), "written", "the client state is unchanged: a LinkedIn invite alone is not the email");
});

test("followUpDue: 7 calendar days in the report time zone, no reply, no follow-up yet; the edge days", () => {
  const sent = (at: string, over = {}) => ({ state: "sent" as const, email_status: "sent" as const, follow_up_status: "none" as const, email_sent_at: at, linkedin_sent_at: null, ...over });
  const tz = "Asia/Makassar"; // UTC+8
  const now = new Date("2026-10-19T04:00:00Z"); // 10-19 12:00 in Bali
  assert.ok(desk.followUpDue(sent("2026-10-12T00:00:00Z"), tz, now), "exactly 7 days ago is due");
  assert.ok(!desk.followUpDue(sent("2026-10-13T00:00:00Z"), tz, now), "6 days is not");
  assert.ok(desk.followUpDue(sent("2026-10-11T23:00:00Z"), tz, now), "10-11 23:00 UTC is 10-12 07:00 in Bali: calendar day 7 ago");
  assert.ok(!desk.followUpDue(sent("2026-10-12T16:30:00Z"), tz, now), "10-12 16:30 UTC is 10-13 00:30 in Bali: only 6 days");
  assert.ok(desk.followUpDue(sent("2026-10-12T16:30:00Z"), "UTC", now), "the same instant is 7 days ago in UTC: the zone decides");
  assert.ok(desk.followUpDue(sent("2026-09-01T00:00:00Z"), tz, now), "long overdue stays due");
  assert.ok(!desk.followUpDue(sent("2026-10-01T00:00:00Z", { email_status: "replied" }), tz, now), "a reply ends it");
  assert.ok(!desk.followUpDue(sent("2026-10-01T00:00:00Z", { follow_up_status: "sent" }), tz, now), "one follow-up only");
  assert.ok(!desk.followUpDue(sent("2026-10-01T00:00:00Z", { state: "written" as never }), tz, now), "only a sent person");
  assert.ok(desk.followUpDue({ ...sent("2026-10-01T00:00:00Z"), email_status: "none", email_sent_at: null, linkedin_sent_at: "2026-10-01T00:00:00Z" }, tz, now), "a LinkedIn-route guest is followed up too");
  assert.equal(desk.firstSentAt({ email_sent_at: "2026-10-10T00:00:00Z", linkedin_sent_at: "2026-10-05T00:00:00Z" }), "2026-10-05T00:00:00Z", "the follow-up clock starts at the first touch, LinkedIn or email");
  assert.equal(desk.firstSentAt({ email_sent_at: "2026-10-10T00:00:00Z", linkedin_sent_at: null }), "2026-10-10T00:00:00Z");
  assert.equal(desk.firstSentAt({ email_sent_at: null, linkedin_sent_at: null }), null);
  assert.ok(desk.followUpDue({ ...sent("2026-10-17T00:00:00Z"), linkedin_sent_at: "2026-10-05T00:00:00Z" }, tz, now), "a LinkedIn note 14 days ago, then an email 2 days ago, is still due");
  assert.equal(desk.daysBetween("2026-10-12T23:00:00Z", "2026-10-13T01:00:00Z", "UTC"), 1, "23:00 to 01:00 across midnight is a day on the calendar");
  assert.equal(desk.daysBetween("2026-10-12T23:00:00Z", "2026-10-13T01:00:00Z", "Asia/Makassar"), 0, "and the same hours are one day in Bali");
});

test("guest queue chips: Follow-up due and Needs route; a client never has them", () => {
  const now = new Date("2026-10-19T04:00:00Z");
  const base = { twenty_person_id: "g", track: "guest" as const, domain: null, name: "G", company: "", title: "", score: 1, skipped_at: null, skip_reason: "", email: null, client_ok: null };
  const item = (over: Record<string, unknown>) => ({ ...base, state: "to_write", draft_id: null, status: null, email_status: null, linkedin_status: null, email_sent_at: null, linkedin_sent_at: null, follow_up_status: null, follow_up_sent_at: null, ...over }) as unknown as import("../lib/outreach/desk.ts").QueueItem;
  const inter = item({ route: "intermediary" }), noTwenty = item({ not_in_twenty: true }), plain = item({ route: "email" }), sentInter = item({ route: "intermediary", state: "sent" });
  assert.deepEqual([inter, noTwenty, plain, sentInter].map((i) => desk.matchesFilter(i, "needs_route", "UTC", now)), [true, true, false, false]);
  assert.ok(desk.matchesFilter(item({ state: "sent", email_status: "sent", email_sent_at: "2026-10-01T00:00:00Z" }), "followup_due", "UTC", now));
  assert.ok(desk.matchesFilter(plain, "to_write", "UTC", now) && !desk.matchesFilter(plain, "sent", "UTC", now));
  assert.deepEqual(desk.FILTERS.client, desk.DESK_FILTERS);
  assert.deepEqual(desk.FILTERS.guest.map((f) => desk.FILTER_LABEL[f]), ["To write", "Written", "Sent", "Follow-up due", "Skipped", "Needs route"]);
});

test("the sender follows the stream: the Gmail compose URL carries the track's address; defaults are 5 from vibranahq.com and 2 from sample-author.com", () => {
  const e = { to: "gia@gia.example", subject: "Hi", body: "Hey Gia," };
  assert.equal(new URL(desk.gmailComposeUrl(e, desk.TRACK_DEFAULTS.guest.from_address)).searchParams.get("authuser"), "user-8dd8662c2f5a@example.com");
  assert.equal(new URL(desk.gmailComposeUrl(e, desk.TRACK_DEFAULTS.client.from_address)).searchParams.get("authuser"), "user-045d73df3c9a@example.com");
  assert.deepEqual([desk.TRACK_DEFAULTS.client.daily_target, desk.TRACK_DEFAULTS.guest.daily_target, desk.DEFAULT_TARGET], [5, 2, 5]);
  assert.deepEqual([desk.isTrack("guest"), desk.isTrack("client"), desk.isTrack("other")], [true, true, false]);
});

test("senderFor: the client stream sends as the account's own gtm_sender; guests and bad values keep the stream's address", () => {
  const stream = "user-045d73df3c9a@example.com";
  const abe = { app_metadata: { gtm_owner: true, gtm_sender: "user-9b0b68d398d1@example.com" } };
  assert.equal(desk.senderFor("client", stream, abe), "user-9b0b68d398d1@example.com");
  assert.equal(desk.senderFor("guest", "user-8dd8662c2f5a@example.com", abe), "user-8dd8662c2f5a@example.com");
  for (const claims of [null, undefined, {}, { app_metadata: {} }, { app_metadata: { gtm_sender: "nope" } }, { app_metadata: { gtm_sender: 5 } }, { app_metadata: { gtm_sender: "a b@c.d" } }]) {
    assert.equal(desk.senderFor("client", stream, claims), stream);
  }
});

test("senderProfile: an account with gtm_signature signs as itself on the client stream; guests, bad values and other accounts keep the stream's profile", () => {
  const john = { name: "Sample Author", first_name: "John", signature: "Sample Author\nFounder & CEO, Vibrana", positioning: "p" };
  const abe = { app_metadata: { gtm_owner: true, gtm_signature: "Abe Sample Person\nVibrana", gtm_name: "Abe Sample Person", gtm_first_name: "Abe" } };
  assert.deepEqual(desk.senderProfile("client", john, abe), { ...john, name: "Abe Sample Person", first_name: "Abe", signature: "Abe Sample Person\nVibrana" });
  assert.equal(desk.senderProfile("client", john, { app_metadata: { gtm_signature: "Abe Sample Person" } }).name, "Sample Author", "no gtm_name keeps the stream's name");
  assert.equal(desk.senderProfile("guest", john, abe), john, "the podcast host's profile is never replaced");
  for (const claims of [null, undefined, {}, { app_metadata: {} }, { app_metadata: { gtm_signature: "  " } }, { app_metadata: { gtm_signature: 5 } }, { app_metadata: { gtm_signature: "x".repeat(501) } }]) {
    assert.equal(desk.senderProfile("client", john, claims), john);
  }
  assert.equal(desk.blankBody("Ada", desk.senderProfile("client", john, abe).signature), "Hey Ada,\n\n\n\nAbe Sample Person\nVibrana");
});

test("blankBody per track: each stream starts from its own profile's signature, and nothing else", () => {
  const client = desk.blankBody("Ada", "Jo Fixture\nFounder");
  const guest = desk.blankBody("Gia", "Jo Fixture\nHost of The Fixture Show");
  assert.equal(client, "Hey Ada,\n\n\n\nJo Fixture\nFounder");
  assert.equal(guest, "Hey Gia,\n\n\n\nJo Fixture\nHost of The Fixture Show");
  assert.equal(desk.blankBody("Gia", undefined), "Hey Gia,\n\n", "a guest profile not imported yet gives a bare greeting");
  const d = desk.normalizeDossier(guestDossier(), "guest").dossier;
  assert.equal(desk.prefill(d, { signature: "Jo\nHost" }, null, null).body, "Hey Gia,\n\n\n\nJo\nHost");
  assert.equal(desk.prefill(d, {}, null, null).to, "", "a LinkedIn-route guest has no address to prefill");
});

test("guest hints: wisdom keeper and elder flagged (advice only), em dashes, British spellings, length, unfilled slots; a client email is untouched", () => {
  const body = "Hey Gia,\n\nI would love a wisdom keeper like you, an Elder of the craft \u2014 and the colour of it. {{trigger}}\n\nJo";
  const g = desk.hints({ subject: "", body, linkedin_note: "" }, undefined, "guest");
  assert.deepEqual(g.wisdom.sort(), ["elder", "wisdom keeper"]);
  assert.deepEqual([g.emDash, g.slots, g.british], [true, 1, ["colour"]]);
  const c = desk.hints({ subject: "", body, linkedin_note: "" });
  assert.deepEqual([c.wisdom, c.emDash, c.slots], [[], false, 0], "clients keep the old hints: his dashes are his own");
  assert.equal(desk.hints({ subject: "", body: "word ".repeat(130), linkedin_note: "" }, undefined, "guest").length, "ok");
  assert.equal(desk.hints({ subject: "", body: "word ".repeat(40), linkedin_note: "" }, undefined, "guest").length, "short");
  assert.deepEqual(desk.hints({ subject: "", body: "Hey,", linkedin_note: "An elders circle" }, undefined, "guest").wisdom, ["elders"]);
});

test("guest scaffolds: the template the guest names, from the profile; subject and first name filled; slots left; missing text hides it", () => {
  const profile = { templates: { "01": "Subject: Leading the transition at {{company}}\n\nHey {{first_name}},\n\n{{trigger: one dated thing}}\n\nJo", "04": "" } };
  const d = desk.normalizeDossier(guestDossier(), "guest").dossier;
  const sc = desk.scaffoldFor(profile, d)!;
  assert.deepEqual([sc.id, sc.label, sc.subject], ["01", "Operator", "Leading the transition at Gia Org"]);
  assert.equal(sc.body, "Hey Gia,\n\n{{trigger: one dated thing}}\n\nJo");
  assert.deepEqual(sc.body.match(desk.SLOT), ["{{trigger: one dated thing}}"]);
  assert.equal(desk.scaffoldFor({}, d), null, "no templates in the profile: the control is hidden");
  assert.equal(desk.scaffoldFor(profile, { ...d, guest: { ...d.guest, template: "04" } }), null, "an empty scaffold is hidden too");
  assert.equal(desk.scaffoldFor(profile, { ...d, guest: { ...d.guest, template: "02" } }), null, "no text for that template");
  assert.equal(desk.TEMPLATE_LABEL["04"], "Wisdom keeper");
  assert.throws(() => desk.parseProfile(JSON.stringify({ signature: "x", templates: { "01": 5 } })), /templates must be an object of strings/);
  assert.equal(desk.parseProfile(JSON.stringify({ signature: "x", templates: { "01": "t" } })).templates?.["01"], "t");
});

test("route send problems: an email needs an address, subject and body; a LinkedIn note needs the note; an intermediary message needs the text", () => {
  const e = { to: "", subject: "", body: "", linkedin_note: "" };
  assert.deepEqual(desk.routeSendProblems(e, "email"), ["Add the address it goes to.", "Add a subject.", "The email is empty."]);
  assert.deepEqual(desk.routeSendProblems(e, "linkedin"), ["The LinkedIn note is empty."]);
  assert.deepEqual(desk.routeSendProblems({ ...e, linkedin_note: "Hi" }, "linkedin"), []);
  assert.deepEqual(desk.routeSendProblems(e, "intermediary"), ["The message is empty."]);
  assert.deepEqual(desk.routeSendProblems({ ...e, body: "Hello" }, "intermediary"), [], "an organization's contact may be a form: no address needed");
  assert.match(desk.routeSendProblems({ ...e, linkedin_note: "x".repeat(301) }, "linkedin").join(), /301 characters/);
});

test("export age: stale after 3 days, null without a date", () => {
  const now = new Date("2026-10-19T12:00:00Z");
  assert.equal(desk.exportAgeDays("2026-10-19T08:00:00Z", now), 0);
  assert.equal(desk.exportAgeDays("2026-10-15T08:00:00Z", now), 4);
  assert.equal(desk.exportAgeDays(null, now), null);
  assert.ok(!desk.exportIsStale("2026-10-16T12:00:00Z", now), "exactly 3 days old is not stale");
  assert.ok(desk.exportIsStale("2026-10-16T11:59:00Z", now), "more than 3 days is");
  assert.ok(!desk.exportIsStale(null, now) && !desk.exportIsStale("not a date", now));
});

// ---- where to find a guest -----------------------------------------------------------------------------------------------

test("guestReach: LinkedIn, email, site, contact page and handles, best first", () => {
  const links = desk.guestReach({
    twenty_person_id: "g1", track: "guest", domain: "lab.example",
    prospect: { linkedin_url: "https://www.linkedin.com/in/riley-fixture", email: "riley@lab.example" },
    guest: { org_email: "office@lab.example", website: "lab.example", contact_url: "https://lab.example/contact", handles: { x: "@riley", substack: "https://riley.substack.example" } },
  } as never, "Riley Fixture", "Fixture Lab");
  assert.deepEqual(links.map((l) => l.kind), ["linkedin", "email", "org_email", "website", "contact", "handle", "handle"]);
  assert.equal(links.find((l) => l.kind === "website")?.href, "https://lab.example", "a bare host becomes a link");
  assert.equal(links.find((l) => l.label === "X")?.href, "https://x.com/riley");
  assert.ok(links.every((l) => l.found));
});

test("guestReach: nothing known gives search links, never a dead end", () => {
  const links = desk.guestReach({ twenty_person_id: "guest-md:x", track: "guest", domain: "x.guest.invalid", guest: {} } as never, "Angie Abdilla", "Old Ways, New");
  assert.deepEqual(links.map((l) => [l.kind, l.found]), [["search", false], ["search", false]]);
  assert.match(links[0]!.href, /^https:\/\/www\.linkedin\.com\/search\/results\/people\/\?keywords=Angie%20Abdilla%20Old%20Ways/);
  const [only] = desk.guestReach({ twenty_person_id: "g", track: "guest", prospect: { linkedin_url: "https://www.linkedin.com/in/a" } } as never, "A B", "");
  assert.equal(only!.found, true);
  assert.equal(desk.siteUrl("javascript:alert(1)"), null);
  assert.equal(desk.siteUrl("cybernetics.anu.edu.au"), "https://cybernetics.anu.edu.au");
});

test("prefill: an intermediary guest starts with a greeting to the organization, not the guest, and the organization address", () => {
  const d = { twenty_person_id: "g", track: "guest", route: "intermediary", prospect: { first_name: "Angie" }, guest: { org_email: "office@lab.example" } } as never;
  const start = desk.prefill(d, { signature: "John" }, null, null);
  assert.equal(start.to, "office@lab.example");
  assert.match(start.body, /^Hello,/);
  const direct = desk.prefill({ ...(d as object), route: "email", prospect: { first_name: "Angie", email: "a@lab.example" } } as never, { signature: "John" }, null, null);
  assert.match(direct.body, /^Hey Angie,/);
});

test("parseProfile: podcast_history is an object", () => {
  assert.equal(desk.parseProfile(JSON.stringify({ signature: "J", podcast_history: { summary: "s", shows: [] } })).podcast_history?.summary, "s");
  assert.throws(() => desk.parseProfile(JSON.stringify({ signature: "J", podcast_history: "lots" })), /podcast_history must be an object/);
});

test("guestReach: handle keys that name object members or are empty never become links", () => {
  const links = desk.guestReach({
    twenty_person_id: "g1", track: "guest", domain: "lab.example", prospect: {},
    guest: { website: "lab.example", handles: JSON.parse(`{"constructor":"javascript:alert(1)","__proto__":"x","":"y","toString":"z","x":"@riley"}`) },
  } as never, "Riley Fixture", "Fixture Lab");
  assert.deepEqual(links.filter((l) => l.kind === "handle").map((l) => l.href), ["https://x.com/riley"]);
});

test("parseProfile: podcast_history shows and notable_guests are arrays of objects", () => {
  assert.throws(() => desk.parseProfile(JSON.stringify({ signature: "J", podcast_history: { shows: ["ReFi"] } })), /podcast_history\.shows must be an array of objects/);
  assert.throws(() => desk.parseProfile(JSON.stringify({ signature: "J", podcast_history: { notable_guests: "many" } })), /podcast_history\.notable_guests/);
});

test("prefill: an intermediary guest's first line goes to the organization's address", () => {
  const d = { twenty_person_id: "g1", track: "guest", domain: "x.example", prospect: { first_name: "Ina", email: "ina@x.example" }, route: "intermediary", guest: { org_email: "office@x.example", channel: "intermediary" } } as never;
  assert.equal(desk.prefill(d, { signature: "J" } as never, null, null).to, "office@x.example");
});

test("prefill: another account's saved text or own rewrite is re-signed to the signed-in account's signature", () => {
  const d = { track: "client", prospect: { first_name: "Gia", email: "g@x.example" } } as never;
  const john = "Sample Author\nFounder & CEO, Vibrana", abe = "Abe Sample Person\nVibrana";
  const body = `Hey Gia,\n\nShort note.\n\n${john}`;
  const own = desk.prefill(d, { signature: abe }, null, { subject: "s", body, linkedin_note: "" }, john);
  assert.equal(own.body, `Hey Gia,\n\nShort note.\n\n${abe}`);
  const saved = desk.prefill(d, { signature: abe }, { subject: "s", body, linkedin_note: "", prospect: {} } as never, null, john);
  assert.equal(saved.body, `Hey Gia,\n\nShort note.\n\n${abe}`);
  assert.equal(desk.prefill(d, { signature: john }, null, { subject: "s", body, linkedin_note: "" }, john).body, body, "same signature: untouched");
  assert.equal(desk.prefill(d, { signature: abe }, null, { subject: "s", body: "No sign-off", linkedin_note: "" }, john).body, "No sign-off");
});

test("prefill resign: P.S. after the sign-off, CRLF, link-only signature lines and mid-body mentions", () => {
  const d = { track: "client", prospect: { first_name: "Gia", email: "g@x.example" } } as never;
  const john = "Sample Author\nFounder & CEO, Vibrana", abe = "Abe Sample Person\nVibrana";
  const row = (body: string, stream = john) => desk.prefill(d, { signature: abe }, null, { subject: "s", body, linkedin_note: "" }, stream).body;
  assert.equal(row(`Hey Gia,\n\nNote.\n\n${john}\n\nP.S. Congrats on the round.`), `Hey Gia,\n\nNote.\n\n${abe}\n\nP.S. Congrats on the round.`);
  assert.equal(row(`Hey Gia,\r\n\r\nNote.\r\n\r\n${john.replace("\n", "\r\n")}`), `Hey Gia,\n\nNote.\n\n${abe}`);
  const linked = `${john}\nvibrana.ai`;
  assert.equal(row(`Hey Gia,\n\nNote.\n\n${john}`, linked), `Hey Gia,\n\nNote.\n\n${abe}`, "formatted body drops the link-only line");
  assert.equal(row(`Hey Gia,\n\nI am ${john} on a call.\n\nThanks`), `Hey Gia,\n\nI am ${john} on a call.\n\nThanks`, "a mid-body mention is not a signature");
});
