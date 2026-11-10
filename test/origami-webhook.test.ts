// The Origami webhook (VIB-521): Standard Webhooks signatures, the reply payload, and the route's gates (dormant without
// the secret, 401 on a bad signature, a repeated webhook-id acknowledged without work, nothing done with the flag off).
// The database and Origami are mocks; synthetic ids only.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { installFetchMock, type Route } from "./support/fetch-mock.ts";

Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: "https://db.test", SUPABASE_SECRET_KEY: "sb_secret_test" });
const { replyEvidence, sign, verifySignature } = await import("../lib/origami/webhook.ts");
const route = await import("../app/api/webhooks/origami/route.ts");

const SECRET = `whsec_${Buffer.from("origami-test-secret-32-bytes!!!!").toString("base64")}`;
const OTHER = `whsec_${Buffer.from("another-secret-of-32-bytes-long!").toString("base64")}`;
const REST = "https://db.test/rest/v1/";
const SEQ = "00000000-0000-4000-8000-00000000a001", CAMP = "00000000-0000-4000-8000-00000000c001";
let mock: ReturnType<typeof installFetchMock> | null = null;
afterEach(() => { mock?.restore(); mock = null; delete process.env.ORIGAMI_WEBHOOK_SECRET; delete process.env.ORIGAMI_OPTOUT_APPLY; });

const reply = (body = "no") => JSON.stringify({ type: "sequence.reply.received", id: "evt", timestamp: "2026-11-10T10:00:00Z", data: {
  channel: "email", sequence_id: SEQ, campaign_id: CAMP, newly_stopped: true,
  outreach_target: { table_id: null, row_id: null, column_id: null, email: "ana@prospect.test", linkedin_urn: null, linkedin_slug: null },
  sender: { id: null, email: "s@hq.test", linkedin_slug: null, display_name: "S" },
  reply_message: { subject: "Re: hi", body, body_truncated: false, received_at: "2026-11-10T09:59:58.123Z", thread_id: "t", provider_id: "p" } } });
const now = () => String(Math.floor(Date.now() / 1000));
const headers = (id: string, body: string, secret = SECRET, ts = now()) => ({ "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": sign(id, ts, body, secret) });
const post = (body: string, h: Record<string, string>) => route.POST(new Request("https://cockpit.test/api/webhooks/origami", { method: "POST", body, headers: h }));

test("signature: the Standard Webhooks scheme, any of several entries, within five minutes, nothing tampered", () => {
  const body = reply(), ts = now(), id = "msg_1";
  const h = { id, timestamp: ts, signature: sign(id, ts, body, SECRET) };
  assert.equal(verifySignature(h, body, SECRET), true);
  assert.equal(verifySignature({ ...h, signature: `${sign(id, ts, body, OTHER)} ${h.signature}` }, body, SECRET), true, "a rotation sends two signatures");
  assert.equal(verifySignature(h, body.replace("no", "ok"), SECRET), false, "a changed body");
  assert.equal(verifySignature({ ...h, id: "msg_2" }, body, SECRET), false, "a changed id");
  assert.equal(verifySignature(h, body, OTHER), false, "another secret");
  assert.equal(verifySignature({ ...h, signature: h.signature.replace("v1,", "v2,") }, body, SECRET), false, "an unknown version");
  const old = String(Number(ts) - 301);
  assert.equal(verifySignature({ id, timestamp: old, signature: sign(id, old, body, SECRET) }, body, SECRET), false, "older than five minutes");
  assert.equal(verifySignature({ ...h, signature: null }, body, SECRET), false);
});

test("the reply payload becomes in-memory evidence; anything else is not evidence", () => {
  const e = replyEvidence(JSON.parse(reply("No thanks")))!;
  assert.deepEqual({ ...e, body: undefined }, { kind: "reply", source: "webhook", sequence_id: SEQ, campaign_id: CAMP, channel: "email", received_at: "2026-11-10T09:59:58.123Z",
    origami_reply_id: null, body: undefined, email: "ana@prospect.test", linkedin_slug: null });
  assert.equal(e.body, "No thanks");
  assert.equal(replyEvidence({ type: "sequence.message.sent", data: {} }), null);
  assert.equal(replyEvidence({ type: "sequence.reply.received", data: { sequence_id: "x" } }), null);
});

test("route: dormant (503) without the secret; 401 on a bad signature; nothing is read or written for either", async () => {
  mock = installFetchMock([]);
  assert.equal((await post(reply(), headers("msg_1", reply()))).status, 503);
  process.env.ORIGAMI_WEBHOOK_SECRET = SECRET;
  assert.equal((await post(reply(), headers("msg_1", reply(), OTHER))).status, 401);
  assert.equal((await post(reply(), {})).status, 401);
  assert.equal(mock.calls.length, 0);
});

test("route: a delivery is recorded by webhook-id; a repeat is acknowledged as a duplicate; with the flag off nothing else happens", async () => {
  process.env.ORIGAMI_WEBHOOK_SECRET = SECRET;
  const first: Route = { method: "POST", url: REST + "gtm_origami_webhook_deliveries", status: 201, json: [{ webhook_id: "msg_1" }], times: 1 };
  const again: Route = { method: "POST", url: REST + "gtm_origami_webhook_deliveries", status: 201, json: [] };
  mock = installFetchMock([first, again]);
  const body = reply();
  const r1 = await post(body, headers("msg_1", body));
  assert.equal(r1.status, 200);
  assert.deepEqual(await r1.json(), { ok: true, applied: false });
  const r2 = await post(body, headers("msg_1", body));
  assert.deepEqual(await r2.json(), { ok: true, duplicate: true });
  assert.equal(mock.calls.length, 2, "only the delivery record: no Origami, no Twenty, no evidence");
  assert.match(mock.calls[0].headers.prefer, /ignore-duplicates/);
  assert.deepEqual(JSON.parse(mock.calls[0].body!), { webhook_id: "msg_1", event: "sequence.reply.received" });
});

test("route: an event that is not a reply is acknowledged and ignored; a delivery that cannot be recorded is retried (500)", async () => {
  process.env.ORIGAMI_WEBHOOK_SECRET = SECRET;
  process.env.ORIGAMI_OPTOUT_APPLY = "1";
  mock = installFetchMock([{ method: "POST", url: REST + "gtm_origami_webhook_deliveries", status: 201, json: [{ webhook_id: "t" }], times: 1 },
    { method: "POST", url: REST + "gtm_origami_webhook_deliveries", status: 500, json: { message: "down" } }]);
  const test = JSON.stringify({ type: "webhook.test", id: "e", timestamp: "2026-11-10T10:00:00Z", data: {} });
  assert.deepEqual(await (await post(test, headers("t", test))).json(), { ok: true, ignored: "webhook.test" });
  assert.equal((await post(test, headers("u", test))).status, 500);
});
