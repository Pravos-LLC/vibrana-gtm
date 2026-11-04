// Team mailbox sync against the real LOCAL database, with Gmail and Twenty mocked: the first backfill, that a cursor
// never moves past unfinished work (a CRM failure, a deadline mid-run), that a deleted message is skipped, and that a
// too-old history cursor lists again from the last fully successful run. Synthetic data only.
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { admin, seed } from "../support/seed.ts";
import { local } from "../support/local-supabase.ts";
import { installFetchMock, type Route } from "../support/fetch-mock.ts";

const l = local();
Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: l.url, SUPABASE_SECRET_KEY: l.secretKey, TEAM_MAILBOX_KEY: randomBytes(32).toString("base64"), TWENTY_API_KEY: "twenty_test", TWENTY_BASE: "https://crm.test" });
const { syncMailbox, mailboxAad, stateKey } = await import("../../lib/team/mailbox.ts");
const { sealToken, addressHash } = await import("../../lib/team/crypto.ts");
const { parseMembers } = await import("../../lib/team/members.ts");
const { TwentyReader } = await import("../../lib/twenty.ts");

const DB: Route = { url: l.url, passthrough: true };
const GM = "https://gmail.googleapis.com/gmail/v1/users/me/";
const BOX = "mate@hq.test";
const member = parseMembers(JSON.stringify([{ code: "TSYNC", authEmail: "mate@team.test", apiKeyNames: ["k"], mailboxes: [BOX] }]))[0];
const cfg = { clientId: "cid", clientSecret: "cs" };
const T0 = Date.parse("2026-10-20T10:00:00Z");

let mock: ReturnType<typeof installFetchMock> | null = null;
afterEach(() => { mock?.restore(); mock = null; });
before(async () => { await seed(); });

const sent = (id: string, at: number, to: string) => ({ id, threadId: `${id}0`, internalDate: String(at), labelIds: ["SENT"], payload: { headers: [{ name: "From", value: BOX }, { name: "To", value: to }] } });
const page = (object: string, nodes: unknown[]) => JSON.stringify({ data: { [object]: { pageInfo: { hasNextPage: false, endCursor: null }, edges: nodes.map((node) => ({ node })) } } });
const ana = { id: "p1", gtmRelationship: null, prospectReviewState: null, gtmQueue: null, emails: { primaryEmail: "Ana@Prospect.test" } };
const base = (over: Route[] = []): Route[] => [
  ...over,
  { url: "https://oauth2.googleapis.com/token", json: { access_token: "at" } },
  { url: `${GM}profile`, json: { emailAddress: BOX, historyId: "900" } },
  DB,
];

async function fresh(row: Partial<{ history_id: string | null; backfill_done: boolean }> = {}) {
  const db = admin();
  await db.from("gtm_team_mail_events").delete().eq("member", "TSYNC");
  await db.from("gtm_sync_state").delete().eq("key", stateKey("TSYNC", BOX));
  await db.from("gtm_team_mailboxes").delete().eq("member", "TSYNC");
  const r = { member: "TSYNC", address: BOX, token_ciphertext: sealToken("refresh", mailboxAad("TSYNC", BOX)), history_id: null as string | null, backfill_done: false, ...row };
  assert.equal((await db.from("gtm_team_mailboxes").insert(r)).error, null);
  return { ...r, last_sync_at: null as string | null };
}
const state = async () => (await admin().from("gtm_sync_state").select("value").eq("key", stateKey("TSYNC", BOX)).maybeSingle()).data?.value as Record<string, unknown> | undefined;
const box = async () => (await admin().from("gtm_team_mailboxes").select("history_id,backfill_done,last_error").eq("member", "TSYNC").single()).data!;
const events = async () => (await admin().from("gtm_team_mail_events").select("*").eq("member", "TSYNC").order("gmail_message_id")).data ?? [];

