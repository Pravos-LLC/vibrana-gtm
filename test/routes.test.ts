// API route handlers called directly (no server): cron auth and the Zernio webhook signature gate.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { installFetchMock, type Route } from "./support/fetch-mock.ts";

Object.assign(process.env, {
  NEXT_PUBLIC_SUPABASE_URL: "https://db.test", SUPABASE_SECRET_KEY: "sb_secret_test",
  ZERNIO_API_URL: "https://zernio.test/api/v1", ZERNIO_API_KEY: "zk_test",
  TWENTY_BASE: "https://twenty.test", TWENTY_API_KEY: "tw_test",
});
const cron = await import("../app/api/cron/sync/route.ts");
const webhook = await import("../app/api/webhooks/zernio/route.ts");

const REST = "https://db.test/rest/v1/";
const Z = "https://zernio.test/api/v1";
let mock: ReturnType<typeof installFetchMock> | null = null;
const use = (routes: Route[]) => (mock = installFetchMock(routes));
afterEach(() => { mock?.restore(); mock = null; delete process.env.CRON_SECRET; delete process.env.ZERNIO_WEBHOOK_SECRET; });

const cronReq = (auth?: string) => new Request("https://cockpit.test/api/cron/sync", { headers: auth === undefined ? {} : { authorization: auth } });
const SYNC_OK: Route[] = [
  {method:"GET",url:REST+"gtm_piece_deliveries",json:[]},{method:"GET",url:REST+"gtm_piece_delivery_attempts",json:[]},
  {method:"GET",url:REST+"gtm_piece_reviews",json:[]},
  { method: "GET", url: REST + "gtm_sync_state?select=value&key=eq.pieces.killed", json: [] },
  { method: "GET", url: REST + "gtm_content_items", json: [] },
  { method: "GET", url: REST + "gtm_seasons", json: [] },
  { method: "GET", url: REST + "gtm_story_assets", json: [] },
  { method: "GET", url: REST + "gtm_stories", json: [] },
  { method: "GET", url: REST + "gtm_story_feedback", json: [] },
  { url: `${Z}/accounts`, json: { accounts: [], hasAnalyticsAccess: false } },
  { method: "POST", url: REST + "gtm_channel_daily", status: 201 },
  { method: "GET", url: REST + "gtm_channel_daily", json: [] },
  { url: `${Z}/analytics`, status: 403, body: "no analytics" },
  { url: "https://twenty.test/graphql", json: { data: { people: { totalCount: 0 }, companies: { totalCount: 0 }, messages: { totalCount: 0 }, opportunities: { edges: [] } } } },
  { method: "POST", url: REST + "gtm_crm_snapshots", status: 201 },
  { method: "GET", url: REST + "gtm_people", json: [] },
];

test("cron: 401 when CRON_SECRET is unset, even for 'Bearer undefined' and an empty bearer", async () => {
  const m = use(SYNC_OK);
  for (const auth of [undefined, "Bearer undefined", "Bearer ", ""]) {
    const res = await cron.GET(cronReq(auth));
    assert.equal(res.status, 401, String(auth));
    assert.deepEqual(await res.json(), { error: "unauthorized" });
  }
  assert.equal(m.calls.length, 0, "no sync work without auth");
});

test("cron: 401 for a wrong, differently sized, or non-Bearer secret", async () => {
  process.env.CRON_SECRET = "s3cret-value";
  const m = use(SYNC_OK);
  for (const auth of ["Bearer s3cret-valuf", "Bearer s3cret", "bearer s3cret-value", "s3cret-value", "Bearer s3crét-value"]) {
    assert.equal((await cron.GET(cronReq(auth))).status, 401, auth);
  }
  assert.equal(m.calls.length, 0);
});

