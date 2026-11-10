// Email suppression against the real LOCAL database (VIB-513, AC497-06/08): detection records operations once, reviews
// are never approvable, nothing is written without the flag and an approval, the writer reads back before confirming,
// and the desk refuses to record a held send. Twenty is mocked; synthetic data only.
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { admin, seed } from "../support/seed.ts";
import { local } from "../support/local-supabase.ts";
import { installFetchMock, type Route } from "../support/fetch-mock.ts";

const l = local();
Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: l.url, SUPABASE_SECRET_KEY: l.secretKey, TEAM_MAILBOX_KEY: randomBytes(32).toString("base64"), TWENTY_API_KEY: "twenty_test", TWENTY_BASE: "https://crm.test" });
const S = await import("../../lib/email/suppression.ts");
const { addressHash } = await import("../../lib/team/crypto.ts");
const { TwentyReader } = await import("../../lib/twenty.ts");

const DB: Route = { url: l.url, passthrough: true };
const P = "00000000-0000-4000-8000-0000000000d1";
let mock: ReturnType<typeof installFetchMock> | null = null;
afterEach(() => { mock?.restore(); mock = null; delete process.env.EMAIL_SUPPRESSION_APPLY; });
before(async () => { await seed(); });

async function fresh() {
  const db = admin();
  await db.from("gtm_email_sync_ops").delete().eq("person_id", P);
  await db.from("gtm_team_mail_events").delete().eq("member", "TSUPP");
  const e = (await db.from("gtm_team_mail_events").insert({ member: "TSUPP", gmail_message_id: "ab1", thread_id: "ab1", kind: "outreach", at: "2026-11-01T00:00:00Z", person_ids: [P], mailbox: "s@hq.test", calc_version: 2 }).select("id").single()).data!;
  assert.equal((await db.from("gtm_email_attempts").insert({ event_id: e.id, recipient_hash: addressHash("ana@prospect.test"), field: "to", match: "matched", person_id: P, stream: "cold",
    delivery: "failed_invalid_address", delivery_at: "2026-11-01T01:00:00Z" })).error, null);
  const r = (await db.from("gtm_team_mail_events").insert({ member: "TSUPP", gmail_message_id: "ab2", thread_id: "ab1", kind: "reply", at: "2026-11-02T00:00:00Z", person_ids: [P], recipient_hashes: [addressHash("ana@prospect.test")], mailbox: "s@hq.test", calc_version: 2 }).select("id").single()).data!;
  assert.equal((await db.from("gtm_email_reply_labels").insert({ event_id: r.id, person_id: P, source: "deterministic", intent: "uncertain", opt_out: "uncertain" })).error, null);
}
const ops = async () => (await admin().from("gtm_email_sync_ops").select("*").eq("person_id", P).order("id")).data as import("../../lib/email/suppression.ts").StoredOp[];

test("detection records each operation once: the bounce pending, Origami held, the possible opt-out a review", async () => {
  await fresh();
  await S.detect(admin()); await S.detect(admin());
  assert.deepEqual((await ops()).map((o) => [o.destination, o.action, o.reason, o.state]), [
    ["twenty", "address_restrict", "EMAIL_BOUNCED", "pending_review"], ["origami", "exclusion_upsert", "EMAIL_BOUNCED", "held"], ["twenty", "person_opt_out", "OPT_OUT_REVIEW", "pending_review"]]);
});

test("reviews are never approvable; the desk holds the address and the possible opt-out", async () => {
  await fresh(); await S.detect(admin());
  const all = await ops();
  assert.equal(await S.approve(admin(), all.map((o) => o.id), "dry run 2026-11-06 approved by test", new Date()), 1, "only the Twenty address restriction");
  assert.deepEqual((await ops()).map((o) => o.state), ["approved", "held", "pending_review"]);
  assert.deepEqual(await S.emailHolds(admin(), P, "Ana@Prospect.test"), ["a possible opt-out is waiting for review", "this address is restricted"]);
  assert.deepEqual(await S.emailHolds(admin(), "00000000-0000-4000-8000-0000000000d9", "other@prospect.test"), []);
});

