// lib/sync, lib/zernio, lib/twenty, lib/wise and lib/costs against a mocked fetch: no live service is reachable.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installFetchMock, type Route } from "./support/fetch-mock.ts";

Object.assign(process.env, {
  NEXT_PUBLIC_SUPABASE_URL: "https://db.test", SUPABASE_SECRET_KEY: "sb_secret_test",
  ZERNIO_API_URL: "https://zernio.test/api/v1", ZERNIO_API_KEY: "zk_test",
  TWENTY_BASE: "https://twenty.test", TWENTY_API_KEY: "tw_test",
  WISE_API_TOKEN: "wise_test", WISE_PROFILE_ID: "42",
});
const { pushItems, syncStatus, syncStats, syncChannels, syncCrm } = await import("../lib/sync.ts");
const { zernio, ZernioError, getPost, listAnalytics } = await import("../lib/zernio.ts");
const { crmSnapshot, FUNNEL_STEPS } = await import("../lib/twenty.ts");
const { statement } = await import("../lib/wise.ts");
const { classify, loadRegistry, spendRows } = await import("../lib/costs.ts");
import type { Item } from "../lib/calendar.ts";

const REST = "https://db.test/rest/v1/";
const Z = "https://zernio.test/api/v1";
let mock: ReturnType<typeof installFetchMock> | null = null;
const use = (routes: Route[]) => (mock = installFetchMock([...routes,{method:"GET",url:REST+"gtm_piece_deliveries",json:[]},{method:"GET",url:REST+"gtm_piece_delivery_attempts",json:[]}]));
afterEach(() => { mock?.restore(); mock = null; });
const json = (b: string | null) => JSON.parse(b ?? "null");
const item = (id: string, extra: Partial<Item> = {}): Item => ({ id, week: 1, date: "2026-10-06", pillar: "p", title: id, format: "text", channels: ["linkedin"], status: "approved", ...extra });

test("pushItems refuses to wipe the cockpit mirror on an empty calendar: zero requests", async () => {
  const m = use([]);
  assert.deepEqual(await pushItems([]), { upserted: 0, removed: 0, skipped: "calendar has no items" });
  assert.equal(m.calls.length, 0);
});

test("pushItems upserts every item, then deletes only rows no longer in the calendar", async () => {
  const m = use([
    { method: "POST", url: REST + "gtm_content_items", status: 201 },
    { method: "GET", url: REST + "gtm_content_items", json: [{ id: "a" }, { id: "gone-1" }, { id: "b" }, { id: "gone-2" }] },
    { method: "DELETE", url: REST + "gtm_content_items", status: 204 },
  ]);
  const r = await pushItems([item("a", { story_id: "orion" }), item("b", { zernio_post_id: "p1" })]);
  assert.deepEqual(r, { upserted: 2, removed: 2 });
  const [up, , del] = m.calls.filter((c) => c.url.includes("gtm_content_items"));
  assert.match(up.headers.prefer, /resolution=merge-duplicates/);
  const rows = json(up.body);
  assert.deepEqual(rows.map((x: any) => [x.id, x.story_id, x.zernio_post_id, x.time, x.link]), [["a", "orion", null, null, null], ["b", undefined, "p1", null, null]]);
  assert.equal(new URL(del.url).searchParams.get("id"), "in.(gone-1,gone-2)");
  assert.equal(m.calls[0].headers.apikey, "sb_secret_test");
});

test("pushItems with an explicit allowEmpty clears the mirror", async () => {
  const m = use([
    { method: "POST", url: REST + "gtm_content_items", status: 201 },
    { method: "GET", url: REST + "gtm_content_items", json: [{ id: "x" }] },
    { method: "DELETE", url: REST + "gtm_content_items", status: 204 },
  ]);
  assert.deepEqual(await pushItems([], { allowEmpty: true }), { upserted: 0, removed: 1 });
  assert.equal(m.calls.filter((c) => c.url.includes("gtm_content_items")).length, 3);
});

