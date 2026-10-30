// lib/sync and the webhook route against the real LOCAL database; Zernio stays mocked.
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { admin, seed } from "../support/seed.ts";
import { local } from "../support/local-supabase.ts";
import { installFetchMock, type Route } from "../support/fetch-mock.ts";
import type { Item } from "../../lib/calendar.ts";

const l = local();
Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: l.url, SUPABASE_SECRET_KEY: l.secretKey, ZERNIO_API_URL: "https://zernio.test/api/v1", ZERNIO_API_KEY: "zk_test", ZERNIO_WEBHOOK_SECRET: "whsec_local" });
const { pushItems, syncStatus } = await import("../../lib/sync.ts");
const webhook = await import("../../app/api/webhooks/zernio/route.ts");
const DB: Route = { url: l.url, passthrough: true };
let mock: ReturnType<typeof installFetchMock> | null = null;
afterEach(() => { mock?.restore(); mock = null; });
before(seed);

const item = (id: string, extra: Partial<Item> = {}): Item => ({ id, week: 1, date: "2026-10-06", pillar: "proof", title: id, format: "text", channels: ["linkedin"], status: "approved", ...extra });

test("webhook: a replayed event id is stored once (upsert on the primary key)", async () => {
  mock = installFetchMock([DB]);
  const body = JSON.stringify({ post: { id: "p" } });
  const sig = createHmac("sha256", "whsec_local").update(body).digest("hex");
  for (let i = 0; i < 3; i++) {
    const res = await webhook.POST(new Request("http://x/api/webhooks/zernio", { method: "POST", body, headers: { "x-zernio-signature": sig, "x-zernio-event": "account.updated", "x-zernio-event-id": "dup-evt" } }));
    assert.equal(res.status, 200);
  }
  const { count } = await admin().from("gtm_zernio_events").select("*", { count: "exact", head: true }).eq("event_id", "dup-evt");
  assert.equal(count, 1);
});

test("pushItems mirrors the calendar into the real table and removes rows deleted from it", async () => {
  mock = installFetchMock([DB]);
  const db = admin();
  assert.deepEqual(await pushItems([]), { upserted: 0, removed: 0, skipped: "calendar has no items" });
  assert.ok(((await db.from("gtm_content_items").select("id")).data ?? []).length >= 5, "empty calendar wiped nothing");
  const r = await pushItems([item("fx-published", { status: "published" }), item("new-one")]);
  assert.equal(r.upserted, 2);
  assert.deepEqual(((await db.from("gtm_content_items").select("id").order("id")).data ?? []).map((x) => x.id), ["fx-published", "new-one"]);
  assert.equal(r.removed, 4);
});

test("syncStatus writes Zernio outcomes to the real table: published with URLs, 404 failed and unlinked", async () => {
  const db = admin();
  mock = installFetchMock([DB]);
  await db.from("gtm_content_items").upsert([
    { ...item("s-pub", { status: "scheduled" }), zernio_post_id: "zp-pub", urls: {} },
    { ...item("s-gone", { status: "scheduled" }), zernio_post_id: "zp-gone", urls: {} },
    { ...item("s-pend", { status: "scheduled" }), zernio_post_id: "pending", urls: {} },
  ]);
  mock.restore();
  mock = installFetchMock([
    { url: "https://zernio.test/api/v1/posts/zp-pub", json: { post: { _id: "zp-pub", status: "published", platforms: [{ platform: "linkedin", accountId: "a", platformPostUrl: "https://li/x", publishedAt: "2026-10-06T06:30:00.000Z" }] } } },
    { url: "https://zernio.test/api/v1/posts/zp-gone", status: 404, body: "" },
    { url:"https://zernio.test/api/v1/posts?",json:{posts:[{_id:"recovered-pending",status:"scheduled",platforms:[],metadata:{calendarId:"s-pend"}}],pagination:{pages:1}} },
    DB,
  ]);
  await syncStatus();
  const rows = Object.fromEntries(((await db.from("gtm_content_items").select("id,status,zernio_post_id,urls,published_at").in("id", ["s-pub", "s-gone", "s-pend"])).data ?? []).map((r) => [r.id, r]));
  assert.deepEqual([rows["s-pub"].status, rows["s-pub"].urls, rows["s-pub"].published_at], ["published", { linkedin: "https://li/x" }, "2026-10-06T06:30:00+00:00"]);
  assert.deepEqual([rows["s-gone"].status, rows["s-gone"].zernio_post_id], ["failed", null]);
  assert.deepEqual([rows["s-pend"].status, rows["s-pend"].zernio_post_id], ["scheduled", "recovered-pending"]);
  assert.ok(!mock.calls.some((c) => c.url.includes("/posts/pending")));
});