test("without the flag nothing is written; with it the writer re-reads, writes the owned field and confirms on read-back", async () => {
  await fresh(); await S.detect(admin());
  await S.approve(admin(), (await ops()).map((o) => o.id), "dry run 2026-11-06 approved by test", new Date());
  mock = installFetchMock([DB]);
  assert.deepEqual(await S.applyTwenty(admin(), new TwentyReader({ pauseMs: 0 }), new Date()), { skipped: "EMAIL_SUPPRESSION_APPLY and ORIGAMI_OPTOUT_APPLY are not 1" });
  assert.equal(mock.calls.filter((c) => c.url.startsWith("https://crm.test")).length, 0);
  mock.restore();
  process.env.EMAIL_SUPPRESSION_APPLY = "1";
  const person = (r: unknown) => JSON.stringify({ data: { people: { pageInfo: { hasNextPage: false, endCursor: null }, edges: [{ node: { id: P, updatedAt: "2026-11-01T00:00:00.000Z", emails: { primaryEmail: "ana@prospect.test", additionalEmails: [] }, gtmMarketingConsent: "NONE", gtmConsentEvidence: null, gtmEmailRestrictions: r } }] } } });
  mock = installFetchMock([
    { url: "https://crm.test/graphql", body: person(null), times: 1 },
    { url: "https://crm.test/graphql", json: { data: { updatePeople: [{ id: P }] } }, times: 1 },
    { url: "https://crm.test/graphql", body: person({ version: 1, addresses: { "ana@prospect.test": { reason: "EMAIL_BOUNCED" } }, holds: [] }), times: 1 },
    DB,
  ]);
  const r = await S.applyTwenty(admin(), new TwentyReader({ pauseMs: 0 }), new Date());
  assert.deepEqual(r, { confirmed: 1, unchanged: 0, failed: 0, canceled: 0, lost: 0 });
  const write = mock.calls.find((c) => c.url.startsWith("https://crm.test") && /updatePeople/.test(c.body ?? ""))!;
  const vars = JSON.parse(write.body!).variables;
  assert.deepEqual(Object.keys(vars.d), ["gtmEmailRestrictions"], "only the owned field is written");
  assert.deepEqual(vars.f, { id: { eq: P }, updatedAt: { gte: "2026-11-01T00:00:00.000Z", lt: "2026-11-01T00:00:00.001Z" } }, "conditional on the version read");
  assert.equal((await ops())[0].state, "confirmed");
  assert.equal((await ops())[1].state, "held", "Origami is never touched");
});

const personBody = (r: unknown, updatedAt = "2026-11-01T00:00:00.000Z") => JSON.stringify({ data: { people: { pageInfo: { hasNextPage: false, endCursor: null }, edges: [{ node: { id: P, updatedAt, emails: { primaryEmail: "ana@prospect.test", additionalEmails: [] }, gtmMarketingConsent: "NONE", gtmConsentEvidence: null, gtmEmailRestrictions: r } }] } } });

test("a concurrent edit makes the conditional write match nothing: the op fails and retries, nothing is overwritten", async () => {
  await fresh(); await S.detect(admin());
  await S.approve(admin(), (await ops()).map((o) => o.id), "dry run 2026-11-06 approved by test", new Date());
  process.env.EMAIL_SUPPRESSION_APPLY = "1";
  mock = installFetchMock([{ url: "https://crm.test/graphql", body: personBody(null), times: 1 }, { url: "https://crm.test/graphql", json: { data: { updatePeople: [] } }, times: 1 }, DB]);
  assert.deepEqual(await S.applyTwenty(admin(), new TwentyReader({ pauseMs: 0 }), new Date()), { confirmed: 0, unchanged: 0, failed: 1, canceled: 0, lost: 0 });
  const [o] = await ops();
  assert.equal(o.state, "failed"); assert.match(o.last_error!, /changed while applying/);
});

