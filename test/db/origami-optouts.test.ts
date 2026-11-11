// Origami opt-outs against the real LOCAL database (VIB-521): the webhook and the poll record one reply once, a confirmed
// opt-out becomes one Twenty operation per person and a stop for each of the person's live sequences in every campaign,
// an ambiguous match is never guessed, stops are idempotent and read back, and with the flag off nothing is written
// anywhere. Origami and Twenty are mocks; synthetic data only.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { admin, seed } from "../support/seed.ts";
import { local } from "../support/local-supabase.ts";
import { installFetchMock, type Route } from "../support/fetch-mock.ts";

const l = local();
Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: l.url, SUPABASE_SECRET_KEY: l.secretKey, TEAM_MAILBOX_KEY: randomBytes(32).toString("base64"), TWENTY_API_KEY: "twenty_test", TWENTY_BASE: "https://crm.test", ORIGAMI_API_KEY: "og_test" });
const O = await import("../../lib/origami/optouts.ts");
const S = await import("../../lib/email/suppression.ts");
const { OrigamiClient } = await import("../../lib/origami/client.ts");
const { replyEvidence } = await import("../../lib/origami/webhook.ts");
const { TwentyReader } = await import("../../lib/twenty.ts");

const DB: Route = { url: l.url, passthrough: true };
const B = "https://origami\\.chat/api/v3";
const P = "00000000-0000-4000-8000-0000000000e1", P2 = "00000000-0000-4000-8000-0000000000e2";
const C1 = "00000000-0000-4000-8000-00000000c101", C2 = "00000000-0000-4000-8000-00000000c102", C3 = "00000000-0000-4000-8000-00000000c103";
const A1 = "00000000-0000-4000-8000-00000000a101", A2 = "00000000-0000-4000-8000-00000000a102", A3 = "00000000-0000-4000-8000-00000000a103", A4 = "00000000-0000-4000-8000-00000000a104";
const R1 = "00000000-0000-4000-8000-00000000e101";
const T = "2026-11-10T09:59:58.123Z";
const ANA = "ana@prospect.test";

let mock: ReturnType<typeof installFetchMock> | null = null;
afterEach(() => { mock?.restore(); mock = null; delete process.env.ORIGAMI_OPTOUT_APPLY; delete process.env.EMAIL_SUPPRESSION_APPLY; });


const list = (items: unknown[]) => ({ object: "list", items, next_cursor: null });
const detail = (seq: string, email: string, status: string, stop_reason: string | null, steps: string[]) =>
  ({ object: "sequence", sequence_id: seq, status, stop_reason, identity: { email, linkedin_url: null }, steps: steps.map((s) => ({ status: s })), replies: [{ object: "reply", from: "lead", received_at: T, sequence_id: seq }] });
/** Three campaigns: Ana's reply (Origami already stopped that sequence), Ana live in a second campaign, and in the third a
 *  different person the fuzzy search also returns, plus Ana's old sequence Origami stopped by hand. */
const origami = (over: Route[] = []): Route[] => [
  ...over,
  { method: "GET", url: `^${B}/send/campaigns\\?`, regex: true, json: list([{ id: C1, status: "active" }, { id: C2, status: "draft" }, { id: C3, status: "paused" }]) },
  { method: "GET", url: `^${B}/send/campaigns/${C1}/people\\?`, regex: true, json: list([{ sequence_id: A1, status: "ongoing", stop_reason: null }]) },
  { method: "GET", url: `^${B}/send/campaigns/${C2}/people\\?`, regex: true, json: list([{ sequence_id: A2, status: "scheduled", stop_reason: null }]) },
  { method: "GET", url: `^${B}/send/campaigns/${C3}/people\\?`, regex: true, json: list([{ sequence_id: A3, status: "ongoing", stop_reason: null }, { sequence_id: A4, status: "stopped", stop_reason: "manual" }]) },
  { method: "GET", url: `^${B}/send/campaigns/${C1}/people/${A1}$`, regex: true, json: detail(A1, ANA, "replied", "replied", ["sent", "stopped"]) },
  { method: "GET", url: `^${B}/send/campaigns/${C2}/people/${A2}$`, regex: true, json: detail(A2, "Ana@Prospect.test", "scheduled", null, ["scheduled", "draft"]) },
  { method: "GET", url: `^${B}/send/campaigns/${C3}/people/${A3}$`, regex: true, json: detail(A3, "someone@else.test", "ongoing", null, ["sent", "scheduled"]) },
];
const twentyPeople = (...ids: string[]) => ({ url: "https://crm.test/graphql", json: { data: { people: { pageInfo: { hasNextPage: false, endCursor: null },
  edges: ids.map((id) => ({ node: { id, emails: { primaryEmail: ANA, additionalEmails: [] }, gtmMarketingConsent: "NONE", gtmRelationship: null, prospectReviewState: null, gtmQueue: null } })) } } } });
const client = () => new OrigamiClient({ key: "og_test", pauseMs: 0, retries: 0 });
const reader = () => new TwentyReader({ pauseMs: 0, retries: 0 });
const webhookEvidence = (body = "No thanks!") => replyEvidence({ type: "sequence.reply.received", data: { channel: "email", sequence_id: A1, campaign_id: C1, newly_stopped: true,
  outreach_target: { email: ANA, linkedin_slug: null }, reply_message: { body, received_at: T } } })!;
const pollEvidence = (body = "No thanks!") => ({ ...webhookEvidence(body), source: "poll" as const, origami_reply_id: R1, email: null });

// Decisions are append-only and their evidence cannot be deleted under them, so each test starts from a fresh seed.
const fresh = () => seed();
const evidence = async () => (await admin().from("gtm_origami_replies").select("*").in("sequence_id", [A1, A2, A3, A4]).order("id")).data as Record<string, unknown>[];
const ops = async () => (await admin().from("gtm_email_sync_ops").select("*").eq("policy_version", O.RULE_VERSION).order("op_key")).data as Record<string, unknown>[];
const origamiCalls = () => mock!.calls.filter((c) => c.url.startsWith("https://origami.chat"));

