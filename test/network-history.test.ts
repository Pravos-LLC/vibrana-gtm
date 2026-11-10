// The network desk's history leg (VIB-522): the optional warm, history, thread-link and connection keys of the network
// dossier contract (old rows without them still import), the thread-link allowlist, the dossier lines, replies on any
// channel ending the follow-up, the weekly per-tier scoreboard, and the network mailbox outcome sync (its own mailbox,
// matched on the alias it sends from, network drafts only). Pure functions and injected readers only; the database paths
// are in test/db/outreach-desk.test.ts. Synthetic data only: .example domains and made-up people.
import { test } from "node:test";
import assert from "node:assert/strict";

const desk = await import("../lib/outreach/desk.ts");
const metrics = await import("../lib/sales/metrics.ts");
const outcomes = await import("../lib/sales/outcomes.ts");
const mailbox = await import("../lib/outreach/mailbox.ts");
const { runProblems } = await import("../lib/sales/run.ts");

const LI = "https://www.linkedin.com/messaging/thread/2-AbCdEf123==/";
const GMAIL = "https://mail.google.com/mail/?authuser=jo@fixture.example#all/18c2f0a1b2c3d4e5";
const network = (over: Record<string, unknown> = {}) => ({
  tier: "T1", relationship: "PRIOR_CONVERSATION", origins: ["LINKEDIN", "GMAIL"], last_exchanged_at: "2026-03-04", last_channel: "gmail",
  last_contacted_at: null, owners: ["JOHN"], context: "Fixture: met at a fixture meetup",
  warm: { score: 72, rank: 14, parts: { relationship: 25, recency: 20, role: 15, reach: 6, connector: 6 } },
  last_thread_url: GMAIL, history: { linkedin: { sent: 4, received: 3 }, gmail: { sent: 3, received: 2 } }, connected_on: "2019-05-02", ...over,
});
const row = (over: Record<string, unknown> = {}) => ({
  twenty_person_id: "00000000-0000-4000-8000-00000000b001", domain: "nia.example", built_at: "2026-11-10T08:00:00Z", track: "network", score: 72, route: "email",
  prospect: { first_name: "Nia", last_name: "Example", title: "Partner", company: "Nia Co", email: "nia@nia.example" },
  client_check: { ok: true }, network: network(), ...over,
});
const problems = (rows: unknown[]) => { try { desk.parseDossiers(JSON.stringify(rows), "network"); return ""; } catch (e) { return (e as Error).message; } };

test("threadUrl: a LinkedIn messaging thread or a Gmail link, https, exact hosts; everything else is null", () => {
  assert.equal(desk.threadUrl(LI), LI);
  assert.equal(desk.threadUrl(GMAIL), GMAIL, "Gmail keeps its query string and its fragment (the thread id)");
  for (const bad of [
    "http://www.linkedin.com/messaging/thread/1/", "https://linkedin.com/messaging/thread/1/", "https://www.linkedin.com/in/nia-example",
    "https://www.linkedin.com.evil.example/messaging/thread/1/", "https://evil.example/?u=https://www.linkedin.com/messaging/thread/1/",
    "https://mail.google.com.evil.example/mail/", "https://gmail.com/mail/", "https://user:pw@mail.google.com/mail/", "https://mail.google.com:444/mail/",
    "javascript:alert(1)", "data:text/html,x", " ", "", null, 42, { href: LI }, "https://mail.google.com/mail/ #x",
  ]) assert.equal(desk.threadUrl(bad), null, String(bad));
});

test("the network contract: the new keys import and are kept; old rows without them import as before", () => {
  const [n] = desk.parseDossiers(JSON.stringify([row()]), "network");
  assert.deepEqual([n.score, n.dossier.network?.warm?.rank, n.dossier.network?.last_thread_url, n.dossier.network?.connected_on], [72, 14, GMAIL, "2019-05-02"]);
  const [old] = desk.parseDossiers(JSON.stringify([row({ network: { tier: "T2", relationship: null, origins: ["LINKEDIN"], last_exchanged_at: "2026-03-04T10:00:00Z", last_channel: "email", owners: [], context: null } })]), "network");
  assert.deepEqual([old.dossier.network?.warm, old.dossier.network?.history, old.dossier.network?.last_thread_url], [undefined, undefined, undefined], "an old row needs none of them");
  const [nulls] = desk.parseDossiers(JSON.stringify([row({ network: network({ warm: null, last_channel: null, last_thread_url: null, history: null, connected_on: null }) })]), "network");
  assert.equal(nulls.dossier.network?.warm, null);
  // A thread link outside the allowlist is dropped at import, the row still imports.
  const [evil] = desk.parseDossiers(JSON.stringify([row({ network: network({ last_thread_url: "https://www.linkedin.com.evil.example/messaging/thread/1/" }) })]), "network");
  assert.equal(evil.dossier.network?.last_thread_url, null);
  // No top-level score: the warm score orders the desk.
  const [noTop] = desk.parseDossiers(JSON.stringify([row({ score: null })]), "network");
  assert.equal(noTop.score, 72);
  assert.equal(desk.normalizeDossier({ ...row({ score: null, track: "client" }) }, "client").score, null, "only a network row falls back to the warm score");
});