test("syncStatus maps Zernio status: pending reconciled, published/partial/failed, 404 becomes failed and unlinked", async () => {
  const m = use([
    { method: "GET", url: REST + "gtm_content_items", json: [
      { id: "pend", zernio_post_id: "pending", status: "scheduled" },
      { id: "pub", zernio_post_id: "p-pub", status: "scheduled" },
      { id: "part", zernio_post_id: "p-part", status: "scheduled" },
      { id: "fail", zernio_post_id: "p-fail", status: "scheduled" },
      { id: "wait", zernio_post_id: "p-wait", status: "scheduled" },
      { id: "gone", zernio_post_id: "p-gone", status: "scheduled" },
    ] },
    {method:"GET",url:`${Z}/posts?`,json:{posts:[],pagination:{pages:1}}},
    { method: "GET", url: `${Z}/posts/p-pub`, json: { post: { _id: "p-pub", status: "published", platforms: [
      { platform: "linkedin", accountId: "a", platformPostUrl: "https://li/1", publishedAt: "2026-10-06T07:00:00Z" },
      { platform: "youtube", accountId: "b", platformPostUrl: "https://yt/1", publishedAt: "2026-10-06T06:30:00Z" },
    ] } } },
    { method: "GET", url: `${Z}/posts/p-part`, json: { _id: "p-part", status: "partial", platforms: [] } },
    { method: "GET", url: `${Z}/posts/p-fail`, json: { _id: "p-fail", status: "failed", platforms: [] } },
    { method: "GET", url: `${Z}/posts/p-wait`, json: { _id: "p-wait", status: "scheduled", platforms: [] } },
    { method: "GET", url: `${Z}/posts/p-gone`, status: 404, json: { error: "not found" } },
    { method: "PATCH", url: REST + "gtm_content_items", status: 204 },
  ]);
  const patches = await syncStatus();
  assert.deepEqual(patches, [
    { id: "pub", status: "published", urls: { linkedin: "https://li/1", youtube: "https://yt/1" }, published_at: "2026-10-06T06:30:00Z" },
    { id: "part", status: "failed", urls: {} },
    { id: "fail", status: "failed", urls: {} },
    { id: "gone", status: "failed", zernio_post_id: null },
  ]);
  assert.ok(!m.calls.some((c) => c.url.includes("/posts/pending")), "pending marker is never looked up");
  const patched = m.calls.filter((c) => c.method === "PATCH");
  assert.deepEqual(patched.map((c) => new URL(c.url).searchParams.get("id")), ["eq.pub", "eq.part", "eq.fail", "eq.gone"]);
  const gone = json(patched[3].body);
  assert.equal(gone.zernio_post_id, null);
  assert.equal(gone.status, "failed");
  const q = new URL(m.calls.find(c=>c.url.startsWith(REST+"gtm_content_items"))!.url).searchParams;
  assert.equal(q.get("zernio_post_id"), "not.is.null");
  assert.equal(q.get("status"), null, "approved interrupted attempts are also reconciled");
  assert.equal(q.get("or"), "(status.in.(scheduled,failed),zernio_post_id.eq.pending)", "published rows are final and not read again");
});

test("a published post deleted at Zernio later is history: no error, no patch, the run carries on (review #151 N5)", async () => {
  const m = use([
    { method: "GET", url: REST + "gtm_content_items", json: [{ id: "old", zernio_post_id: "p-old", status: "published" }, { id: "next", zernio_post_id: "p-next", status: "scheduled" }] },
    { method: "GET", url: `${Z}/posts/p-old`, status: 404, json: { error: "not found" } },
    { method: "GET", url: `${Z}/posts/p-next`, json: { _id: "p-next", status: "published", platforms: [] } },
    { method: "PATCH", url: REST + "gtm_content_items", status: 204 },
  ]);
  const patches = await syncStatus();
  assert.deepEqual(patches.map((p) => p.id), ["next"]);
  assert.ok(!m.calls.some((c) => c.method === "PATCH" && c.url.includes("eq.old")));
});

test("calendar import leaves rows owned by a shared delivery untouched: not upserted, not deleted", async () => {
  mock = installFetchMock([
    { method: "GET", url: REST + "gtm_piece_deliveries", json: [{ id: "d1", calendar_id: "frozen" }] },
    { method: "POST", url: REST + "gtm_content_items", status: 201 },
    { method: "GET", url: REST + "gtm_content_items", json: [{ id: "a" }, { id: "frozen" }, { id: "frozen-gone" }] },
    { method: "DELETE", url: REST + "gtm_content_items", status: 204 },
  ]);
  mock.calls.length = 0;
  const r = await pushItems([item("a"), item("frozen", { status: "drafted" })]);
  assert.deepEqual(r, { upserted: 1, removed: 1, frozen: ["frozen"] });
  const up = mock.calls.find((c) => c.method === "POST")!;
  assert.deepEqual(json(up.body).map((x: { id: string }) => x.id), ["a"]);
});