test("an op left applied by a crash is confirmed by read-back on the next run, without writing again", async () => {
  await fresh(); await S.detect(admin());
  await S.approve(admin(), (await ops()).map((o) => o.id), "dry run 2026-11-06 approved by test", new Date());
  const id = (await ops())[0].id;
  await admin().from("gtm_email_sync_ops").update({ state: "applied", applied_at: new Date().toISOString() }).eq("id", id);
  process.env.EMAIL_SUPPRESSION_APPLY = "1";
  const done = personBody({ version: 1, addresses: { "ana@prospect.test": { reason: "EMAIL_BOUNCED" } }, holds: [] });
  mock = installFetchMock([{ url: "https://crm.test/graphql", body: done }, DB]);
  assert.deepEqual(await S.applyTwenty(admin(), new TwentyReader({ pauseMs: 0 }), new Date()), { confirmed: 0, unchanged: 1, failed: 0, canceled: 0, lost: 0 });
  assert.ok(!mock.calls.some((c) => /updatePeople/.test(c.body ?? "")));
  assert.equal((await ops())[0].state, "confirmed");
});

test("a corrected decision cancels its pending review; a CRM-only hold or opt-out still holds the desk; an unreadable CRM fails closed", async () => {
  await fresh(); await S.detect(admin());
  const db = admin();
  await db.from("gtm_email_reply_labels").update({ superseded_at: new Date().toISOString() }).eq("person_id", P).eq("source", "deterministic");
  await S.detect(db);
  assert.equal((await ops()).find((o) => o.reason === "OPT_OUT_REVIEW")!.state, "canceled");
  await db.from("gtm_email_sync_ops").delete().eq("person_id", P);
  await db.from("gtm_email_attempts").update({ delivery: "no_failure_observed", delivery_at: null }).eq("person_id", P);
  mock = installFetchMock([{ url: "https://crm.test/graphql", body: personBody({ version: 1, addresses: {}, holds: [{ reason: "OPT_OUT_REVIEW" }] }), times: 1 },
    { url: "https://crm.test/graphql", status: 500, json: {} }, DB]);
  const reader = new TwentyReader({ pauseMs: 0, retries: 0 });
  assert.deepEqual(await S.emailHolds(db, P, "ana@prospect.test", reader), ["email is on hold in the CRM"]);
  assert.deepEqual(await S.emailHolds(db, P, "ana@prospect.test", reader), ["the CRM could not be checked for email restrictions; try again"]);
});

test("evidence corrected after approval cancels the operation at apply time: no CRM call (review of #33, finding 2)", async () => {
  await fresh(); await S.detect(admin());
  await S.approve(admin(), (await ops()).map((o) => o.id), "dry run 2026-11-06 approved by test", new Date());
  await admin().from("gtm_email_attempts").update({ delivery: "no_failure_observed", delivery_at: null }).eq("person_id", P);
  process.env.EMAIL_SUPPRESSION_APPLY = "1";
  mock = installFetchMock([DB]);
  assert.deepEqual(await S.applyTwenty(admin(), new TwentyReader({ pauseMs: 0 }), new Date()), { confirmed: 0, unchanged: 0, failed: 0, canceled: 1, lost: 0 });
  assert.equal(mock.calls.filter((c) => c.url.startsWith("https://crm.test")).length, 0);
  assert.equal((await ops())[0].state, "canceled");
});

test("a possible opt-out renewed after a correction is a new review that holds the desk again (finding 3)", async () => {
  await fresh(); await S.detect(admin());
  const db = admin();
  const [first] = (await db.from("gtm_email_reply_labels").select("id,event_id").eq("person_id", P).eq("source", "deterministic")).data!;
  await db.from("gtm_email_reply_labels").update({ superseded_at: new Date().toISOString() }).eq("id", first.id);
  await S.detect(db);
  assert.equal((await ops()).filter((o) => o.reason === "OPT_OUT_REVIEW" && o.state === "pending_review").length, 0, "the corrected review is canceled");
  assert.equal((await db.from("gtm_email_reply_labels").insert({ event_id: first.event_id, person_id: P, source: "human", labeled_by: "reviewer@team.test", intent: "uncertain", opt_out: "uncertain" })).error, null);
  await S.detect(db);
  const reviews = (await ops()).filter((o) => o.reason === "OPT_OUT_REVIEW");
  assert.deepEqual(reviews.map((o) => o.state).sort(), ["canceled", "pending_review"]);
  assert.ok((await S.emailHolds(db, P, null)).includes("a possible opt-out is waiting for review"));
});