test("the webhook and the poll record the same reply once; replaying either changes nothing; no body is stored", async () => {
  await fresh();
  process.env.ORIGAMI_OPTOUT_APPLY = "1";
  mock = installFetchMock([...origami(), DB]);
  const first = await O.ingest(admin(), client(), [webhookEvidence()]);
  assert.deepEqual({ ...first, ids: first.ids.length }, { recorded: 1, duplicate: 0, failed: 0, deferred: 0, confirmed: 1, possible: 0, none: 0, ids: 1 });
  const again = await O.ingest(admin(), client(), [pollEvidence(), webhookEvidence()]);
  assert.deepEqual({ ...again, ids: again.ids }, { recorded: 0, duplicate: 2, failed: 0, deferred: 0, confirmed: 0, possible: 0, none: 0, ids: [first.ids[0], first.ids[0]] }, "both paths name the same evidence row");
  const rows = await evidence();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].origami_reply_id, R1, "the poll fills in the reply id the webhook does not carry");
  assert.deepEqual([rows[0].classification, rows[0].reason, rows[0].first_on_sequence, rows[0].match], ["confirmed", "exact_phrase", true, "pending"]);
  assert.match(String(rows[0].body_hash), /^[A-Za-z0-9_-]{32}$/);
  assert.doesNotMatch(JSON.stringify(rows), /No thanks|ana@|prospect/i, "no reply text and no address in the evidence");
  assert.equal(origamiCalls().filter((c) => c.method !== "GET").length, 0);
});

test("a confirmed opt-out: one Twenty operation for the person, a stop for each live sequence everywhere, nobody else's", async () => {
  await fresh();
  process.env.ORIGAMI_OPTOUT_APPLY = "1";
  mock = installFetchMock([...origami(), twentyPeople(P), DB]);
  await O.ingest(admin(), client(), [webhookEvidence()]);
  const r = await O.processPending(admin(), client(), reader(), new Date());
  assert.deepEqual({ ...r, labels: r.labels.length }, { processed: 1, failed: 0, deferred: 0, matched: 1, ambiguous: 0, unmatched: 0, stopsProposed: 1, labels: 1 });
  const [row] = await evidence();
  assert.deepEqual((await ops()).map((o) => [o.destination, o.action, o.op_key, o.reason, o.state]), [
    ["twenty", "person_opt_out", `person:${P}:optout:origami:${row.id}`, "UNSUBSCRIBED", "approved"],
    ["origami", "sequence_stop", `stop:${C2}:${A2}:${row.id}`, "UNSUBSCRIBED", "approved"],
  ], "A1 is already stopped by Origami, A3 is someone else, A4 was stopped by hand");
  assert.deepEqual([row.match, row.person_id, row.sequences_found], ["matched", P, 2], "A1 and A2 are hers; only A2 can still send");
  assert.match(String(row.recipient_hash), /^[A-Za-z0-9_-]{32}$/);
  const label = (await admin().from("gtm_email_reply_labels").select("source,opt_out,person_id").eq("origami_reply_id", row.id)).data!;
  assert.deepEqual(label, [{ source: "deterministic", opt_out: "person", person_id: null }], "the decision is recorded before the CRM match");
  assert.equal(origamiCalls().filter((c) => c.method !== "GET").length, 0, "processing only reads Origami");

  // Again, through both paths: nothing new. The email suppression detector neither copies nor cancels these operations.
  await O.ingest(admin(), client(), [pollEvidence(), webhookEvidence()]);
  assert.equal((await O.processPending(admin(), client(), reader(), new Date())).processed, 0);
  await S.detect(admin());
  assert.deepEqual((await ops()).map((o) => o.state), ["approved", "approved"]);
  assert.equal((await admin().from("gtm_email_sync_ops").select("id").eq("person_id", P).neq("policy_version", O.RULE_VERSION)).data!.length, 0);
  assert.deepEqual(await S.emailHolds(admin(), P, null), ["they opted out"], "the desk holds the person at once");
});

test("a possible opt-out opens a review hold and stops the sequences; no consent operation", async () => {
  await fresh();
  process.env.ORIGAMI_OPTOUT_APPLY = "1";
  mock = installFetchMock([...origami(), twentyPeople(P), DB]);
  await O.ingest(admin(), client(), [webhookEvidence("Not interested, we built our own.")]);
  await O.processPending(admin(), client(), reader(), new Date());
  const all = await ops();
  assert.deepEqual(all.map((o) => [o.destination, o.reason, o.state]), [["twenty", "OPT_OUT_REVIEW", "pending_review"], ["origami", "OPT_OUT_REVIEW", "approved"]]);
  assert.match(String(all[0].op_key), new RegExp(`^review:${P}:origami:\\d+$`));
  assert.deepEqual(await S.emailHolds(admin(), P, null), ["a possible opt-out is waiting for review"]);
  assert.equal(await S.approve(admin(), all.map((o) => o.id as number), "never approvable by test", new Date()), 0, "a review is never approvable");
});

test("several Twenty people with the address: never guessed; the sequences still stop; no Twenty operation", async () => {
  await fresh();
  process.env.ORIGAMI_OPTOUT_APPLY = "1";
  mock = installFetchMock([...origami(), twentyPeople(P, P2), DB]);
  await O.ingest(admin(), client(), [webhookEvidence("no")]);
  assert.equal((await O.processPending(admin(), client(), reader(), new Date())).ambiguous, 1);
  assert.deepEqual((await ops()).map((o) => [o.destination, o.person_id]), [["origami", null]]);
  assert.deepEqual([(await evidence())[0].match, (await evidence())[0].person_id], ["ambiguous", null]);
});