test("syncStatus reports a failed provider read after checking later rows",async()=>{
 const m=use([
  {method:"GET",url:REST+"gtm_content_items",json:[{id:"x",zernio_post_id:"p1",status:"scheduled"},{id:"later",zernio_post_id:"p2",status:"failed"}]},
  {method:"GET",url:`${Z}/posts/p1`,status:500,body:"unavailable"},
  {method:"GET",url:`${Z}/posts/p2`,json:{_id:"p2",status:"scheduled",platforms:[]}},
  {method:"PATCH",url:REST+"gtm_content_items",status:204},
 ]);
 await assert.rejects(syncStatus(),/unavailable for x/);
 const patch=m.calls.find(c=>c.method==="PATCH");assert.equal(JSON.parse(patch?.body??"{}").status,"scheduled","provider retry is no longer displayed failed");
});

test("zernio client: bearer auth, query encoding, retries 429 with retry-after, then surfaces the error", async () => {
  const m = use([
    { url: `${Z}/posts/x`, status: 429, headers: { "retry-after": "0" }, times: 3 },
    { url: `${Z}/posts/x`, status: 429, headers: { "retry-after": "0" } },
  ]);
  await assert.rejects(getPost("x"), (e: any) => e.status === 429);
  assert.equal(m.calls.length, 4);
  assert.equal(m.calls[0].headers.authorization, "Bearer zk_test");
  mock!.restore();
  const m2 = use([{ url: `${Z}/analytics`, json: { posts: [], pagination: { pages: 1 } } }]);
  await zernio("/analytics", { query: { a: "1 2", skip: undefined } });
  assert.equal(new URL(m2.calls[0].url).search, "?a=1+2");
});

test("listAnalytics pages until pagination says stop", async () => {
  const m = use([
    { url: `${Z}/analytics`, regex: false, times: 1, json: { posts: [{ _id: "1" }], pagination: { pages: 2 } } },
    { url: `${Z}/analytics`, json: { posts: [{ _id: "2" }], pagination: { pages: 2 } } },
  ]);
  const posts = await listAnalytics("2026-01-01", "2026-02-01");
  assert.deepEqual(posts.map((p) => p._id), ["1", "2"]);
  assert.deepEqual(m.calls.map((c) => new URL(c.url).searchParams.get("page")), ["1", "2"]);
  assert.equal(new URL(m.calls[0].url).searchParams.get("source"), "all");
});

test("syncStats skips (not fails) when the plan has no analytics access", async () => {
  const m = use([{ url: `${Z}/analytics`, status: 402, body: "upgrade" }]);
  assert.deepEqual(await syncStats(7), { skipped: "Zernio analytics not enabled on this plan (upgrade to usage-based)", rows: 0 });
  assert.equal(m.calls.filter((c) => c.url.startsWith(REST)).length, 0);
});

test("syncStats snapshots one row per platform and links posts to calendar items", async () => {
  const m = use([
    { url: `${Z}/analytics`, json: { posts: [
      { _id: "p1", status: "published", content: "x".repeat(400), platforms: [
        { platform: "linkedin", accountId: "a", analytics: { impressions: 10, likes: 2 } },
        { platform: "youtube", accountId: "b", analytics: null },
      ] },
      { _id: "ext", status: "published", isExternal: true, platform: "instagram", analytics: { views: 5, engagementRate: 1.5 } },
    ] } },
    { method: "GET", url: REST + "gtm_content_items", json: [{ id: "item-1", zernio_post_id: "p1" }, { id: "item-2", zernio_post_id: null }] },
    { method: "POST", url: REST + "gtm_post_metrics", status: 201 },
  ]);
  assert.deepEqual(await syncStats(7), { posts: 2, rows: 3 });
  const rows = json(m.calls.at(-1)!.body);
  assert.deepEqual(rows.map((r: any) => [r.zernio_post_id, r.platform, r.content_item_id, r.is_external, r.impressions, r.views, r.engagement_rate]), [
    ["p1", "linkedin", "item-1", false, 10, 0, null], ["p1", "youtube", "item-1", false, 0, 0, null], ["ext", "instagram", null, true, 0, 5, 1.5],
  ]);
  assert.equal(rows[0].content_preview.length, 280);
});