test("first backfill: outreach and its reply are counted without any address; the cursor and watermark are saved", async () => {
  const row = await fresh();
  mock = installFetchMock(base([
    { url: `${GM}messages?labelIds=SENT`, json: { messages: [{ id: "a1" }, { id: "b2" }, { id: "c3" }] } },
    { url: `${GM}messages/a1`, json: sent("a1", T0, "Ana <ana@prospect.test>") },
    { url: `${GM}messages/b2`, json: sent("b2", T0, "friend@personal.test") },
    { url: `${GM}messages/c3`, json: sent("c3", Date.parse("2026-09-20T10:00:00Z"), "ana@prospect.test") },
    { url: "https://crm.test/graphql", body: page("people", [ana]), times: 1 },
    { url: "https://crm.test/graphql", body: page("companies", []), times: 1 },
    { url: `${GM}threads/a10`, json: { id: "a10", messages: [sent("a1", T0, "ana@prospect.test"), { id: "d4", internalDate: String(T0 + 3_600_000), labelIds: ["INBOX"], payload: { headers: [{ name: "From", value: "ana@prospect.test" }] } }] } },
  ]));
  const r = await syncMailbox(admin(), member, row, new TwentyReader({ pauseMs: 0 }), { cfg, now: new Date("2026-11-04T00:00:00Z") });
  assert.equal(r.error, undefined, r.error ?? "");
  assert.deepEqual({ sends: r.sends, outreach: r.outreach, replies: r.replies, pending: r.pending }, { sends: 2, outreach: 1, replies: 1, pending: 0 });
  const ev = await events();
  assert.deepEqual(ev.map((e) => [e.gmail_message_id, e.kind]), [["a1", "outreach"], ["d4", "reply"]]);
  assert.deepEqual(ev[0].person_ids, ["p1"]);
  assert.deepEqual(ev[0].recipient_hashes, [addressHash("ana@prospect.test")]);
  assert.doesNotMatch(JSON.stringify(ev), /@/, "no address is stored");
  assert.deepEqual(await box(), { history_id: "900", backfill_done: true, last_error: null });
  const s = await state();
  assert.deepEqual(s?.pending, []); assert.ok(s?.okAt, "a full run sets the watermark");
});

test("a CRM failure saves no events and moves no cursor; the owner-readable error names no address", async () => {
  const row = await fresh();
  mock = installFetchMock(base([
    { url: `${GM}messages?labelIds=SENT`, json: { messages: [{ id: "a1" }] } },
    { url: `${GM}messages/a1`, json: sent("a1", T0, "ana@prospect.test") },
    { url: "https://crm.test/graphql", status: 200, json: { errors: [{ message: "ana@prospect.test is weird" }] } },
  ]));
  const r = await syncMailbox(admin(), member, row, new TwentyReader({ pauseMs: 0, retries: 0 }), { cfg });
  assert.match(r.error!, /CRM rejected/);
  assert.equal((await events()).length, 0);
  assert.equal(await state(), undefined, "no cursor was saved");
  const b = await box();
  assert.equal(b.backfill_done, false); assert.doesNotMatch(b.last_error!, /@/);
});

test("a deadline mid-run keeps the unread ids pending, and the next run finishes them", async () => {
  const row = await fresh();
  const routes = [
    { url: `${GM}messages?labelIds=SENT`, json: { messages: [{ id: "a1" }, { id: "b2" }, { id: "c3" }] } },
    { url: `${GM}messages/a1`, json: sent("a1", T0, "ana@prospect.test") },
    { url: `${GM}messages/b2`, json: sent("b2", T0 + 1, "ana@prospect.test") },
    { url: `${GM}messages/c3`, json: sent("c3", Date.parse("2026-09-01T00:00:00Z"), "x@else.test") },
    { url: "https://crm.test/graphql", body: page("people", [ana]) },
    { url: `${GM}threads/`, json: { id: "t", messages: [] } },
  ];
  mock = installFetchMock(base(routes));
  // The clock is asked once for the page, then once before each one-id chunk: the third question (b2) is past the deadline.
  let ticks = 0;
  const r1 = await syncMailbox(admin(), member, row, new TwentyReader({ pauseMs: 0 }), { cfg, deadline: 2, clock: () => ++ticks, chunk: 1, chunkReserveMs: 0 });
  assert.equal(r1.pending, 2); assert.equal(r1.complete, false);
  assert.deepEqual((await events()).map((e) => e.gmail_message_id), ["a1"]);
  assert.deepEqual((await state())?.pending, ["b2", "c3"]);
  // The listing finished, so the backfill is done: the pending ids are finished from `pending`, never by listing again.
  assert.equal((await box()).backfill_done, true);
  mock.restore();
  mock = installFetchMock(base([{ url: `${GM}history?startHistoryId=900`, json: { history: [], historyId: "901" } }, ...routes]));
  const r2 = await syncMailbox(admin(), member, { ...row, ...(await box()) }, new TwentyReader({ pauseMs: 0 }), { cfg });
  assert.ok(!mock.calls.some((c) => c.url.includes("labelIds=SENT")), "the second run does not list SENT again");
  assert.equal(r2.error, undefined, r2.error ?? "");
  assert.deepEqual((await events()).map((e) => e.gmail_message_id), ["a1", "b2"]);
  assert.deepEqual(await box(), { history_id: "901", backfill_done: true, last_error: null });
  assert.ok((await state())?.okAt, "caught up: the watermark is set");
});