test("stops: a live sequence is stopped once and read back; an already stopped one is success without a write; a rerun writes nothing", async () => {
  await fresh();
  process.env.ORIGAMI_OPTOUT_APPLY = "1";
  const now = new Date().toISOString();
  const op = (c: string, s: string) => ({ op_key: `stop:${c}:${s}:1`, destination: "origami", action: "sequence_stop", reason: "UNSUBSCRIBED", policy_version: O.RULE_VERSION, observed_at: now,
    state: "approved", approved_at: now, approval_ref: O.APPROVAL_REF, origami_campaign_id: c, origami_sequence_id: s, evidence_ref: "test" });
  assert.equal((await admin().from("gtm_email_sync_ops").insert([op(C2, A2), op(C3, A4)])).error, null);
  mock = installFetchMock([
    { method: "GET", url: `^${B}/send/campaigns/${C2}/people/${A2}$`, regex: true, json: detail(A2, ANA, "scheduled", null, ["scheduled"]), times: 1 },
    { method: "POST", url: `^${B}/send/campaigns/${C2}/people/${A2}/stop$`, regex: true, json: { status: "stopped" } },
    { method: "GET", url: `^${B}/send/campaigns/${C2}/people/${A2}$`, regex: true, json: detail(A2, ANA, "stopped", "manual", ["stopped"]) },
    { method: "GET", url: `^${B}/send/campaigns/${C3}/people/${A4}$`, regex: true, json: detail(A4, ANA, "stopped", "manual", ["sent", "stopped"]) },
    DB,
  ]);
  assert.deepEqual(await O.applyOrigamiStops(admin(), client(), new Date()), { stopped: 1, unchanged: 1, failed: 0, canceled: 0, lost: 0, deferred: 0 });
  const posts = origamiCalls().filter((c) => c.method === "POST");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body, "{}");
  assert.match(posts[0].headers["idempotency-key"], /^vib521-stop-\d+$/);
  assert.deepEqual((await ops()).map((o) => o.state), ["confirmed", "confirmed"]);
  const before = mock.calls.length;
  assert.deepEqual(await O.applyOrigamiStops(admin(), client(), new Date()), { stopped: 0, unchanged: 0, failed: 0, canceled: 0, lost: 0, deferred: 0 });
  assert.equal(mock.calls.slice(before).filter((c) => c.url.startsWith("https://origami.chat")).length, 0, "a rerun makes no Origami call");
});

test("a stop whose read-back still shows a live sequence fails visibly and is retried, never confirmed", async () => {
  await fresh();
  process.env.ORIGAMI_OPTOUT_APPLY = "1";
  const now = new Date().toISOString();
  assert.equal((await admin().from("gtm_email_sync_ops").insert({ op_key: `stop:${C2}:${A2}:1`, destination: "origami", action: "sequence_stop", reason: "UNSUBSCRIBED", policy_version: O.RULE_VERSION,
    observed_at: now, state: "approved", approved_at: now, approval_ref: O.APPROVAL_REF, origami_campaign_id: C2, origami_sequence_id: A2 })).error, null);
  mock = installFetchMock([
    { method: "POST", url: `^${B}/send/campaigns/${C2}/people/${A2}/stop$`, regex: true, status: 409, json: { error: "x", code: "SEQUENCE_NOT_STOPPABLE" } },
    { method: "GET", url: `^${B}/send/campaigns/${C2}/people/${A2}$`, regex: true, json: detail(A2, ANA, "draft", null, ["draft"]) },
    DB,
  ]);
  assert.deepEqual(await O.applyOrigamiStops(admin(), client(), new Date()), { stopped: 0, unchanged: 0, failed: 1, canceled: 0, lost: 0, deferred: 0 });
  const [o] = await ops();
  assert.equal(o.state, "failed");
  assert.match(String(o.last_error), /read-back: the sequence can still send/);
});

test("the flag off: no Origami call, no Twenty call, no write; the hourly step says how to dry-run", async () => {
  await fresh();
  mock = installFetchMock([DB]);
  assert.deepEqual(await O.runOrigamiOptouts(admin(), reader(), new Date(), { deadline: Date.now() + 60_000, client: client() }), { skipped: "ORIGAMI_OPTOUT_APPLY is not 1 (dry run: gtm suppression origami-plan)" });
  assert.deepEqual(await O.applyOrigamiStops(admin(), client(), new Date()), { skipped: "ORIGAMI_OPTOUT_APPLY is not 1" });
  assert.deepEqual(await S.applyTwenty(admin(), reader(), new Date()), { skipped: "EMAIL_SUPPRESSION_APPLY and ORIGAMI_OPTOUT_APPLY are not 1" });
  assert.equal(mock.calls.filter((c) => !c.url.startsWith(l.url)).length, 0);
  assert.equal((await evidence()).length, 0);
});

test("with only ORIGAMI_OPTOUT_APPLY, the Twenty writer applies the Origami opt-out with its evidence line and leaves email operations alone", async () => {
  await fresh();
  process.env.ORIGAMI_OPTOUT_APPLY = "1";
  mock = installFetchMock([...origami(), twentyPeople(P), DB]);
  await O.ingest(admin(), client(), [webhookEvidence("no")]);
  await O.processPending(admin(), client(), reader(), new Date());
  const now = new Date().toISOString();
  assert.equal((await admin().from("gtm_email_sync_ops").insert({ op_key: `person:${P2}:optout:999`, destination: "twenty", action: "person_opt_out", person_id: P2, reason: "UNSUBSCRIBED",
    policy_version: S.POLICY_VERSION, observed_at: now, state: "approved", approved_at: now, approval_ref: "approved email op" })).error, null);
  mock.restore();
  const live = (consent: string, evidence: string | null) => JSON.stringify({ data: { people: { pageInfo: { hasNextPage: false, endCursor: null }, edges: [{ node: { id: P, updatedAt: "2026-11-01T00:00:00.000Z",
    emails: { primaryEmail: ANA, additionalEmails: [] }, gtmMarketingConsent: consent, gtmConsentEvidence: evidence, gtmEmailRestrictions: null } }] } } });
  mock = installFetchMock([
    { url: "https://crm.test/graphql", body: live("NONE", "site signup"), times: 1 },
    { ...twentyPeople(P), times: 1 },
    { url: "https://crm.test/graphql", json: { data: { updatePeople: [{ id: P }] } }, times: 1 },
    { url: "https://crm.test/graphql", body: live("UNSUBSCRIBED", "site signup\n..."), times: 1 },
    DB,
  ]);
  assert.deepEqual(await S.applyTwenty(admin(), reader(), new Date()), { confirmed: 1, unchanged: 0, failed: 0, canceled: 0, lost: 0 });
  const write = mock.calls.find((c) => /updatePeople/.test(c.body ?? ""))!;
  const d = JSON.parse(write.body!).variables.d;
  assert.equal(d.gtmMarketingConsent, "UNSUBSCRIBED");
  assert.match(d.gtmConsentEvidence, new RegExp(`^site signup\\nUNSUBSCRIBED from an Origami email reply received ${T.replace(/\./g, "\\.")} \\(campaign ${C1}, sequence ${A1}, rule origami-reply-v1\\) \\(cockpit gtm:op:\\d+\\)\\.$`));
  assert.equal((await admin().from("gtm_email_sync_ops").select("state").eq("person_id", P2).single()).data!.state, "approved", "EMAIL_SUPPRESSION_APPLY is off: the email operation waits");
});