test("cron: the right secret runs auto-schedule, status, channels, reach, stats, crm and playbook tags; 200 when every part succeeds", async () => {
  process.env.CRON_SECRET = "s3cret-value";
  const m = use(SYNC_OK);
  const res = await cron.GET(cronReq("Bearer s3cret-value"));
  const out = await res.json();
  assert.equal(res.status, 200, JSON.stringify(out));
  assert.deepEqual(Object.keys(out), ["autoschedule", "status", "channels", "reach", "stats", "crm", "playbook", "people"]);
  assert.deepEqual(out.autoschedule, { dryRun: false, scheduled: [], skipped: [], failed: [], held: [], notFinal: [] }, "nothing approved, held or short of final in the mock: nothing to schedule");
  assert.equal(out.playbook.selected, 0, "nothing approved or published in the mock: no model call, no key needed");
  assert.match(out.stats.skipped, /analytics not enabled/);
  assert.deepEqual(out.people, { tried: 0, resolved: 0, left: 0, stopped: "" }, "nobody untagged in the mock: no LinkedIn lookup");
  assert.ok(m.calls.some((c) => c.url.startsWith("https://twenty.test/")));
});

test("cron: 500 with every part's result when one part fails", async () => {
  process.env.CRON_SECRET = "s3cret-value";
  use([{ url: "https://twenty.test/graphql", status: 502, json: { errors: [{ message: "down" }] } }, ...SYNC_OK]);
  const res = await cron.GET(cronReq("Bearer s3cret-value"));
  assert.equal(res.status, 500);
  const out = await res.json();
  assert.match(out.crm.error, /down/);
  assert.deepEqual(out.channels, { accounts: 0, hasAnalyticsAccess: false });
});

test("cron: a playbook tagging failure is logged and reported, never a failed sync (review finding 6)", async () => {
  process.env.CRON_SECRET = "s3cret-value";
  // The tagger's read (it selects body and playbook_tags) fails; the status sync's read of the same table succeeds.
  use([{ method: "GET", url: REST + "gtm_content_items\\?select=id%2Ctitle", regex: true, status: 500, json: { message: "db down" } }, ...SYNC_OK]);
  const errors: string[] = [];
  const orig = console.error;
  console.error = (m: string) => { errors.push(String(m)); };
  try {
    const res = await cron.GET(cronReq("Bearer s3cret-value"));
    const out = await res.json();
    assert.equal(res.status, 200, JSON.stringify(out));
    assert.match(out.playbook.nonfatal_error, /db down/);
    assert.ok(errors.some((e) => /sync playbook: .*db down/.test(e)));
  } finally { console.error = orig; }
});

test("cron: without OPENROUTER_API_KEY, due rows are skipped cleanly with a reason", async () => {
  process.env.CRON_SECRET = "s3cret-value";
  delete process.env.OPENROUTER_API_KEY;
  const due = { id: "p1", title: "P", pillar: "proof", format: "text", channels: ["linkedin"], status: "published", body: "Copy." };
  use([{ method: "GET", url: REST + "gtm_content_items\\?select=id%2Ctitle", regex: true, json: [due] }, ...SYNC_OK]);
  const res = await cron.GET(cronReq("Bearer s3cret-value"));
  const out = await res.json();
  assert.equal(res.status, 200, JSON.stringify(out));
  assert.match(out.playbook.skipped, /OPENROUTER_API_KEY is not set; 1 item left untagged/);
});

const SECRET = "whsec_test";
const sign = (body: string, secret = SECRET) => createHmac("sha256", secret).update(body).digest("hex");
const hook = (body: string, headers: Record<string, string>) => webhook.POST(new Request("https://cockpit.test/api/webhooks/zernio", { method: "POST", body, headers }));
const EVENTS: Route[] = [{ method: "POST", url: REST + "gtm_zernio_events", status: 201 }];

