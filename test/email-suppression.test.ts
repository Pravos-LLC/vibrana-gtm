// Email suppression rules (VIB-513, AC497-01/02/07): what each outcome becomes, the dry-run report and the exact change
// to a person. Synthetic ids and addresses only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
process.env.TEAM_MAILBOX_KEY ??= randomBytes(32).toString("base64");
const S = await import("../lib/email/suppression.ts");
const { addressHash } = await import("../lib/team/crypto.ts");

const P = "00000000-0000-4000-8000-0000000000c1";
const at = (delivery: string, person: string | null = P) => ({ event_id: 1, person_id: person, recipient_hash: "h".repeat(32), delivery, delivery_at: "2026-11-05T00:00:00Z", delivery_event_id: 2 });
const label = (o: Partial<{ source: string; opt_out: string; superseded_at: string | null; event_id: number }> = {}) =>
  ({ id: 7, event_id: 3, person_id: P, source: "human", opt_out: "person", superseded_at: null, labeled_at: "2026-11-05T00:00:00Z", ...o });

test("an invalid address becomes an address restriction (Twenty pending, Origami held); nothing else does", () => {
  const ops = S.proposeOps([at("failed_invalid_address"), at("delayed"), at("failed_policy"), at("failed_unclassified"), at("failed_invalid_address", null)], [], new Map());
  assert.deepEqual(ops.map((o) => [o.destination, o.action, o.reason, o.state]), [["twenty", "address_restrict", "EMAIL_BOUNCED", "pending_review"], ["origami", "exclusion_upsert", "EMAIL_BOUNCED", "held"]]);
  assert.equal(ops[1].last_error, S.ORIGAMI_HELD);
  assert.ok(ops.every((o) => o.action !== "person_opt_out"), "a bounce never touches the person's consent");
});

test("opt-outs: a person's own is applied as UNSUBSCRIBED; an address-scoped one stays on that address; a possible one is only a review", () => {
  const sender = new Map([[3, "s".repeat(32)]]);
  assert.deepEqual(S.proposeOps([], [label()], sender).map((o) => [o.destination, o.action, o.reason]), [["twenty", "person_opt_out", "UNSUBSCRIBED"], ["origami", "exclusion_upsert", "UNSUBSCRIBED"]]);
  assert.deepEqual(S.proposeOps([], [label({ opt_out: "address" })], sender).map((o) => [o.action, o.address_hash, o.reason]).slice(0, 1), [["address_opt_out", "s".repeat(32), "ADDRESS_OPT_OUT"]]);
  for (const l of [label({ source: "deterministic", opt_out: "uncertain" }), label({ source: "model" }), label({ opt_out: "address", event_id: 9 })]) {
    const ops = S.proposeOps([], [l], sender);
    assert.deepEqual(ops.map((o) => [o.destination, o.reason, o.state]), [["twenty", "OPT_OUT_REVIEW", "pending_review"]], JSON.stringify(l));
  }
  assert.deepEqual(S.proposeOps([], [label({ superseded_at: "2026-11-06T00:00:00Z" }), label({ opt_out: "none" })], sender), [], "a corrected or empty decision proposes nothing");
  assert.equal(S.proposeOps([], [label()], sender)[0].op_key, S.proposeOps([], [label()], sender)[0].op_key, "the same evidence gives the same key");
});

test("the dry-run report is counts only and names what a person opt-out also changes", () => {
  const ops = [...S.proposeOps([at("failed_invalid_address")], [label()], new Map())].map((o, i) => ({ ...o, id: i + 1, approved_at: null, approval_ref: null, applied_at: null, confirmed_at: null, attempts: 0, created_at: "2026-11-05T00:00:00Z" }));
  const r = S.planReport(ops);
  assert.equal(r.people, 1); assert.equal(r.downstream.personOptOuts, 1); assert.match(r.downstream.note, /meeting capture and enrichment/);
  assert.equal(r.origami.held, 2);
  assert.doesNotMatch(JSON.stringify(r), /@|00000000-0000/, "no address and no person id in the report");
});