test("the network contract: malformed new keys are refused with the field named", () => {
  assert.match(problems([row({ network: network({ warm: 72 }) })]), /network\.warm must be an object or null/);
  assert.match(problems([row({ network: network({ warm: { score: 101 } }) })]), /network\.warm\.score must be a whole number from 0 to 100/);
  assert.match(problems([row({ network: network({ warm: { score: 50, rank: 0 } }) })]), /network\.warm\.rank must be a whole number from 1/);
  assert.match(problems([row({ network: network({ warm: { score: 50, parts: { role: "high" } } }) })]), /network\.warm\.parts must be an object of whole numbers/);
  assert.match(problems([row({ network: network({ history: { gmail: { sent: -1, received: 0 } } }) })]), /network\.history\.gmail must be \{sent, received\} counts/);
  assert.match(problems([row({ network: network({ history: [] }) })]), /network\.history must be an object or null/);
  assert.match(problems([row({ network: network({ connected_on: "May 2019" }) })]), /network\.connected_on must be YYYY-MM-DD or null/);
  assert.match(problems([row({ network: network({ last_thread_url: 7 }) })]), /network\.last_thread_url must be a string or null/);
  assert.equal(problems([row({ network: network({ last_channel: "telegram" }) })]), "", "an unknown channel is shown as written, not refused");
});

test("the dossier lines: message counts, the warm score with its rank and parts", () => {
  assert.equal(desk.messageCountsLine(network().history), "12 messages: you 7, them 5");
  assert.equal(desk.messageCountsLine({ gmail: { sent: 1, received: 0 } }), "1 message: you 1, them 0");
  assert.equal(desk.messageCountsLine({ linkedin: { sent: 0, received: 0 }, gmail: { sent: 0, received: 0 } }), "No messages on record");
  assert.equal(desk.messageCountsLine(null), null);
  assert.equal(desk.messageCountsLine(undefined), null);
  assert.equal(desk.warmLine(network().warm), "#14 · warm score 72: relationship 25, recency 20, role 15, reach 6, connector 6");
  assert.equal(desk.warmLine({ score: 40, rank: null, parts: { relationship: 25 } }), "warm score 40: relationship 25");
  assert.equal(desk.warmLine({ score: 0 }), "warm score 0");
  assert.equal(desk.warmLine({ rank: 3 }), null);
  assert.equal(desk.warmLine(null), null);
  assert.equal(desk.CHANNEL_LABEL.whatsapp, "WhatsApp");
});

test("a reply on any channel ends the follow-up; the queue carries both reply times", () => {
  const now = new Date("2026-11-10T04:00:00Z");
  const item = (over: Record<string, unknown>) => ({ state: "sent" as const, email_status: "sent" as const, follow_up_status: "none" as const, email_sent_at: "2026-11-01T00:00:00Z", linkedin_sent_at: null, ...over });
  assert.ok(desk.followUpDue(item({}), "Asia/Makassar", now), "9 days, no reply: due");
  assert.ok(!desk.followUpDue(item({ email_status: "replied" }), "Asia/Makassar", now));
  assert.ok(!desk.followUpDue(item({ email_replied_at: "2026-11-02T00:00:00Z" }), "Asia/Makassar", now), "a synced reply time ends it even before the status moves");
  assert.ok(!desk.followUpDue(item({ email_status: "none", email_sent_at: null, linkedin_sent_at: "2026-11-01T00:00:00Z", linkedin_replied_at: "2026-11-03T00:00:00Z" }), "Asia/Makassar", now), "a LinkedIn reply John marked ends it");
  assert.ok(desk.hasReplied({ linkedin_replied_at: "x" }) && !desk.hasReplied({ email_status: "sent" }));
  const [q] = desk.buildQueue([{ twenty_person_id: "n", track: "network", domain: null, name: "N", company: "", title: "", score: 1, skipped_at: null, skip_reason: "", email: null, client_ok: null }],
    [{ id: "d", person: "n", track: "network", status: "accepted", email_status: "none", linkedin_status: "sent", linkedin_sent_at: "2026-11-01T00:00:00Z", linkedin_replied_at: "2026-11-02T00:00:00Z" }], "network");
  assert.deepEqual([q.linkedin_replied_at, q.email_replied_at, desk.matchesFilter(q, "followup_due", "UTC", now)], ["2026-11-02T00:00:00Z", null, false]);
});