test("syncChannels marks accounts needing reconnection inactive and upserts on (account_id, date)", async () => {
  const m = use([
    { url: `${Z}/accounts`, json: { hasAnalyticsAccess: true, accounts: [
      { _id: "a", platform: "linkedin", username: "john", isActive: true, followersCount: 10 },
      { _id: "b", platform: "youtube", displayName: "Vibrana", isActive: true, needsReconnection: true },
    ] } },
    { method: "POST", url: REST + "gtm_channel_daily", status: 201 },
  ]);
  assert.deepEqual(await syncChannels(), { accounts: 2, hasAnalyticsAccess: true });
  const up = m.calls[1];
  assert.equal(new URL(up.url).searchParams.get("on_conflict"), "account_id,date");
  assert.deepEqual(json(up.body).map((r: any) => [r.account_id, r.username, r.followers, r.active]), [["a", "john", 10, true], ["b", "Vibrana", null, false]]);
});

test("Twenty: one root resolver per request, every funnel step counted, errors surface", async () => {
  let n = 0;
  // Answer by resolver name, asserting each request carries exactly one root field.
  const calls: string[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    assert.equal(String(url), "https://twenty.test/graphql");
    assert.equal((init.headers as Record<string, string>).Authorization, "Bearer tw_test");
    const q = JSON.parse(String(init.body)).query as string;
    calls.push(q);
    assert.equal((q.match(/\b(people|companies|messages|opportunities)\b/g) ?? []).length, 1, `one root per request: ${q}`);
    n++;
    const data = q.includes("people") ? { people: { totalCount: n } } : q.includes("companies") ? { companies: { totalCount: 7 } }
      : q.includes("messages") ? { messages: { totalCount: 0 } } : { opportunities: { edges: [{ node: { stage: "SIGNED" } }, { node: { stage: "LOST" } }, { node: { stage: "SIGNED" } }] } };
    return new Response(JSON.stringify({ data }), { status: 200 });
  }) as typeof fetch;
  try {
    const snap = await crmSnapshot();
    assert.deepEqual(Object.keys(snap.metrics), [...FUNNEL_STEPS.map((s) => s.key), "companies", "email_messages_synced"]);
    assert.equal(snap.metrics.companies, 7);
    assert.deepEqual(snap.opportunities, { SIGNED: 2, LOST: 1 });
    assert.ok(calls.some((q) => q.includes("{enrStatus:{eq:ENRICHED}}")));
  } finally { globalThis.fetch = orig; }
  use([{ url: "https://twenty.test/graphql", json: { errors: [{ message: "Duplicate root resolver" }] } }]);
  await assert.rejects(crmSnapshot(), /Twenty: .*Duplicate root resolver/);
});

test("syncCrm upserts today's snapshot", async () => {
  const m = use([
    { url: "https://twenty.test/graphql", json: { data: { people: { totalCount: 1 }, companies: { totalCount: 1 }, messages: { totalCount: 1 }, opportunities: { edges: [] } } } },
    { method: "POST", url: REST + "gtm_crm_snapshots", status: 201 },
  ]);
  await syncCrm();
  const row = json(m.calls.at(-1)!.body);
  assert.equal(row.date, new Date().toISOString().slice(0, 10));
  assert.equal(row.metrics.people, 1);
});