test("syncStats twice on the same day leaves one snapshot per post and platform, holding the newer numbers (VIB-417)", async () => {
  const db = admin();
  const analytics = (likes: number): Route => ({ url: "https://zernio.test/api/v1/analytics", json: { posts: [
    { _id: "int-ext-1", status: "published", isExternal: true, content: "x", publishedAt: "2026-10-07T12:00:00Z", platforms: [
      { platform: "linkedin", accountId: "a", platformPostUrl: "https://li/int-1", analytics: { impressions: 100, likes, sends: 2 } },
      { platform: "instagram", accountId: "b", platformPostUrl: "https://ig/int-1", analytics: { reach: 50, likes: 1 } },
    ] },
  ] } });
  const { syncStats } = await import("../../lib/sync.ts");
  mock = installFetchMock([analytics(3), DB]);
  await syncStats(7);
  mock.restore();
  mock = installFetchMock([analytics(9), DB]);
  await syncStats(7);
  const rows = (await db.from("gtm_post_metrics").select("platform,likes,extras,captured_on").eq("zernio_post_id", "int-ext-1").order("platform")).data ?? [];
  assert.deepEqual(rows.map((r) => [r.platform, r.likes]), [["instagram", 1], ["linkedin", 9]], "two runs, one row each, newest numbers");
  assert.deepEqual(rows.find((r) => r.platform === "linkedin")!.extras, { sends: 2 });
  const latest = (await db.from("gtm_post_metrics_latest").select("likes,extras").eq("zernio_post_id", "int-ext-1").eq("platform", "linkedin").single()).data;
  assert.deepEqual(latest, { likes: 9, extras: { sends: 2 } });
});

test("two overlapping accepts of one report change apply it once; a swap moves both items in one call (review finding 3)", async () => {
  const db = admin();
  mock = installFetchMock([DB]);
  const { decideAction } = await import("../../lib/reports/actions.ts");
  const { FIXTURE_REPORT } = await import("../support/seed.ts");
  const later = new Date(Date.now() + 9 * 86400_000).toISOString().slice(0, 10);
  const { data: idea } = await db.from("gtm_report_actions").insert({ report_id: FIXTURE_REPORT, type: "new_story", change: { date: later, title: "Race test", pillar: "build", format: "text", channels: ["linkedin"] }, proposal: "Race" }).select("id").single();
  const results = await Promise.allSettled([decideAction(db, idea!.id, "accept", "a@test"), decideAction(db, idea!.id, "accept", "b@test")]);
  assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  const { count } = await db.from("gtm_content_items").select("id", { count: "exact", head: true }).like("id", "idea-race-test%");
  assert.equal(count, 1, "one idea slot, never two");

  // Own rows: earlier tests in this file rewrite the fixture calendar.
  const day = (n: number) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);
  await db.from("gtm_content_items").upsert([
    { ...item("fx-upcoming-idea", { status: "idea", date: day(5), time: "09:00" }), urls: {} },
    { ...item("fx-later", { status: "drafted", date: day(40), time: "08:30" }), urls: {} },
    { ...item("fx-published", { status: "published", date: day(-4) }), urls: {} },
  ]);
  const before = Object.fromEntries(((await db.from("gtm_content_items").select("id,date,time").in("id", ["fx-upcoming-idea", "fx-later"])).data ?? []).map((r) => [r.id, r]));
  const { data: swap } = await db.from("gtm_report_actions").insert({ report_id: FIXTURE_REPORT, type: "swap", item_id: "fx-upcoming-idea", other_item_id: "fx-later", proposal: "Swap" }).select("id").single();
  await decideAction(db, swap!.id, "accept", "a@test");
  const after = Object.fromEntries(((await db.from("gtm_content_items").select("id,date,time").in("id", ["fx-upcoming-idea", "fx-later"])).data ?? []).map((r) => [r.id, r]));
  assert.deepEqual([after["fx-upcoming-idea"].date, after["fx-later"].date], [before["fx-later"].date, before["fx-upcoming-idea"].date]);

  // A swap with a published item fails as a whole: the action is released and nothing moved.
  const { data: bad } = await db.from("gtm_report_actions").insert({ report_id: FIXTURE_REPORT, type: "swap", item_id: "fx-upcoming-idea", other_item_id: "fx-published", proposal: "Bad swap" }).select("id").single();
  await assert.rejects(decideAction(db, bad!.id, "accept", "a@test"), /published/);
  assert.equal((await db.from("gtm_report_actions").select("status").eq("id", bad!.id).single()).data!.status, "proposed");
  assert.equal((await db.from("gtm_content_items").select("date").eq("id", "fx-upcoming-idea").single()).data!.date, after["fx-upcoming-idea"].date);
});

const engageRow = (external_id: string, extra: Record<string, unknown> = {}) => ({
  kind: "comment", source: "poll", platform: "instagram", account_id: "acc", platform_post_id: "fx-post", external_id,
  parent_external_id: null, author_id: "reader", author_username: "reader", text: "Which team?", status: "new", ...extra,
});