test("networkWeekly: absolute counts per calendar week and tier, email and LinkedIn apart, network rows only", () => {
  const now = new Date("2026-11-11T04:00:00Z"); // Wednesday in Bali; the week began Monday 2026-11-09
  const r = (o: Partial<import("../lib/sales/metrics.ts").NetworkDeskRow>) => ({ track: "network", route: "email", person: "a", email_sent_at: null, email_sent_by: "jo@fixture.example", follow_up_sent_at: null,
    email_replied_at: null, email_bounced_at: null, reply_sentiment: null, linkedin_sent_at: null, linkedin_sent_by: "jo@fixture.example", linkedin_status: "none", linkedin_replied_at: null, ...o });
  const tiers = new Map([["a", "T1"], ["b", "T2"]]);
  const rows = [
    r({ email_sent_at: "2026-11-09T01:00:00Z", email_replied_at: "2026-11-10T02:00:00Z" }),
    r({ person: "b", route: "linkedin", linkedin_sent_at: "2026-11-10T01:00:00Z", linkedin_status: "sent", linkedin_replied_at: "2026-11-10T09:00:00Z" }),
    // Sunday 23:30 in Bali is last week, though it is Sunday 15:30 UTC.
    r({ person: "b", email_sent_at: "2026-11-08T15:30:00Z", email_bounced_at: "2026-11-08T15:40:00Z" }),
    r({ email_sent_at: "2026-11-02T01:00:00Z", follow_up_sent_at: "2026-11-10T03:00:00Z" }),
    r({ person: "c", email_sent_at: "2026-11-10T01:00:00Z" }),
    r({ track: "client", email_sent_at: "2026-11-10T01:00:00Z", email_replied_at: "2026-11-10T02:00:00Z" }),
    r({ track: "guest", email_sent_at: "2026-11-10T01:00:00Z" }),
  ];
  const owner = (by: string | null) => (by === "jo@fixture.example" ? "JOHN" as const : null);
  const weeks = metrics.networkWeekly(rows, (p) => (p ? tiers.get(p) ?? null : null), { tz: "Asia/Makassar", weeks: 3, now, ownerOf: owner, owner: null });
  assert.deepEqual(weeks.map((w) => w.monday), ["2026-11-09", "2026-11-02", "2026-10-26"], "newest week first");
  const cell = (w: number, tier: string) => { const { tier: _t, ...c } = weeks[w].tiers.find((t) => t.tier === tier)!; return c; };
  assert.deepEqual(cell(0, "T1"), { emailNotes: 1, linkedinNotes: 0, emailReplies: 1, linkedinReplies: 0, followUps: 1, bounces: 0 }, "the follow-up counts in its own week, not the note's");
  assert.deepEqual(cell(0, "T2"), { emailNotes: 0, linkedinNotes: 1, emailReplies: 0, linkedinReplies: 1, followUps: 0, bounces: 0 });
  assert.deepEqual(cell(0, "No tier"), { emailNotes: 1, linkedinNotes: 0, emailReplies: 0, linkedinReplies: 0, followUps: 0, bounces: 0 }, "a person with no tier is still counted");
  assert.deepEqual(cell(1, "T2"), { emailNotes: 1, linkedinNotes: 0, emailReplies: 0, linkedinReplies: 0, followUps: 0, bounces: 1 }, "the week is the report time zone's");
  assert.deepEqual(cell(1, "T1").emailNotes, 1);
  assert.deepEqual(weeks[0].total, { emailNotes: 2, linkedinNotes: 1, emailReplies: 1, linkedinReplies: 1, followUps: 1, bounces: 0 }, "clients and guests never count here");
  assert.deepEqual(weeks[2].tiers.map((t) => t.tier), ["T1", "T2"], "both tiers always show, zeros included; No tier only when it has counts");
  assert.ok(weeks[2].tiers.every((t) => t.emailNotes === 0 && t.linkedinNotes === 0));
  const abe = metrics.networkWeekly(rows, (p) => tiers.get(p ?? "") ?? null, { tz: "Asia/Makassar", weeks: 1, now, ownerOf: owner, owner: "ABE" });
  assert.equal(abe[0].total.emailNotes + abe[0].total.linkedinNotes, 0, "an owner sees only what they marked sent");
});