test("a run that runs out of time defers the rest: no attempt counted, nothing marked failed (review H1)", async () => {
  await fresh();
  process.env.ORIGAMI_OPTOUT_APPLY = "1";
  mock = installFetchMock([...origami(), twentyPeople(P), DB]);
  await O.ingest(admin(), client(), [webhookEvidence("no"), { ...webhookEvidence("Not interested"), received_at: "2026-11-10T10:30:00.000Z" }]);
  const late = new OrigamiClient({ key: "og_test", pauseMs: 0, retries: 0, deadline: Date.now() - 1 });
  const r = await O.processPending(admin(), late, reader(), new Date());
  assert.deepEqual([r.processed, r.failed, r.deferred], [0, 0, 2]);
  assert.deepEqual((await evidence()).map((e) => [e.attempts, e.last_error, e.processed_at]), [[0, null, null], [0, null, null]]);
  const now = new Date().toISOString();
  assert.equal((await admin().from("gtm_email_sync_ops").insert({ op_key: `stop:${C2}:${A2}:9`, destination: "origami", action: "sequence_stop", reason: "UNSUBSCRIBED", policy_version: O.RULE_VERSION,
    observed_at: now, state: "approved", approved_at: now, approval_ref: O.APPROVAL_REF, origami_campaign_id: C2, origami_sequence_id: A2 })).error, null);
  const stops = await O.applyOrigamiStops(admin(), late, new Date());
  assert.deepEqual(stops, { stopped: 0, unchanged: 0, failed: 0, canceled: 0, lost: 0, deferred: 1 });
  assert.deepEqual((await ops()).map((o) => [o.state, o.attempts]), [["approved", 0]], "back as it was, for the next run");
});

test("a fresh opt-out after a correction is a new operation and is applied (review M4)", async () => {
  await fresh();
  process.env.ORIGAMI_OPTOUT_APPLY = "1";
  mock = installFetchMock([...origami(), twentyPeople(P), DB]);
  await O.ingest(admin(), client(), [webhookEvidence("no")]);
  await O.processPending(admin(), client(), reader(), new Date());
  await admin().from("gtm_email_sync_ops").update({ state: "confirmed", confirmed_at: new Date().toISOString() }).eq("policy_version", O.RULE_VERSION);
  // Consent was reset in Twenty (a re-consent); later Origami itself marks her other sequence unsubscribed.
  await O.ingest(admin(), client(), [{ kind: "unsubscribed_status", source: "status_scan", sequence_id: A2, campaign_id: C2, channel: null, received_at: new Date().toISOString(), origami_reply_id: null }]);
  await O.processPending(admin(), client(), reader(), new Date());
  const consent = (await ops()).filter((o) => o.destination === "twenty" && o.reason === "UNSUBSCRIBED");
  assert.equal(consent.length, 2, "a second consent operation, not swallowed by the first one's key");
  assert.deepEqual(consent.map((o) => o.state).sort(), ["approved", "confirmed"]);
});

test("a possible opt-out is resolved by a person: --not releases the hold, --opt-out adds the consent write (review M5)", async () => {
  await fresh();
  process.env.ORIGAMI_OPTOUT_APPLY = "1";
  mock = installFetchMock([...origami(), twentyPeople(P), DB]);
  await O.ingest(admin(), client(), [webhookEvidence("Not interested, we built our own.")]);
  await O.processPending(admin(), client(), reader(), new Date());
  const [row] = await evidence();
  assert.deepEqual((await O.resolveOrigamiReviews(admin(), [row.id as number], "handled", "Reviewer Test", new Date())).skipped, [{ id: row.id, why: "matched: decide --opt-out or --not" }]);
  const not = await O.resolveOrigamiReviews(admin(), [row.id as number], "not_opt_out", "Reviewer Test", new Date());
  assert.deepEqual([not.resolved, not.holdsReleased, not.stopsCanceled, not.consentWrites], [1, 1, 1, 0]);
  assert.deepEqual(await S.emailHolds(admin(), P, null), [], "the desk hold is released");
  assert.deepEqual((await ops()).map((o) => o.state), ["canceled", "canceled"]);
  const labels = (await admin().from("gtm_email_reply_labels").select("source,opt_out,superseded_at,labeled_by").eq("origami_reply_id", row.id).order("id")).data!;
  assert.deepEqual(labels.map((l) => [l.source, l.opt_out, !!l.superseded_at]), [["deterministic", "uncertain", true], ["human", "none", false]]);
  assert.equal((await O.resolveOrigamiReviews(admin(), [row.id as number], "opt_out", "Reviewer Test", new Date())).skipped[0].why, "already reviewed");

  await fresh();
  mock.restore();
  mock = installFetchMock([...origami(), twentyPeople(P), DB]);
  await O.ingest(admin(), client(), [webhookEvidence("Not interested, we built our own.")]);
  await O.processPending(admin(), client(), reader(), new Date());
  const [again] = await evidence();
  const yes = await O.resolveOrigamiReviews(admin(), [again.id as number], "opt_out", "Reviewer Test", new Date());
  assert.deepEqual([yes.resolved, yes.holdsReleased, yes.consentWrites], [1, 1, 1]);
  assert.deepEqual((await ops()).map((o) => [o.destination, o.reason, o.state]), [
    ["twenty", "UNSUBSCRIBED", "approved"], ["twenty", "OPT_OUT_REVIEW", "canceled"], ["origami", "UNSUBSCRIBED", "approved"]], "consent write added, hold released, the stop carries on");
  assert.deepEqual(await S.emailHolds(admin(), P, null), ["they opted out"]);
  const consent = (await ops()).find((o) => o.reason === "UNSUBSCRIBED" && o.destination === "twenty")!;
  assert.equal(await S.evidenceCurrent(admin(), consent as unknown as Parameters<typeof S.evidenceCurrent>[1]), true, "the person's decision is current evidence for the write");
});