test("engage repair (R1): a failed card John answered on the platform is skipped, so a retry cannot double-post", async () => {
  mock = installFetchMock([DB]);
  const db = admin();
  const store = await import("../../lib/engage/store.ts");
  const parse = await import("../../lib/engage/parse.ts");
  await db.from("gtm_comments").delete().like("external_id", "r1-%");
  const ins = await db.from("gtm_comments").insert([
    engageRow("r1-failed", { status: "failed", final_text: "Ops went first.", error: "zernio 500" }),
    engageRow("r1-sent", { status: "sent", final_text: "Ops.", sent_at: new Date().toISOString() }),
  ]);
  assert.equal(ins.error, null);
  const polled = parse.parsePolledComments({ id: "fx-post", platform: "instagram", accountId: "acc", accountUsername: "sample_author", commentCount: 2 }, [
    { id: "r1-failed", message: "Which team?", from: { username: "reader" }, replies: [{ id: "r1-own", message: "Ops, from the app.", from: { username: "sample_author" } }] },
    { id: "r1-sent", message: "Which team?", from: { username: "reader" }, replies: [{ id: "r1-own2", message: "Ops.", from: { username: "sample_author" } }] },
  ]);
  assert.deepEqual(await store.repairFromPoll(db, polled), { own: 0, answered: 1 });
  const rows = Object.fromEntries(((await db.from("gtm_comments").select("external_id,status,note").like("external_id", "r1-%")).data ?? []).map((r) => [r.external_id, r]));
  assert.deepEqual([rows["r1-failed"].status, rows["r1-failed"].note], ["skipped", parse.ANSWERED]);
  assert.equal(rows["r1-sent"].status, "sent", "a decision John already made is left alone");
  await db.from("gtm_comments").delete().like("external_id", "r1-%");
});

test("engage echo (R2): a stranger's identical short reply in another thread is queued, our echo is not", async () => {
  mock = installFetchMock([DB]);
  const db = admin();
  const store = await import("../../lib/engage/store.ts");
  await db.from("gtm_comments").delete().like("external_id", "r2-%");
  const ins = await db.from("gtm_comments").insert([
    engageRow("r2-answered", { author_id: "u1", status: "sent", final_text: "Agreed.", sent_at: new Date().toISOString() }),
    engageRow("r2-other", { author_id: "u3" }),
  ]);
  assert.equal(ins.error, null);
  const echo = { platform: "instagram", text: "Agreed.", parent_external_id: "r2-answered", author_id: "ours" };
  assert.equal(await store.isOurRecentReply(db, echo), true, "our reply echoed under the comment we answered");
  assert.equal(await store.isOurRecentReply(db, { ...echo, parent_external_id: "r2-other", author_id: "u4" }), false, "same words in another thread");
  assert.equal(await store.isOurRecentReply(db, { ...echo, author_id: "u1" }), false, "the person we answered, same words");
  assert.equal(await store.isOurRecentReply(db, { ...echo, parent_external_id: null }), false, "a top-level comment");
  await db.from("gtm_comments").delete().like("external_id", "r2-%");
});

test("red flags (VIB-424) against the real database: the seeded pile-on is backlash, and the alert goes out once a day", async () => {
  mock = installFetchMock([DB]);
  const { redFlags } = await import("../../lib/engage/redflags.ts");
  const { claimAlert } = await import("../../lib/engage/alerts.ts");
  const flags = await redFlags(admin(), new Date(Date.now() - 7 * 86400_000), new Date(Date.now() + 60_000));
  const ig = flags.find((f) => f.post_key === "instagram|ig-post-1")!;
  assert.equal(ig.flag, "backlash");
  assert.equal(ig.counts.troll_or_bad_faith, 2);
  assert.equal(ig.action, "hide_and_report");
  const first = await claimAlert(admin(), ig, { via: "webhook" });
  const second = await claimAlert(admin(), ig, { via: "webhook" });
  assert.ok(first);
  assert.equal(second, null, "one alert per post per 24 h");
  const { count } = await admin().from("gtm_red_flag_alerts").select("*", { count: "exact", head: true }).eq("post_key", "instagram|ig-post-1");
  assert.equal(count, 1);
  // The seeded alert for another post is 30 h old: outside the cooldown, so that post could alert again.
  const other = { ...ig, post_key: "linkedin|urn:li:activity:fixture" };
  assert.ok(await claimAlert(admin(), other, { via: "daily" }));
});

test("red flag claim RPC (VIB-424 M1): ten concurrent claims for one post, exactly one wins", async () => {
  mock = installFetchMock([DB]);
  const key = `instagram|race-${Date.now()}`;
  const results = await Promise.all(Array.from({ length: 10 }, () => admin().rpc("gtm_claim_red_flag_alert", { p_post_key: key, p_flag: "backlash", p_cooldown_hours: 24, p_stats: { via: "webhook" } } as never)));
  for (const r of results) assert.equal(r.error, null, String(r.error?.message));
  assert.equal(results.filter((r) => r.data).length, 1);
  const { count } = await admin().from("gtm_red_flag_alerts").select("*", { count: "exact", head: true }).eq("post_key", key);
  assert.equal(count, 1);
});