/** A PostgREST-shaped fake: records every builder call; awaiting returns that table's rows. */
function fakeDb(tables: Record<string, unknown[]>) {
  const calls: Array<{ table: string; method: string; args: unknown[] }> = [];
  const db = {
    from(table: string) {
      const builder: Record<string, unknown> = new Proxy({}, {
        get(_t, method: string) {
          if (method === "then") return (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve({ data: tables[table] ?? [], error: null, count: (tables[table] ?? []).length }).then(ok, bad);
          if (method === "maybeSingle") return () => { calls.push({ table, method, args: [] }); return Promise.resolve({ data: (tables[table] ?? [])[0] ?? null, error: null }); };
          return (...args: unknown[]) => { calls.push({ table, method, args }); return builder; };
        },
      });
      return builder;
    },
  };
  return { db: db as never, calls };
}

const header = (name: string, value: string) => ({ name, value });
const msg = (id: string, at: string, labels: string[], from: string, to: string, subject: string) => ({ id, internalDate: String(Date.parse(at)), labelIds: labels, payload: { headers: [header("From", from), header("To", to), header("Subject", subject)] } });

test("network outcomes: the network mailbox is searched for the alias, network drafts only; a reply and a bounce are stored", async () => {
  const alias = "jo@alias.example";
  const drafts = [
    { id: "d-nia", subject: "Catching up", prospect: { email: "nia@nia.example" }, email_status: "sent", email_sent_at: "2026-11-02T01:00:00.000Z", email_sent_by: "owner@gtm.test", email_replied_at: null, email_bounced_at: null },
    { id: "d-noa", subject: "Long time", prospect: { email: "noa@noa.example" }, email_status: "sent", email_sent_at: "2026-11-02T01:00:00.000Z", email_sent_by: "owner@gtm.test", email_replied_at: null, email_bounced_at: null },
    // A LinkedIn note: no subject, never matched to an email thread.
    { id: "d-ned", subject: "", prospect: { email: "ned@ned.example" }, email_status: "none", email_sent_at: null, email_sent_by: null, email_replied_at: null, email_bounced_at: null },
  ];
  const threads: Record<string, unknown> = {
    a1: { id: "a1", messages: [msg("m1", "2026-11-02T01:00:00Z", ["SENT"], `Jo <${alias}>`, "nia@nia.example", "Catching up"), msg("m2", "2026-11-03T05:00:00Z", ["INBOX", "UNREAD"], "Nia <nia@nia.example>", alias, "Re: Catching up")] },
    b2: { id: "b2", messages: [msg("m3", "2026-11-02T01:00:00Z", ["SENT"], alias, "noa@noa.example", "Long time"), { ...msg("m4", "2026-11-02T01:05:00Z", ["INBOX"], "Mail Delivery Subsystem <mailer-daemon@googlemail.com>", alias, "Delivery Status Notification (Failure)"), payload: { mimeType: "multipart/report", headers: [header("From", "mailer-daemon@googlemail.com"), header("To", alias), header("Subject", "Delivery Status Notification (Failure)")] } }] },
    c3: { id: "c3", messages: [msg("m5", "2026-11-02T01:00:00Z", ["SENT"], alias, "ned@ned.example", "")] },
  };
  const queries: string[] = [];
  const reader = new mailbox.GmailReader("synthetic-token", (async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/threads")) { queries.push(url.searchParams.get("q")!); return Response.json({ threads: Object.keys(threads).map((id) => ({ id })) }); }
    const id = url.pathname.split("/").pop()!;
    return Response.json(threads[id]);
  }) as typeof fetch);
  const { db, calls } = fakeDb({ gtm_outreach_drafts: drafts, gtm_outreach_tracks: [{ from_address: ` ${alias.toUpperCase()} ` }] });
  const run = await outcomes.syncOutcomes(db, { track: "network", deadline: Date.now() + 10_000, reader });
  assert.match(queries[0], /from:jo@alias\.example to:jo@alias\.example cc:jo@alias\.example/, "searched for the alias it sends from, read from the network track's row");
  const tracks = calls.filter((c) => c.table === "gtm_outreach_tracks" && c.method === "eq").map((c) => c.args);
  assert.deepEqual(tracks, [["track", "network"]]);
  const filters = calls.filter((c) => c.table === "gtm_outreach_drafts" && c.method === "eq" && c.args[0] !== "id").map((c) => c.args);
  assert.deepEqual(filters.slice(0, 2), [["status", "accepted"], ["track", "network"]], "network drafts only: client drafts are the HQ mailbox's");
  const updates = calls.filter((c) => c.table === "gtm_outreach_drafts" && c.method === "update").map((c) => c.args[0]);
  assert.deepEqual(updates, [{ email_replied_at: "2026-11-03T05:00:00.000Z", email_status: "replied" }, { email_bounced_at: "2026-11-02T01:05:00.000Z" }]);
  assert.deepEqual([run.matched, run.replied, run.bounced, run.sent], [2, 1, 1, 0], "the subjectless LinkedIn draft matched nothing");
});