test("the webhook's own reply is processed before older failing evidence (review M6)", async () => {
  await fresh();
  process.env.ORIGAMI_OPTOUT_APPLY = "1";
  const db = admin();
  for (let i = 0; i < 6; i++) {
    const seq = `00000000-0000-4000-8000-00000000b10${i}`;
    assert.equal((await db.from("gtm_origami_replies").insert({ evidence_key: `status:${seq}`, kind: "unsubscribed_status", source: "status_scan", sequence_id: seq, received_at: new Date().toISOString(),
      rule_version: O.RULE_VERSION, classification: "confirmed", reason: "origami_unsubscribed" })).error, null);
  }
  mock = installFetchMock([...origami(), twentyPeople(P), { method: "POST", url: `^${B}/send/campaigns/${C2}/people/${A2}/stop$`, regex: true, json: {} }, DB]);
  const ingested = await O.ingest(db, client(), [webhookEvidence("no")]);
  const r = await O.processPending(db, client(), reader(), new Date(), { first: ingested.ids, limit: 5 });
  assert.equal(r.processed, 1, "this delivery's row, although six older rows (no campaign) come first by id");
  assert.equal(r.failed, 5);
  assert.equal((await evidence())[0].processed_at != null, true);
});

test("CRM outages do not prevent stops and evidence recovers after more than ten failures", async () => {
  await fresh();
  process.env.ORIGAMI_OPTOUT_APPLY = "1";
  mock = installFetchMock([...origami(), { url: "https://crm.test/graphql", status: 503, json: {} }, DB]);
  await O.ingest(admin(), client(), [webhookEvidence("no")]);
  for (let i = 0; i < 11; i++) assert.equal((await O.processPending(admin(), client(), reader(), new Date())).failed, 1);
  const [before] = await evidence();
  assert.equal(before.attempts, 11);
  assert.equal(before.processed_at, null);
  const stop = (await ops()).find((o) => o.destination === "origami")!;
  assert.equal(stop.state, "approved");
  mock.restore();
  mock = installFetchMock([
    { method: "GET", url: `^${B}/send/campaigns/${C2}/people/${A2}$`, regex: true, json: detail(A2, ANA, "scheduled", null, ["scheduled"]), times: 1 },
    { method: "POST", url: `^${B}/send/campaigns/${C2}/people/${A2}/stop$`, regex: true, json: {} },
    { method: "GET", url: `^${B}/send/campaigns/${C2}/people/${A2}$`, regex: true, json: detail(A2, ANA, "stopped", "manual", ["stopped"]) },
    DB,
  ]);
  const applied = await O.applyOrigamiStops(admin(), client(), new Date());
  assert.ok("stopped" in applied);
  assert.equal(applied.stopped, 1);
  mock.restore();
  mock = installFetchMock([...origami(), twentyPeople(P), DB]);
  assert.equal((await O.processPending(admin(), client(), reader(), new Date())).matched, 1);
  const after = await ops();
  assert.equal(after.find((o) => o.destination === "origami")!.state, "confirmed");
  const consent = after.find((o) => o.destination === "twenty")!;
  assert.equal(consent.state, "approved");
  assert.equal(await S.evidenceCurrent(admin(), consent as unknown as Parameters<typeof S.evidenceCurrent>[1]), true);
});

test("handling an unmatched opt-out preserves outstanding stop operations", async () => {
  for (const state of ["approved", "failed", "queued", "applied"] as const) {
    await fresh();
    process.env.ORIGAMI_OPTOUT_APPLY = "1";
    mock?.restore();
    mock = installFetchMock([...origami(), twentyPeople(), DB]);
    await O.ingest(admin(), client(), [webhookEvidence("no")]);
    await O.processPending(admin(), client(), reader(), new Date());
    const [row] = await evidence();
    const stop = (await ops()).find((o) => o.destination === "origami")!;
    assert.equal((await admin().from("gtm_email_sync_ops").update({ state }).eq("id", stop.id)).error, null);
    assert.equal((await O.resolveOrigamiReviews(admin(), [row.id as number], "handled", "Reviewer Test", new Date())).resolved, 1);
    const updated = (await ops()).find((o) => o.id === stop.id)!;
    assert.equal(updated.state, state);
    const label = await admin().from("gtm_email_reply_labels").select("superseded_at").eq("id", updated.label_id).single();
    assert.equal(label.data!.superseded_at, null);
  }
});

test("confirming already confirmed evidence keeps an approved or failed consent write current", async () => {
  for (const state of ["approved", "failed"] as const) {
    await fresh();
    process.env.ORIGAMI_OPTOUT_APPLY = "1";
    mock?.restore();
    mock = installFetchMock([...origami(), twentyPeople(P), DB]);
    await O.ingest(admin(), client(), [webhookEvidence("no")]);
    await O.processPending(admin(), client(), reader(), new Date());
    const [row] = await evidence();
    const consent = (await ops()).find((o) => o.destination === "twenty")!;
    assert.equal((await admin().from("gtm_email_sync_ops").update({ state }).eq("id", consent.id)).error, null);
    assert.equal((await O.resolveOrigamiReviews(admin(), [row.id as number], "opt_out", "Reviewer Test", new Date())).resolved, 1);
    const updated = (await ops()).find((o) => o.id === consent.id)!;
    assert.equal(updated.state, state);
    assert.equal(await S.evidenceCurrent(admin(), updated as unknown as Parameters<typeof S.evidenceCurrent>[1]), true);
  }
});