test("Wise statement answers the SCA challenge with a signature from the local private key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gtm-wise-"));
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  writeFileSync(join(dir, "private.pem"), privateKey.export({ type: "pkcs8", format: "pem" }));
  process.env.WISE_PRIVATE_KEY_PATH = join(dir, "private.pem");
  const W = "https://api.wise.com";
  try {
    const m = use([
      { url: `${W}/v4/profiles/42/balances`, json: [{ id: 1, amount: { currency: "EUR" } }, { id: 2, currency: "USD" }] },
      { url: `${W}/v1/profiles/42/balance-statements/1/`, times: 1, status: 403, headers: { "x-2fa-approval": "challenge-1" } },
      { url: `${W}/v1/profiles/42/balance-statements/1/`, json: { transactions: [
        { referenceNumber: "CARD-1", date: "2026-09-01T10:00:00Z", amount: { value: -20 }, type: "DEBIT", details: { type: "CARD", description: "Card", merchant: { name: "Cursor", category: "Computer Software Stores" } } },
      ] } },
      { url: `${W}/v1/profiles/42/balance-statements/2/`, json: { transactions: [] } },
    ]);
    const txns = await statement("2026-09-01", "2026-09-30");
    assert.deepEqual(txns, [{ id: "CARD-1", date: "2026-09-01", currency: "EUR", amount: -20, description: "Card", merchant: "Cursor", merchantCategory: "Computer Software Stores", type: "CARD" }]);
    const signed = m.calls[2];
    assert.equal(signed.headers["x-2fa-approval"], "challenge-1");
    assert.ok(createVerify("SHA256").update("challenge-1").verify(publicKey, signed.headers["x-signature"], "base64"), "signature verifies");
    assert.equal(m.calls[1].headers["x-signature"], undefined);
    assert.ok(m.calls.every((c) => c.method === "GET"), "Wise client is read-only");
    const q = new URL(m.calls[1].url).searchParams;
    assert.deepEqual([q.get("intervalStart"), q.get("intervalEnd"), q.get("type")], ["2026-09-01T00:00:00.000Z", "2026-09-30T23:59:59.999Z", "COMPACT"]);
  } finally { rmSync(dir, { recursive: true, force: true }); delete process.env.WISE_PRIVATE_KEY_PATH; }
});

test("spendRows keeps only outgoing card charges, converts to EUR and keys by id+currency", async () => {
  const m = use([{ url: "https://api.wise.com/v1/rates?source=USD&target=EUR", json: [{ rate: 0.5 }] }]);
  const rows = await spendRows([
    { id: "CARD-1", date: "2026-09-01", currency: "USD", amount: -20, description: "x", merchant: "Anthropic", merchantCategory: "Computer Software Stores", type: "CARD" },
    { id: "CARD-2", date: "2026-09-02", currency: "EUR", amount: -9.99, description: "x", merchant: "Pizza Place", merchantCategory: "Eating Places", type: "CARD" },
    { id: "CARD-3", date: "2026-09-03", currency: "EUR", amount: 5, description: "refund", merchant: "Anthropic", merchantCategory: null, type: "CARD" },
    { id: "TRANSFER-4", date: "2026-09-04", currency: "EUR", amount: -500, description: "x", merchant: "Anthropic", merchantCategory: null, type: "TRANSFER" },
    { id: "CARD-5", date: "2026-09-05", currency: "EUR", amount: -12.345, description: "New Tool Inc", merchant: null, merchantCategory: "Business Services", type: "CARD" },
  ]);
  assert.deepEqual(rows, [
    { id: "CARD-1:USD", date: "2026-09-01", currency: "USD", amount: 20, amount_eur: 10, merchant: "Anthropic", vendor: "Claude (Anthropic)", category: "ai-models", gtm: false },
    { id: "CARD-5:EUR", date: "2026-09-05", currency: "EUR", amount: 12.345, amount_eur: 12.35, merchant: "New Tool Inc", vendor: null, category: "unclassified", gtm: false },
  ]);
  assert.equal(m.calls.length, 1, "EUR needs no rate lookup");
});

test("vendor patterns are anchored where the registry anchors them", () => {
  const reg = loadRegistry();
  const sw = "Computer Software Stores";
  assert.equal(classify(reg, "Motion Inc", sw)?.vendor, "Motion");
  assert.equal(classify(reg, "Promotion Motion Ltd", sw)?.vendor, null);
  assert.equal(classify(reg, "Mosaic Ai Labs", sw)?.vendor, "Mosaic");
  assert.equal(classify(reg, "Kaleidomosaic", sw)?.vendor, null);
  assert.equal(classify(reg, "Stregato Software", sw)?.vendor, null);
  assert.equal(classify(reg, "Fal Ai Inc", sw)?.vendor, "fal.ai");
  assert.equal(classify(reg, "Falcon Tools", sw)?.vendor, null);
  assert.equal(classify(reg, "Anomaly", sw)?.vendor, "Opencode");
  assert.equal(classify(reg, "Anomaly Labs", sw)?.vendor, null);
  assert.equal(classify(reg, "Late.dev", "Business Services")?.vendor, "Zernio");
  // The category gate runs before any name pattern.
  assert.equal(classify(reg, "Cursor", "Hotels, Motels, and Resorts"), null);
});