test("network outcomes without the network mailbox: skipped, named, and never a pipeline problem; a failure is", async () => {
  const { db } = fakeDb({ gtm_outreach_drafts: [] });
  const saved = Object.fromEntries(["NETWORK_GMAIL_CLIENT_ID", "NETWORK_GMAIL_CLIENT_SECRET", "NETWORK_GMAIL_REFRESH_TOKEN", "NETWORK_GMAIL_ACCOUNT"].map((k) => [k, process.env[k]]));
  for (const k of Object.keys(saved)) delete process.env[k];
  try {
    const run = await outcomes.syncOutcomes(db, { track: "network", deadline: Date.now() + 10_000 });
    assert.deepEqual([run.complete, run.skipped], [false, outcomes.NOT_CONNECTED.network]);
    assert.match(run.skipped!, /NETWORK_GMAIL_\*/);
  } finally { for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v; }
  const at = new Date().toISOString();
  assert.deepEqual(runProblems({ at, result: { networkOutcomes: { scanned: 0, matched: 0, sent: 0, replied: 0, bounced: 0, pages: 0, complete: false, skipped: outcomes.NOT_CONNECTED.network } } }, new Date()), []);
  assert.match(runProblems({ at, result: { networkOutcomes: "error: The inbox could not be read (Gmail 401)." } }, new Date()).join(), /Network inbox outcomes: The inbox could not be read/);
});

test("networkMailboxConfig: all four NETWORK_GMAIL_* values, the account a single address; no fallback account", () => {
  const all = { NETWORK_GMAIL_CLIENT_ID: "client-test", NETWORK_GMAIL_CLIENT_SECRET: "secret-test", NETWORK_GMAIL_REFRESH_TOKEN: "refresh-test", NETWORK_GMAIL_ACCOUNT: "jo@fixture.example" };
  assert.deepEqual(mailbox.networkMailboxConfig(all), { email: "jo@fixture.example", clientId: "client-test", clientSecret: "secret-test", refreshToken: "refresh-test" });
  assert.equal(mailbox.networkMailboxConfig({ ...all, NETWORK_GMAIL_ACCOUNT: "" }), null, "the account is required: it is not the alias the desk sends from");
  assert.equal(mailbox.networkMailboxConfig({ ...all, NETWORK_GMAIL_ACCOUNT: "Jo <jo@fixture.example>" }), null);
  assert.equal(mailbox.networkMailboxConfig({ ...all, NETWORK_GMAIL_REFRESH_TOKEN: "" }), null);
  assert.equal(mailbox.mailboxConfig(all), null, "the HQ connection never borrows the network credentials");
  assert.equal(mailbox.networkMailboxConfig({ OUTREACH_GMAIL_CLIENT_ID: "x", OUTREACH_GMAIL_CLIENT_SECRET: "x", OUTREACH_GMAIL_REFRESH_TOKEN: "x", OUTREACH_GMAIL_ACCOUNT: "hq@fixture.example" }), null, "nor the reverse");
});