test("a multi-run reply backfill persists each page and eventually advances the overlap cursor", async () => {
  await fresh();
  process.env.ORIGAMI_OPTOUT_APPLY = "1";
  mock = installFetchMock([{ method: "GET", url: `^${B}/send/campaigns\\?`, regex: true, json: list([]) }, DB]);
  const seen: Array<string | null> = [];
  const c = client();
  c.repliesPage = async (_since, cursor) => {
    if (_since) return { items: [], next_cursor: null };
    const page = cursor ? Number(cursor) : 0;
    seen.push(cursor ?? null);
    return { items: [{ id: `00000000-0000-4000-8000-${String(page + 1).padStart(12, "0")}`, from: "lead", channel: "email", campaign_id: C1,
      sequence_id: A1, body: "Hello there", received_at: `2026-11-0${7 - page}T12:00:00.000Z` }], next_cursor: page < 6 ? String(page + 1) : null };
  };
  const readCursor = async () => (await admin().from("gtm_sync_state").select("value").eq("key", O.CURSOR_KEY).single()).data!.value as Record<string, unknown>;
  for (let i = 0; i < 3; i++) {
    const run = await O.runOrigamiOptouts(admin(), reader(), new Date(`2026-11-10T1${i}:00:00Z`), { deadline: Date.now() + 60_000, client: c });
    assert.ok("deferred" in run);
    assert.equal(run.deferred, i < 2);
    assert.equal((await evidence()).length, Math.min((i + 1) * 3, 7));
    const cursor = await readCursor();
    if (i < 2) assert.equal(cursor.nextCursor, String((i + 1) * 3));
    else assert.equal(cursor.since, "2026-11-07T12:00:00.000Z");
    const state = (await admin().from("gtm_sync_state").select("value").eq("key", O.RUN_KEY).single()).data!.value;
    assert.equal(state.lastOkAt, i < 2 ? null : "2026-11-10T12:00:00.000Z");
    // The newest replies were read on every run, so each one is progress even while the backlog is carried forward.
    assert.equal(state.lastProgressAt, `2026-11-10T1${i}:00:00.000Z`);
    assert.equal(state.firstAt, "2026-11-10T10:00:00.000Z");
  }
  assert.deepEqual(seen, [null, "1", "2", "3", "4", "5", "6"]);
});

test("a failed page is retried from its checkpoint without advancing past unsaved evidence", async () => {
  await fresh();
  process.env.ORIGAMI_OPTOUT_APPLY = "1";
  mock = installFetchMock([{ method: "GET", url: `^${B}/send/campaigns\\?`, regex: true, json: list([]) }, DB]);
  const c = client();
  let fail = true;
  const cursors: Array<string | null> = [];
  c.repliesPage = async (_since, cursor) => {
    if (_since) return { items: [], next_cursor: null };
    cursors.push(cursor ?? null);
    if (cursor && fail) { fail = false; throw new Error("synthetic page failure"); }
    return { items: [{ id: cursor ? R1 : A2, from: "lead", channel: "email", campaign_id: C1, sequence_id: A1,
      body: "Hello there", received_at: cursor ? "2026-11-07T12:00:00Z" : "2026-11-08T12:00:00Z" }], next_cursor: cursor ? null : "next" };
  };
  const first = await O.runOrigamiOptouts(admin(), reader(), new Date(), { deadline: Date.now() + 60_000, client: c });
  assert.ok("error" in first && first.error);
  assert.equal((await evidence()).length, 1);
  assert.equal((await admin().from("gtm_sync_state").select("value").eq("key", O.CURSOR_KEY).single()).data!.value.nextCursor, "next");
  const second = await O.runOrigamiOptouts(admin(), reader(), new Date(), { deadline: Date.now() + 60_000, client: c });
  assert.ok("deferred" in second && !second.deferred);
  assert.equal((await evidence()).length, 2);
  assert.deepEqual(cursors, [null, "next", "next"]);
});

test("a review waits for an active suppression writer", async () => {
  await fresh();
  const db = admin();
  assert.equal((await db.rpc("gtm_take_lease", { p_job: "origami.stop.apply", p_holder: "test-writer", p_seconds: 60 })).data, true);
  try {
    await assert.rejects(O.resolveOrigamiReviews(db, [999], "handled", "Reviewer Test", new Date()), /review cannot start/);
    assert.equal((await db.rpc("gtm_take_lease", { p_job: "origami.optouts.process", p_holder: "test-next", p_seconds: 60 })).data, true, "the earlier lease was released on failure");
  } finally {
    await db.rpc("gtm_release_lease", { p_job: "origami.stop.apply", p_holder: "test-writer" });
    await db.rpc("gtm_release_lease", { p_job: "origami.optouts.process", p_holder: "test-next" });
  }
});

test("new replies are ingested while an older backfill is still in progress", async () => {
  await fresh();
  process.env.ORIGAMI_OPTOUT_APPLY = "1";
  mock = installFetchMock([{ method: "GET", url: `^${B}/send/campaigns\\?`, regex: true, json: list([]) }, DB]);
  const c = client();
  let run = 0;
  c.repliesPage = async (since, cursor) => {
    if (since) return { items: run > 0 ? [{ id: R1, from: "lead", channel: "email", campaign_id: null, sequence_id: A2,
      body: "Not interested, we built our own.", received_at: "2026-11-10T11:30:00Z" }] : [], next_cursor: null };
    const page = cursor ? Number(cursor) : 0;
    return { items: [], next_cursor: String(page + 1) };
  };
  await O.runOrigamiOptouts(admin(), reader(), new Date("2026-11-10T11:00:00Z"), { deadline: Date.now() + 60_000, client: c });
  run++;
  await O.runOrigamiOptouts(admin(), reader(), new Date("2026-11-10T12:00:00Z"), { deadline: Date.now() + 60_000, client: c });
  assert.equal((await evidence()).filter((r) => r.sequence_id === A2).length, 1);
  assert.equal((await admin().from("gtm_sync_state").select("value").eq("key", O.CURSOR_KEY).single()).data!.value.nextCursor, "6");
});

test("a large unsubscribe status scan records pages across runs", async () => {
  await fresh();
  process.env.ORIGAMI_OPTOUT_APPLY = "1";
  mock = installFetchMock([DB]);
  const c = client();
  c.repliesPage = async () => ({ items: [], next_cursor: null });
  c.campaignsPage = async () => ({ items: [{ id: C1, status: "active" }], next_cursor: null });
  c.person = async () => { throw new Error("synthetic unavailable person"); };
  c.peoplePage = async (_campaign, _filter, cursor) => {
    const page = cursor ? Number(cursor) : 0;
    return { items: [{ sequence_id: `00000000-0000-4000-8000-${String(800 + page).padStart(12, "0")}`, status: "replied", stop_reason: "unsubscribed" }], next_cursor: page < pages - 1 ? String(page + 1) : null };
  };
  // More pages than two runs read, so the scan spans three runs at STATUS_PAGES_PER_RUN pages each.
  const per = O.STATUS_PAGES_PER_RUN, pages = 2 * per + 1;
  for (let i = 0; i < 3; i++) {
    await O.runOrigamiOptouts(admin(), reader(), new Date(), { deadline: Date.now() + 60_000, client: c });
    const rows = await admin().from("gtm_origami_replies").select("id").eq("source", "status_scan");
    assert.equal(rows.data!.length, Math.min((i + 1) * per, pages));
  }
});

