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
  assert.deepEqual(await O.ingest(admin(), client(), [webhookEvidence()]), { recorded: 1, duplicate: 0, failed: 0, confirmed: 1, possible: 0, none: 0 });
  assert.deepEqual(await O.ingest(admin(), client(), [pollEvidence(), webhookEvidence()]), { recorded: 0, duplicate: 2, failed: 0, confirmed: 0, possible: 0, none: 0 });
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
  assert.deepEqual(r, { processed: 1, failed: 0, matched: 1, ambiguous: 0, unmatched: 0, stopsProposed: 1 });
  assert.deepEqual((await ops()).map((o) => [o.destination, o.action, o.op_key, o.reason, o.state]), [
    ["twenty", "person_opt_out", `person:${P}:optout:origami`, "UNSUBSCRIBED", "approved"],
    ["origami", "sequence_stop", `stop:${C2}:${A2}`, "UNSUBSCRIBED", "approved"],
  ], "A1 is already stopped by Origami, A3 is someone else, A4 was stopped by hand");
  const [row] = await evidence();
  assert.deepEqual([row.match, row.person_id, row.sequences_found], ["matched", P, 2], "A1 and A2 are hers; only A2 can still send");
  assert.match(String(row.recipient_hash), /^[A-Za-z0-9_-]{32}$/);
  const label = (await admin().from("gtm_email_reply_labels").select("source,opt_out,person_id").eq("origami_reply_id", row.id)).data!;
  assert.deepEqual(label, [{ source: "deterministic", opt_out: "person", person_id: P }]);
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
  const op = (c: string, s: string) => ({ op_key: `stop:${c}:${s}`, destination: "origami", action: "sequence_stop", reason: "UNSUBSCRIBED", policy_version: O.RULE_VERSION, observed_at: now,
    state: "approved", approved_at: now, approval_ref: O.APPROVAL_REF, origami_campaign_id: c, origami_sequence_id: s, evidence_ref: "test" });
  assert.equal((await admin().from("gtm_email_sync_ops").insert([op(C2, A2), op(C3, A4)])).error, null);
  mock = installFetchMock([
    { method: "GET", url: `^${B}/send/campaigns/${C2}/people/${A2}$`, regex: true, json: detail(A2, ANA, "scheduled", null, ["scheduled"]), times: 1 },
    { method: "POST", url: `^${B}/send/campaigns/${C2}/people/${A2}/stop$`, regex: true, json: { status: "stopped" } },
    { method: "GET", url: `^${B}/send/campaigns/${C2}/people/${A2}$`, regex: true, json: detail(A2, ANA, "stopped", "manual", ["stopped"]) },
    { method: "GET", url: `^${B}/send/campaigns/${C3}/people/${A4}$`, regex: true, json: detail(A4, ANA, "stopped", "manual", ["sent", "stopped"]) },
    DB,
  ]);
  assert.deepEqual(await O.applyOrigamiStops(admin(), client(), new Date()), { stopped: 1, unchanged: 1, failed: 0, canceled: 0, lost: 0 });
  const posts = origamiCalls().filter((c) => c.method === "POST");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body, "{}");
  assert.match(posts[0].headers["idempotency-key"], /^vib521-stop-\d+$/);
  assert.deepEqual((await ops()).map((o) => o.state), ["confirmed", "confirmed"]);
  const before = mock.calls.length;
  assert.deepEqual(await O.applyOrigamiStops(admin(), client(), new Date()), { stopped: 0, unchanged: 0, failed: 0, canceled: 0, lost: 0 });
  assert.equal(mock.calls.slice(before).filter((c) => c.url.startsWith("https://origami.chat")).length, 0, "a rerun makes no Origami call");
});

test("a stop whose read-back still shows a live sequence fails visibly and is retried, never confirmed", async () => {
  await fresh();
  process.env.ORIGAMI_OPTOUT_APPLY = "1";
  const now = new Date().toISOString();
  assert.equal((await admin().from("gtm_email_sync_ops").insert({ op_key: `stop:${C2}:${A2}`, destination: "origami", action: "sequence_stop", reason: "UNSUBSCRIBED", policy_version: O.RULE_VERSION,
    observed_at: now, state: "approved", approved_at: now, approval_ref: O.APPROVAL_REF, origami_campaign_id: C2, origami_sequence_id: A2 })).error, null);
  mock = installFetchMock([
    { method: "POST", url: `^${B}/send/campaigns/${C2}/people/${A2}/stop$`, regex: true, status: 409, json: { error: "x", code: "SEQUENCE_NOT_STOPPABLE" } },
    { method: "GET", url: `^${B}/send/campaigns/${C2}/people/${A2}$`, regex: true, json: detail(A2, ANA, "draft", null, ["draft"]) },
    DB,
  ]);
  assert.deepEqual(await O.applyOrigamiStops(admin(), client(), new Date()), { stopped: 0, unchanged: 0, failed: 1, canceled: 0, lost: 0 });
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