test("webhook: accepts a correct signature in lower- or upper-case hex and stores the event under its id", async () => {
  process.env.ZERNIO_WEBHOOK_SECRET = SECRET;
  const m = use(EVENTS);
  const body = JSON.stringify({ account: { id: "a1" } });
  for (const sig of [sign(body), sign(body).toUpperCase(), ` ${sign(body)} `]) {
    const res = await hook(body, { "x-zernio-signature": sig, "x-zernio-event": "account.connected", "x-zernio-event-id": "evt-1" });
    assert.equal(res.status, 200, sig);
    assert.deepEqual(await res.json(), { ok: true });
  }
  assert.equal(m.calls.length, 3);
  for (const c of m.calls) {
    assert.match(c.headers.prefer, /resolution=merge-duplicates/, "a duplicate event id is an upsert, not a second row");
    assert.deepEqual(JSON.parse(c.body!), { event_id: "evt-1", event: "account.connected", payload: { account: { id: "a1" } } });
  }
});

test("webhook: the legacy x-late-signature header is still honoured", async () => {
  process.env.ZERNIO_WEBHOOK_SECRET = SECRET;
  use(EVENTS);
  const body = "{}";
  assert.equal((await hook(body, { "x-late-signature": sign(body), "x-zernio-event": "account.connected" })).status, 200);
});

test("webhook: without an event id the dedupe key is derived from the body", async () => {
  process.env.ZERNIO_WEBHOOK_SECRET = SECRET;
  const m = use(EVENTS);
  const body = JSON.stringify({ n: 1 });
  await hook(body, { "x-zernio-signature": sign(body), "x-zernio-event": "account.connected" });
  await hook(body, { "x-zernio-signature": sign(body), "x-zernio-event": "account.connected" });
  const [a, b] = m.calls.map((c) => JSON.parse(c.body!).event_id);
  assert.equal(a, createHmac("sha256", "id").update(body).digest("hex"));
  assert.equal(a, b);
});

test("webhook: 401 for a bad, truncated, missing or multibyte signature; nothing stored", async () => {
  process.env.ZERNIO_WEBHOOK_SECRET = SECRET;
  const m = use(EVENTS);
  const body = JSON.stringify({ ok: 1 });
  const good = sign(body);
  const bad: Record<string, string>[] = [
    { "x-zernio-signature": sign(body, "other-secret") },
    { "x-zernio-signature": good.slice(0, 62) },
    { "x-zernio-signature": good + "00" },
    { "x-zernio-signature": sign(body + " ") },
    { "x-zernio-signature": "ÿ".repeat(64) }, // Latin-1 bytes a header can carry; never valid hex
    { "x-zernio-signature": "z".repeat(64) },
    {},
  ];
  for (const headers of bad) {
    const res = await hook(body, headers);
    assert.equal(res.status, 401, JSON.stringify(headers));
    assert.deepEqual(await res.json(), { error: "bad signature" });
  }
  assert.equal(m.calls.length, 0);
});

test("webhook: 401 when the secret is unset, even for a body signed with an empty key", async () => {
  const m = use(EVENTS);
  const body = "{}";
  assert.equal((await hook(body, { "x-zernio-signature": sign(body, "") })).status, 401);
  assert.equal(m.calls.length, 0);
});

test("webhook: a correctly signed non-JSON body is a 400, not stored", async () => {
  process.env.ZERNIO_WEBHOOK_SECRET = SECRET;
  const m = use(EVENTS);
  const body = "not json {";
  const res = await hook(body, { "x-zernio-signature": sign(body) });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "body is not JSON" });
  assert.equal(m.calls.length, 0);
});

test("webhook: a database error is a 500 so Zernio retries", async () => {
  process.env.ZERNIO_WEBHOOK_SECRET = SECRET;
  use([{ method: "POST", url: REST + "gtm_zernio_events", status: 500, json: { message: "db down" } }]);
  const body = "{}";
  const res = await hook(body, { "x-zernio-signature": sign(body), "x-zernio-event": "account.connected" });
  assert.equal(res.status, 500);
});