test("large sequence discovery records stops across runs before completing the CRM match", async () => {
  await fresh();
  process.env.ORIGAMI_OPTOUT_APPLY = "1";
  mock = installFetchMock([...origami(), twentyPeople(P), DB]);
  await O.ingest(admin(), client(), [webhookEvidence("no")]);
  const c = client();
  c.person = async (_campaign, seq) => ({ ...detail(seq, ANA, seq === A1 ? "replied" : "scheduled", seq === A1 ? "replied" : null, ["scheduled"]), replies: undefined });
  c.peoplePage = async (_campaign, _filter, cursor) => {
    const page = cursor ? Number(cursor) : 0;
    return { items: [{ sequence_id: `00000000-0000-4000-8000-${String(900 + page).padStart(12, "0")}`, status: "scheduled", stop_reason: null }], next_cursor: page < 6 ? String(page + 1) : null };
  };
  for (let i = 0; i < 3; i++) {
    const result = await O.processPending(admin(), c, reader(), new Date(), { campaigns: [{ id: C1, status: "active" }] });
    assert.equal((await ops()).filter((o) => o.destination === "origami").length, Math.min((i + 1) * 3, 7));
    assert.equal(result.processed, i === 2 ? 1 : 0);
  }
});

test("stops and consent writes recover after more than five provider failures", async () => {
  await fresh();
  process.env.ORIGAMI_OPTOUT_APPLY = "1";
  mock = installFetchMock([...origami(), twentyPeople(P), DB]);
  await O.ingest(admin(), client(), [webhookEvidence("no")]);
  await O.processPending(admin(), client(), reader(), new Date());
  assert.equal((await admin().from("gtm_email_sync_ops").update({ state: "failed", attempts: 8 }).eq("policy_version", O.RULE_VERSION)).error, null);
  mock.restore();
  const live = (consent: string) => ({ data: { people: { pageInfo: { hasNextPage: false, endCursor: null }, edges: [{ node: { id: P, updatedAt: "2026-11-01T00:00:00Z",
    emails: { primaryEmail: ANA, additionalEmails: [] }, gtmMarketingConsent: consent, gtmConsentEvidence: null, gtmEmailRestrictions: null } }] } } });
  mock = installFetchMock([
    { method: "GET", url: `^${B}/send/campaigns/${C2}/people/${A2}$`, regex: true, json: detail(A2, ANA, "stopped", "manual", ["stopped"]) },
    { url: "https://crm.test/graphql", json: live("UNSUBSCRIBED") }, DB,
  ]);
  const stopped = await O.applyOrigamiStops(admin(), client(), new Date());
  assert.ok("unchanged" in stopped && stopped.unchanged === 1);
  const consent = await S.applyTwenty(admin(), reader(), new Date());
  assert.ok("unchanged" in consent && consent.unchanged === 1);
  assert.deepEqual((await ops()).map((o) => o.state), ["confirmed", "confirmed"]);
});

test("malformed reply evidence never advances its page checkpoint", async () => {
  await fresh();
  process.env.ORIGAMI_OPTOUT_APPLY = "1";
  mock = installFetchMock([{ method: "GET", url: `^${B}/send/campaigns\\?`, regex: true, json: list([]) }, DB]);
  const c = client();
  c.repliesPage = async () => ({ items: [{ id: R1, from: "lead", channel: "email", campaign_id: C1, sequence_id: A1, body: null as unknown as string, received_at: T }], next_cursor: "next" });
  const run = await O.runOrigamiOptouts(admin(), reader(), new Date(), { deadline: Date.now() + 60_000, client: c });
  assert.ok("error" in run && /malformed lead evidence/.test(run.error ?? ""));
  assert.equal((await admin().from("gtm_sync_state").select("key").eq("key", O.CURSOR_KEY).maybeSingle()).data, null);
});

test("repeated CRM deadlines do not starve fresh reply and status collection", async () => {
  await fresh();
  process.env.ORIGAMI_OPTOUT_APPLY = "1";
  mock = installFetchMock([...origami(), DB]);
  await O.ingest(admin(), client(), [webhookEvidence("no")]);
  const c = client();
  c.repliesPage = async () => ({ items: [{ id: R1, from: "lead", channel: "email", campaign_id: C1, sequence_id: A2, body: "Hello there", received_at: "2026-11-10T11:30:00Z" }], next_cursor: null });
  c.campaignsPage = async () => ({ items: [{ id: C1, status: "active" }], next_cursor: null });
  c.peoplePage = async (_campaign, filter) => filter?.search ? { items: [], next_cursor: null } :
    { items: [{ sequence_id: A3, status: "replied", stop_reason: "unsubscribed" }], next_cursor: null };
  const slow = reader();
  slow.all = async () => { throw new Error("Twenty read stopped at the run deadline"); };
  for (let i = 0; i < 2; i++) await O.runOrigamiOptouts(admin(), slow, new Date(), { deadline: Date.now() + 60_000, client: c });
  const rows = await evidence();
  assert.ok(rows.some((r) => r.sequence_id === A2 && r.kind === "reply"));
  assert.ok(rows.some((r) => r.sequence_id === A3 && r.kind === "unsubscribed_status"));
});

test("a large search page resumes within its saved snapshot", async () => {
  await fresh();
  process.env.ORIGAMI_OPTOUT_APPLY = "1";
  mock = installFetchMock([...origami(), twentyPeople(P), DB]);
  await O.ingest(admin(), client(), [webhookEvidence("no")]);
  const c = client();
  c.person = async (_campaign, seq) => ({ ...detail(seq, ANA, seq === A1 ? "replied" : "scheduled", seq === A1 ? "replied" : null, ["scheduled"]), replies: undefined });
  let pagesRead = 0;
  c.peoplePage = async () => {
    pagesRead++;
    return { items: Array.from({ length: 20 }, (_, i) => ({ sequence_id: `00000000-0000-4000-8000-${String(1100 + i).padStart(12, "0")}`, status: "scheduled", stop_reason: null })), next_cursor: null };
  };
  for (let i = 0; i < 3; i++) {
    const result = await O.processPending(admin(), c, reader(), new Date(), { campaigns: [{ id: C1, status: "active" }] });
    assert.equal((await ops()).filter((o) => o.destination === "origami").length, Math.min((i + 1) * 8, 20));
    assert.equal((await ops()).filter((o) => o.destination === "twenty" && o.reason === "UNSUBSCRIBED").length, 1, "consent is queued before discovery finishes");
    assert.equal(result.processed, i === 2 ? 1 : 0);
  }
  assert.equal(pagesRead, 1, "resume does not refetch a potentially changed page");
});

