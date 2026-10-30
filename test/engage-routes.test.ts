// Engage routes (VIB-423), called directly: the LinkedIn intake endpoint's CRON_SECRET gate and storage,
// the engage cron's gate, and the webhook-side ingest of a comment.received event.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { installFetchMock, type Route } from "./support/fetch-mock.ts";

Object.assign(process.env, {
  NEXT_PUBLIC_SUPABASE_URL: "https://db.test", SUPABASE_SECRET_KEY: "sb_secret_test",
  ZERNIO_API_URL: "https://zernio.test/api/v1", ZERNIO_API_KEY: "zk_test",
});
const intake = await import("../app/api/engage/intake/route.ts");
const cron = await import("../app/api/cron/engage/route.ts");
const { ingestEngageEvent } = await import("../lib/engage/ingest.ts");

const REST = "https://db.test/rest/v1/";
let mock: ReturnType<typeof installFetchMock> | null = null;
const use = (routes: Route[]) => (mock = installFetchMock(routes));
afterEach(() => { mock?.restore(); mock = null; delete process.env.CRON_SECRET; });

const post = (body: unknown, auth?: string) => intake.POST(new Request("https://cockpit.test/api/engage/intake", {
  method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: auth ? { authorization: auth } : {},
}));

test("intake: 401 without the right CRON_SECRET, nothing touched", async () => {
  const m = use([]);
  assert.equal((await post({ comments: [] })).status, 401, "secret unset");
  process.env.CRON_SECRET = "s3cret";
  for (const auth of [undefined, "Bearer wrong", "s3cret", "Bearer undefined"]) assert.equal((await post({ comments: [] }, auth)).status, 401, String(auth));
  assert.equal(m.calls.length, 0);
});

test("intake: 400 for a malformed body", async () => {
  process.env.CRON_SECRET = "s3cret";
  use([]);
  assert.equal((await post("not json", "Bearer s3cret")).status, 400);
  assert.equal((await post({ nope: 1 }, "Bearer s3cret")).status, 400);
});

test("intake: stores new LinkedIn comments once, skipping one Zernio already delivered with the same text", async () => {
  process.env.CRON_SECRET = "s3cret";
  const m = use([
    { method: "POST", url: REST + "gtm_comment_runs", json: { id: "run-1" } },
    { method: "GET", url: REST + "gtm_comments", json: [{ author_name: "Sam Okafor", text: "Which team went first?" }] },
    { method: "POST", url: REST + "gtm_comments", json: [{ id: "new-1" }] },
    { method: "PATCH", url: REST + "gtm_comment_runs", json: [] },
  ]);
  const res = await post({ comments: [
    { gmail_id: "g1", author_name: "Jordan Rivera", text: "How did you handle reviewers?", comment_urn: "urn:li:comment:(urn:li:activity:1,2)" },
    { gmail_id: "g2", author_name: "Sam Okafor", text: "Which  team went first? " },
  ] }, "Bearer s3cret");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { received: 2, inserted: 1, duplicates: 1 });
  const insert = m.calls.find((c) => c.method === "POST" && c.url.startsWith(REST + "gtm_comments"))!;
  assert.match(insert.headers.prefer, /resolution=ignore-duplicates/);
  assert.match(insert.url, /on_conflict=platform%2Ckind%2Cexternal_id/);
  const rows = JSON.parse(insert.body!);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].source, rows[0].platform, rows[0].external_id, rows[0].author_name], ["email", "linkedin", "urn:li:comment:(urn:li:activity:1,2)", "Jordan Rivera"]);
});

test("engage cron: 401 without the secret", async () => {
  const m = use([]);
  process.env.CRON_SECRET = "s3cret";
  assert.equal((await cron.GET(new Request("https://cockpit.test/api/cron/engage", { headers: { authorization: "Bearer nope" } }))).status, 401);
  assert.equal(m.calls.length, 0);
});

test("webhook ingest: a comment.received event is upserted without overwriting a stored decision", async () => {
  const m = use([
    { method: "GET", url: REST + "gtm_comments", json: [] },
    { method: "GET", url: REST + "gtm_content_items", json: [{ id: "item-1", zernio_post_id: "c755b8c9b81299f43625c9f4" }] },
    { method: "POST", url: REST + "gtm_comments", json: [{ id: "c-1" }] },
  ]);
  await ingestEngageEvent("comment.received", {
    comment: { id: "179", postId: "c755b8c9b81299f43625c9f4", platformPostId: "18", platform: "instagram", text: "How?", createdAt: "2026-10-10T09:00:00Z", isReply: false, parentCommentId: null, author: { id: "u", username: "reader" } },
    post: { id: "c755b8c9b81299f43625c9f4", platformPostId: "18", content: "Post", permalink: "https://www.instagram.com/p/X/" },
    account: { id: "acc", platform: "instagram", username: "sample_author" },
  });
  const insert = m.calls.find((c) => c.method === "POST")!;
  assert.match(insert.headers.prefer, /resolution=ignore-duplicates/, "a re-delivered comment keeps its status and draft");
  const [row] = JSON.parse(insert.body!);
  assert.equal(row.content_item_id, "item-1", "joined to the calendar item by Zernio post id");
  assert.equal(row.status, "new");
});