test("a lookup that fails after earlier chunks keeps those chunks: progress is never undone", async () => {
  const row = await fresh();
  mock = installFetchMock(base([
    { url: `${GM}messages?labelIds=SENT`, json: { messages: [{ id: "a1" }, { id: "b2" }] } },
    { url: `${GM}messages/a1`, json: sent("a1", T0, "ana@prospect.test") },
    { url: `${GM}messages/b2`, json: sent("b2", T0 + 1, "bo@prospect.test") },
    { url: "https://crm.test/graphql", body: page("people", [ana]), times: 1 },
    { url: "https://crm.test/graphql", status: 503, json: {} },
  ]));
  const r = await syncMailbox(admin(), member, row, new TwentyReader({ pauseMs: 0, retries: 0 }), { cfg, chunk: 1 });
  assert.ok(r.error);
  assert.deepEqual((await events()).map((e) => e.gmail_message_id), ["a1"]);
  assert.deepEqual((await state())?.pending, ["b2"]);
});

test("history: a deleted message is skipped, not a failure; a too-old cursor lists again from the last good run", async () => {
  const row = await fresh({ history_id: "500", backfill_done: true });
  await admin().from("gtm_sync_state").insert({ key: stateKey("TSYNC", BOX), value: { pending: [], okAt: "2026-11-01T00:00:00Z" } });
  mock = installFetchMock(base([
    { url: `${GM}history?startHistoryId=500`, json: { history: [{ messagesAdded: [{ message: { id: "e5", labelIds: ["SENT"] } }, { message: { id: "f6", labelIds: ["SENT"] } }] }], historyId: "950" } },
    { url: `${GM}messages/e5`, status: 404, json: {} },
    { url: `${GM}messages/f6`, json: sent("f6", T0, "ana@prospect.test") },
    { url: "https://crm.test/graphql", body: page("people", [ana]) },
    { url: `${GM}threads/`, json: { id: "t", messages: [] } },
  ]));
  const r = await syncMailbox(admin(), member, row, new TwentyReader({ pauseMs: 0 }), { cfg, now: new Date("2026-11-04T00:00:00Z") });
  assert.equal(r.error, undefined, r.error ?? "");
  assert.deepEqual((await events()).map((e) => e.gmail_message_id), ["f6"]);
  assert.equal((await box()).history_id, "950");

  mock.restore();
  mock = installFetchMock(base([{ url: `${GM}history?startHistoryId=950`, status: 404, json: {} }, { url: `${GM}threads/`, json: { id: "t", messages: [] } }]));
  const r2 = await syncMailbox(admin(), member, { ...row, history_id: "950" }, new TwentyReader({ pauseMs: 0 }), { cfg, now: new Date("2026-11-20T00:00:00Z") });
  assert.equal(r2.error, undefined, r2.error ?? "");
  const s = await state();
  assert.equal(s?.since, "2026-11-03T00:00:00.000Z", "a day before the last fully successful run, not the failed one");
  assert.equal((await box()).backfill_done, false);
});