test("the change to a person: only the owned fields, never another address, nothing when already in place", () => {
  const now = new Date("2026-11-06T00:00:00Z");
  const base = { id: P, updatedAt: "u1", emails: { primaryEmail: "Ana@Prospect.test", additionalEmails: ["ana@else.test"] }, gtmMarketingConsent: "NONE", gtmConsentEvidence: "site signup", gtmEmailRestrictions: { version: 1, addresses: { "old@x.test": { reason: "EMAIL_BOUNCED" } }, holds: [] } };
  const op = { ...S.proposeOps([{ ...at("failed_invalid_address"), recipient_hash: addressHash("ana@prospect.test") }], [], new Map())[0], id: 5, approved_at: "x", approval_ref: "r", applied_at: null, confirmed_at: null, attempts: 0, created_at: "x" };
  const c = S.changeFor(op, base, now) as { data: { gtmEmailRestrictions: { addresses: Record<string, { reason: string }> } } };
  assert.deepEqual(Object.keys(c.data), ["gtmEmailRestrictions"]);
  assert.deepEqual(Object.keys(c.data.gtmEmailRestrictions.addresses).sort(), ["ana@prospect.test", "old@x.test"], "the other entries are kept; the other address is not touched");
  assert.equal(S.changeFor(op, { ...base, gtmEmailRestrictions: { version: 1, addresses: { "ana@prospect.test": { reason: "EMAIL_BOUNCED" } } } }, now), null);
  assert.deepEqual(S.changeFor(op, { ...base, gtmEmailRestrictions: "junk" }, now), { error: "the person's gtmEmailRestrictions is unreadable; fix it in Twenty first" });
  assert.deepEqual(S.changeFor(op, { ...base, emails: { primaryEmail: "new@prospect.test" } }, now), { error: "the address is no longer on the person" });
  const optOut = { ...S.proposeOps([], [label()], new Map())[0], id: 6, approved_at: "x", approval_ref: "r", applied_at: null, confirmed_at: null, attempts: 0, created_at: "x" };
  const o = S.changeFor(optOut, base, now) as { data: Record<string, string> };
  assert.equal(o.data.gtmMarketingConsent, "UNSUBSCRIBED"); assert.match(o.data.gtmConsentEvidence, /^site signup\nUNSUBSCRIBED from an email reply on 2026-11-05/);
  assert.equal(S.changeFor(optOut, { ...base, gtmMarketingConsent: "UNSUBSCRIBED" }, now), null, "an existing opt-out is kept as it is");
  assert.equal(S.applyEnabled({}), false); assert.equal(S.applyEnabled({ EMAIL_SUPPRESSION_APPLY: "1" }), true);
  const asText = { ...base, gtmEmailRestrictions: JSON.stringify({ version: 1, addresses: { "old@x.test": { reason: "ADDRESS_OPT_OUT" } }, holds: [{ reason: "OPT_OUT_REVIEW" }] }) };
  const t = S.changeFor(op, asText, now) as { data: { gtmEmailRestrictions: { addresses: Record<string, unknown>; holds: unknown[] } } };
  assert.deepEqual(Object.keys(t.data.gtmEmailRestrictions.addresses).sort(), ["ana@prospect.test", "old@x.test"], "a value stored as JSON text keeps its entries");
  assert.equal(t.data.gtmEmailRestrictions.holds.length, 1, "and its holds");
  const empty = S.changeFor(op, { ...base, gtmEmailRestrictions: "" }, now) as { data: { gtmEmailRestrictions: { addresses: Record<string, unknown> } } };
  assert.deepEqual(Object.keys(empty.data.gtmEmailRestrictions.addresses), ["ana@prospect.test"], "an empty string is the CRM's empty value");
});

test("the version guard matches the read stamp's millisecond, like vibrana-crm's version_filter", () => {
  assert.deepEqual(S.versionFilter("p1", "2026-11-06T10:00:00.123Z"), { id: { eq: "p1" }, updatedAt: { gte: "2026-11-06T10:00:00.123Z", lt: "2026-11-06T10:00:00.124Z" } });
  assert.throws(() => S.versionFilter("p1", "u1"), /unreadable/);
});

test("an opt-out appends to existing consent evidence and never truncates it", () => {
  const op = { id: 9, action: "person_opt_out", observed_at: "2026-11-05T00:00:00Z" } as unknown as Parameters<typeof S.changeFor>[0];
  const proof = "original-proof: " + "x".repeat(3990);
  const c = S.changeFor(op, { id: "p", updatedAt: "2026-11-01T00:00:00.000Z", emails: null, gtmMarketingConsent: "NONE", gtmConsentEvidence: proof }, new Date()) as { data: { gtmConsentEvidence: string } };
  assert.ok(c.data.gtmConsentEvidence.startsWith(proof), "earlier proof kept whole");
  assert.match(c.data.gtmConsentEvidence, /UNSUBSCRIBED from an email reply on 2026-11-05 \(cockpit gtm:op:9\)\.$/);
});