test("webhook ingest: our own comment is caught by the account handle even without isOwnAccount (M2)", async () => {
  const { resetOwnCache } = await import("../lib/engage/own.ts");
  resetOwnCache();
  const m = use([
    { method: "GET", url: "https://zernio.test/api/v1/accounts", json: { accounts: [{ _id: "acc", platform: "instagram", username: "sample_author", displayName: "Sample Author", isActive: true }] } },
    { method: "GET", url: REST + "gtm_comments", json: [] },
    { method: "GET", url: REST + "gtm_content_items", json: [] },
    { method: "POST", url: REST + "gtm_comments", json: [] },
    { method: "PATCH", url: REST + "gtm_comments", json: [{ id: "old" }] },
  ]);
  // Neither isOwnAccount nor account.username: only the /accounts handle can tell it is John.
  await ingestEngageEvent("comment.received", {
    comment: { id: "echo-1", postId: null, platformPostId: "18", platform: "instagram", text: "Ops went first.", isReply: true, parentCommentId: "c1", author: { id: "me", username: "sample_author" } },
    post: { id: null, platformPostId: "18", content: null, permalink: null },
    account: { id: "acc", platform: "instagram" },
  });
  const [row] = JSON.parse(m.calls.find((c) => c.method === "POST")!.body!);
  assert.equal(row.is_own, true);
  assert.equal(row.status, "skipped");
  const patch = m.calls.filter((c) => c.method === "PATCH").map((c) => decodeURIComponent(c.url));
  assert.ok(patch.some((u) => /external_id=in\.\(echo-1\)/.test(u) && /status=in\.\(new,drafted,failed\)/.test(u)), "a row stored earlier as new (or failed) leaves the queue");
  resetOwnCache();
});

test("webhook ingest: the echo of a reply we are sending (no reply id yet) is ours (M2)", async () => {
  const { resetOwnCache } = await import("../lib/engage/own.ts");
  resetOwnCache();
  const m = use([
    { method: "GET", url: "https://zernio.test/api/v1/accounts", json: { accounts: [] } },
    { method: "GET", url: REST + "gtm_comments?select=reply_external_id", json: [] },
    { method: "GET", url: REST + "gtm_comments?select=external_id", json: [{ external_id: "c1", parent_external_id: null, author_id: "reader" }] },
    { method: "GET", url: REST + "gtm_content_items", json: [] },
    { method: "POST", url: REST + "gtm_comments", json: [] },
    { method: "PATCH", url: REST + "gtm_comments", json: [] },
  ]);
  await ingestEngageEvent("comment.received", {
    comment: { id: "echo-2", platformPostId: "18", platform: "instagram", text: "We counted finishers.", isReply: true, parentCommentId: "c1", author: { id: "x" } },
    post: { platformPostId: "18" }, account: { id: "acc", platform: "instagram" },
  });
  const [row] = JSON.parse(m.calls.find((c) => c.method === "POST")!.body!);
  assert.equal(row.is_own, true);
  const lookup = new URL(m.calls.find((c) => c.url.includes("select=external_id"))!.url).searchParams.get("final_text");
  assert.equal(lookup, "eq.We counted finishers.");
  resetOwnCache();
});

test("intake dedupe: the same short comment on two different posts is two comments (L4)", async () => {
  process.env.CRON_SECRET = "s3cret";
  const m = use([
    { method: "POST", url: REST + "gtm_comment_runs", json: { id: "run-1" } },
    { method: "GET", url: REST + "gtm_comments", json: [{ author_name: "Sam Okafor", text: "Agreed", platform_post_id: "urn:li:activity:1" }] },
    { method: "POST", url: REST + "gtm_comments", json: [{ id: "n" }] },
    { method: "PATCH", url: REST + "gtm_comment_runs", json: [] },
  ]);
  await post({ comments: [
    { gmail_id: "g1", author_name: "Sam Okafor", text: "Agreed", activity_urn: "urn:li:activity:2" },
    { gmail_id: "g2", author_name: "Sam Okafor", text: "Agreed", activity_urn: "urn:li:activity:1" },
  ] }, "Bearer s3cret");
  const rows = JSON.parse(m.calls.find((c) => c.method === "POST" && c.url.startsWith(REST + "gtm_comments?"))!.body!);
  assert.deepEqual(rows.map((r: { platform_post_id: string }) => r.platform_post_id), ["urn:li:activity:2"]);
});