test("malformed status and sequence search rows are not acknowledged", async () => {
  await fresh();
  process.env.ORIGAMI_OPTOUT_APPLY = "1";
  mock = installFetchMock([...origami(), twentyPeople(P), DB]);
  const c = client();
  c.repliesPage = async () => ({ items: [], next_cursor: null });
  c.campaignsPage = async () => ({ items: [{ id: C1, status: "active" }], next_cursor: null });
  c.peoplePage = async () => ({ items: [{ sequence_id: A2, status: null as unknown as string, stop_reason: null }], next_cursor: null });
  const run = await O.runOrigamiOptouts(admin(), reader(), new Date(), { deadline: Date.now() + 60_000, client: c });
  assert.ok("error" in run && /malformed sequence/.test(run.error ?? ""));
  assert.equal((await admin().from("gtm_sync_state").select("key").eq("key", "origami.status.full").maybeSingle()).data, null);
  await O.ingest(admin(), c, [webhookEvidence("no")]);
  c.peoplePage = async () => ({ items: [{ sequence_id: "invalid", status: "scheduled", stop_reason: null }], next_cursor: null });
  const result = await O.processPending(admin(), c, reader(), new Date(), { campaigns: [{ id: C1, status: "active" }] });
  assert.equal(result.failed, 1);
  assert.equal((await evidence())[0].processed_at, null);
  c.peoplePage = async () => ({ items: [], next_cursor: null });
  assert.equal((await O.processPending(admin(), c, reader(), new Date(), { campaigns: [{ id: C1, status: "active" }] })).processed, 1, "a corrected provider page is fetched on retry");
});

test("Origami consent refuses changed identity, ambiguous identity, and later CRM changes", async () => {
  for (const scenario of ["changed", "ambiguous", "later"] as const) {
    await fresh();
    process.env.ORIGAMI_OPTOUT_APPLY = "1";
    mock?.restore();
    mock = installFetchMock([...origami(), twentyPeople(P), DB]);
    await O.ingest(admin(), client(), [webhookEvidence("no")]);
    await O.processPending(admin(), client(), reader(), new Date());
    mock.restore();
    const person = { data: { people: { pageInfo: { hasNextPage: false, endCursor: null }, edges: [{ node: { id: P,
      updatedAt: scenario === "later" ? "2026-11-11T00:00:00Z" : "2026-11-01T00:00:00Z", emails: { primaryEmail: scenario === "changed" ? "new@prospect.test" : ANA, additionalEmails: [] },
      gtmMarketingConsent: "SUBSCRIBED", gtmConsentEvidence: "later consent", gtmEmailRestrictions: null } }] } } };
    mock = installFetchMock([{ url: "https://crm.test/graphql", json: person, times: 1 }, ...(scenario === "changed" ? [] : [twentyPeople(P, ...(scenario === "ambiguous" ? [P2] : []))]), DB]);
    const result = await S.applyTwenty(admin(), reader(), new Date());
    assert.ok("failed" in result && result.failed === 1);
    const op = (await ops()).find((o) => o.destination === "twenty")!;
    assert.match(String(op.last_error), /review required/);
    assert.equal(mock.calls.some((c) => /updatePeople/.test(c.body ?? "")), false);
    if (scenario === "ambiguous") {
      const search = mock.calls.find((c) => c.body?.includes("additionalEmails") && c.body.includes("like"));
      const filter = JSON.parse(search!.body!).variables.f.or[1].emails.additionalEmails.like as string;
      assert.equal(filter, "%___@________.____%", "LIKE wildcards every letter so uppercase additional addresses are included");
    }
  }
});

test("status-only evidence observed after a re-consent cannot write without human confirmation", async () => {
  await fresh();
  process.env.ORIGAMI_OPTOUT_APPLY = "1";
  mock = installFetchMock([...origami(), twentyPeople(P), DB]);
  const now = new Date("2026-11-10T12:00:00Z");
  const recorded = await O.ingest(admin(), client(), [{ kind: "unsubscribed_status", source: "status_scan", sequence_id: A1, campaign_id: C1, channel: null, received_at: now.toISOString(), origami_reply_id: null }]);
  await O.processPending(admin(), client(), reader(), now);
  mock.restore();
  const live = { data: { people: { pageInfo: { hasNextPage: false, endCursor: null }, edges: [{ node: { id: P, updatedAt: "2026-11-10T10:00:00Z",
    emails: { primaryEmail: ANA, additionalEmails: [] }, gtmMarketingConsent: "SUBSCRIBED", gtmConsentEvidence: "later re-consent", gtmEmailRestrictions: null } }] } } };
  mock = installFetchMock([{ url: "https://crm.test/graphql", json: live, times: 1 }, twentyPeople(P), DB]);
  const result = await S.applyTwenty(admin(), reader(), now);
  assert.ok("failed" in result && result.failed === 1);
  assert.match(String((await ops()).find((o) => o.destination === "twenty")!.last_error), /status has no refusal timestamp/);
  assert.equal(mock.calls.some((c) => /updatePeople/.test(c.body ?? "")), false);
  assert.equal((await O.resolveOrigamiReviews(admin(), recorded.ids, "opt_out", "Reviewer Test", new Date("2026-11-10T13:00:00Z"))).resolved, 1);
});

test("Origami consent errors never persist CRM error bodies", async () => {
  await fresh();
  process.env.ORIGAMI_OPTOUT_APPLY = "1";
  mock = installFetchMock([...origami(), twentyPeople(P), DB]);
  await O.ingest(admin(), client(), [webhookEvidence("no")]);
  await O.processPending(admin(), client(), reader(), new Date());
  mock.restore();
  mock = installFetchMock([{ url: "https://crm.test/graphql", json: { errors: [{ message: "Private Name https://linkedin.com/in/private-person" }] } }, DB]);
  await S.applyTwenty(admin(), reader(), new Date());
  const op = (await ops()).find((o) => o.destination === "twenty")!;
  assert.equal(op.last_error, "Twenty: the CRM read or write failed");
});
