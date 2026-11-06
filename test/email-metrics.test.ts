// Email contract v1 numbers (lib/email/metrics.ts, VIB-512): messages, attempts, efforts, cohort reply rates, bounces and
// coverage. Synthetic ids only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bounceCheck, DAY, efforts, emailStats, intentOf, isPositive, type EmailAttempt, type EmailEvent } from "../lib/email/metrics.ts";
import { collectionOf, currentDecisions } from "../lib/email/load.ts";

const NOW = Date.parse("2026-11-20T12:00:00Z");
const iso = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();
let id = 0;
const send = (daysAgo: number, thread: string, persons: string[], key?: string): EmailEvent => ({ id: ++id, kind: "outreach", at: iso(daysAgo), thread_id: thread, person_ids: persons, message_key: key ?? null, calc_version: 2 });
const reply = (daysAgo: number, thread: string, person: string): EmailEvent => ({ id: ++id, kind: "reply", at: iso(daysAgo), thread_id: thread, person_ids: [person] });
const att = (e: EmailEvent, person: string | null, episode: string | null, over: Partial<EmailAttempt> = {}): EmailAttempt =>
  ({ event_id: e.id, person_id: person, match: person ? "matched" : "unmatched", stream: person ? "cold" : "unknown", episode_id: episode, delivery: "no_failure_observed", verification: "unknown", policy_flags: [], ...over });

test("a copy of one message in two mailboxes is one message and one set of attempts", () => {
  const a = send(10, "t1", ["p1"], "k1"), b = send(10, "t9", ["p1"], "k1");
  const s = emailStats([a, b], [att(a, "p1", "e1"), att(b, "p1", "e1")], [], NOW - 30 * DAY, NOW, NOW);
  assert.equal(s.messages, 1); assert.equal(s.attempts, 1);
});

test("an effort spans threads: a follow-up in a new thread is not a new first touch; a reply in either counts once", () => {
  const a = send(20, "t1", ["p1"]), b = send(15, "t2", ["p1"]), r = reply(14, "t2", "p1");
  const all = efforts([a, b, r], [att(a, "p1", "e1"), att(b, "p1", "e1")]);
  assert.equal(all.length, 1); assert.equal(all[0].sends, 2); assert.equal(all[0].firstEventId, a.id); assert.equal(all[0].replied, true);
});

test("reply rate: efforts at least 7 days old in the window, hidden below 10; replies are an activity count", () => {
  const ev: EmailEvent[] = [], at: EmailAttempt[] = [];
  for (let i = 0; i < 9; i++) { const e = send(10 + i, `t${i}`, [`p${i}`]); ev.push(e); at.push(att(e, `p${i}`, `e${i}`)); }
  ev.push(reply(9, "t0", "p0"));
  const young = send(3, "ty", ["py"]); ev.push(young); at.push(att(young, "py", "ey"));
  let s = emailStats(ev, at, [], NOW - 30 * DAY, NOW, NOW);
  assert.deepEqual(s.replyRate, { rate: null, num: 1, n: 9 }, "9 mature efforts: hidden");
  assert.equal(s.newEfforts, 10, "the young effort is new but not yet in a rate");
  const e = send(12, "t10", ["p10"]); ev.push(e); at.push(att(e, "p10", "e10"));
  s = emailStats(ev, at, [], NOW - 30 * DAY, NOW, NOW);
  assert.deepEqual(s.replyRate, { rate: 0.1, num: 1, n: 10 });
});

test("only a confirmed first-touch failure leaves the denominator; a later failed follow-up never removes an earlier exchange", () => {
  const ev: EmailEvent[] = [], at: EmailAttempt[] = [];
  for (let i = 0; i < 10; i++) { const e = send(20, `t${i}`, [`p${i}`]); ev.push(e); at.push(att(e, `p${i}`, `e${i}`)); }
  at[0].delivery = "failed_invalid_address";                       // confirmed: out
  at[1].delivery = "failed_unclassified";                           // a failure report with no type: stays in
  const f = send(10, "t2", ["p2"]); ev.push(f, reply(15, "t2", "p2")); at.push(att(f, "p2", "e2", { delivery: "failed_invalid_address" }));   // follow-up failed after a reply
  const s = emailStats(ev, at, [], NOW - 30 * DAY, NOW, NOW);
  assert.equal(s.replyRate.n, 9); assert.equal(s.replyRate.num, 1);
  assert.deepEqual(s.bounce, { rate: 3 / 11, num: 3, n: 11 }, "bounces are over attempts, at any n");
});

test("a reply belongs to the person's effort that came before it; positive needs the current decision to be interested", () => {
  const a = send(30, "t1", ["p1"]), b = send(12, "t2", ["p1"]), r1 = reply(29, "t1", "p1"), r2 = reply(11, "t2", "p1");
  const all = efforts([a, b, r1, r2], [att(a, "p1", "e1"), att(b, "p1", "e2")], [{ event_id: r2.id, intent: "interested" }]);
  const byId = Object.fromEntries(all.map((e) => [e.id, e]));
  assert.equal(byId.e1.replied, true); assert.equal(byId.e1.positive, false);
  assert.equal(byId.e2.positive, true);
});

test("coverage: ambiguous and unmatched recipients, policy-flagged and unverified sends, legacy rows", () => {
  const a = send(5, "t1", ["p1"]), legacy = { ...send(5, "t2", ["p2"]), calc_version: 1 };
  const s = emailStats([a, legacy], [att(a, "p1", "e1", { policy_flags: ["UNSUBSCRIBED"], verification: "unverified" }), att(a, null, null, { match: "ambiguous" }), att(a, null, null)], [], NOW - 30 * DAY, NOW, NOW);
  assert.deepEqual(s.coverage, { ambiguous: 1, unmatched: 1, noEpisode: 0, legacyRows: 1, withoutAttempts: 1, policyFlagged: 1, unverified: 1 });
  assert.equal(s.attempts, 1, "only cold attempts are the bounce denominator");
  assert.equal(s.complete, false, "a message without attempts makes the window partial");
  assert.equal(s.bounce.rate, null, "a partial window never shows a measured (healthy) rate");
});

test("bounce check: above 2% of the last 7 days' attempts alerts at any n; none sent is not a healthy zero", () => {
  const a = send(2, "t1", ["p1"]);
  assert.deepEqual(bounceCheck([a], [att(a, "p1", "e1", { delivery: "failed_invalid_address" })], NOW), { rate: 1, num: 1, n: 1, alert: true, complete: true });
  assert.deepEqual(bounceCheck([], [], NOW), { rate: null, num: 0, n: 0, alert: false, complete: true });
  const legacy = Array.from({ length: 10 }, (_, i) => ({ ...send(2, `l${i}`, [`q${i}`]), calc_version: 1 }));
  const ok = send(2, "t2", ["p2"]);
  const partial = bounceCheck([...legacy, ok], [att(ok, "p2", "e2")], NOW);
  assert.deepEqual([partial.rate, partial.alert, partial.complete], [null, false, false], "ten unreconciled sends and one clean attempt: not a healthy zero");
  const failing = bounceCheck([...legacy, ok], [att(ok, "p2", "e2", { delivery: "failed_invalid_address" })], NOW);
  assert.equal(failing.alert, true, "an observed failure still alerts with partial coverage");
});

test("legacy desk labels map to the contract's words; a human decision outranks a model's; superseded rows are ignored", () => {
  assert.equal(intentOf("positive"), "interested"); assert.equal(intentOf("negative"), "not_interested"); assert.equal(intentOf("not_now"), "not_now");
  assert.ok(isPositive("positive") && isPositive("interested") && !isPositive("neutral") && !isPositive(null));
  assert.deepEqual(currentDecisions([
    { event_id: 1, source: "model", intent: "interested", superseded_at: null },
    { event_id: 1, source: "human", intent: "not_now", superseded_at: null },
    { event_id: 2, source: "human", intent: "interested", superseded_at: "2026-11-01T00:00:00Z" },
    { event_id: 2, source: "model", intent: "neutral", superseded_at: null },
  ]), [{ event_id: 1, intent: "not_now" }, { event_id: 2, intent: "neutral" }]);
  assert.deepEqual(currentDecisions([
    { event_id: 3, source: "model", intent: "interested", superseded_at: null },
    { event_id: 3, source: "deterministic", intent: "uncertain", opt_out: "none", superseded_at: null },
  ]), [{ event_id: 3, intent: "interested" }], "a rule decision that found nothing never outranks a model");
});

test("an effort spans members: the first touch's sender owns the cohort; the other member's follow-up is activity only (B1)", () => {
  const a = { ...send(20, "t1", ["p1"]), member: "A", mailbox: "a@hq.test" }, b = { ...send(10, "t9", ["p1"]), member: "B", mailbox: "b@hq.test" };
  const r = { ...reply(9, "t9", "p1"), member: "B", mailbox: "b@hq.test" };
  const at = [att(a, "p1", "e1"), att(b, "p1", "e1")];
  const sa = emailStats([a, b, r], at, [], NOW - 30 * DAY, NOW, NOW, { member: "A" }), sb = emailStats([a, b, r], at, [], NOW - 30 * DAY, NOW, NOW, { member: "B" });
  assert.deepEqual([sa.newEfforts, sa.replyRate.num, sa.messages], [1, 1, 1], "A's effort, answered through B's thread");
  assert.deepEqual([sb.newEfforts, sb.messages, sb.replies], [0, 1, 1], "B's follow-up is a message and B saw the reply, but no new effort");
});

test("a late reply to an earlier effort's thread goes to that effort, not the newest; an unplaceable reply credits none (B3)", () => {
  const e1 = { ...send(20, "t1", ["p1"]), mailbox: "a@hq.test" }, e2 = { ...send(10, "t2", ["p1"]), mailbox: "a@hq.test" };
  const late = { ...reply(9, "t1", "p1"), mailbox: "a@hq.test" }, stray = { ...reply(8, "t7", "p1"), mailbox: "a@hq.test" };
  const by = Object.fromEntries(efforts([e1, e2, late], [att(e1, "p1", "e1"), att(e2, "p1", "e2")]).map((e) => [e.id, e]));
  assert.equal(by.e1.replied, true); assert.equal(by.e2.replied, false);
  const none = Object.fromEntries(efforts([e1, e2, stray], [att(e1, "p1", "e1"), att(e2, "p1", "e2")]).map((e) => [e.id, e]));
  assert.equal(none.e1.replied || none.e2.replied, false, "two earlier efforts and no thread match: not guessed");
  const only = efforts([e1, stray], [att(e1, "p1", "e1")]);
  assert.equal(only[0].replied, true, "one earlier effort: it is that one");
});

test("a person's desk label outranks a model decision on the same effort (B4)", () => {
  const a = send(20, "t1", ["p1"]), r = reply(15, "t1", "p1");
  const [e] = efforts([a, r], [att(a, "p1", "e1")], [{ event_id: r.id, intent: "interested" }], [{ episode_id: "e1", intent: "negative" }]);
  assert.equal(e.positive, false, "the human's not-interested wins");
  const [h] = efforts([a], [att(a, "p1", "e1")], [], [{ episode_id: "e1", intent: "positive" }]);
  assert.deepEqual([h.replied, h.positive], [true, true], "a legacy positive label means interested, and implies the reply");
});

test("a later send into an old thread never moves a reply already made there (R1)", () => {
  const e1 = { ...send(20, "t1", ["p1"]), mailbox: "a@hq.test" }, e2 = { ...send(10, "t2", ["p1"]), mailbox: "a@hq.test" };
  const r = { ...reply(9, "t1", "p1"), mailbox: "a@hq.test" }, later = { ...send(5, "t1", ["p1"]), mailbox: "a@hq.test" };
  const by = Object.fromEntries(efforts([e1, e2, r, later], [att(e1, "p1", "e1"), att(e2, "p1", "e2"), att(later, "p1", "e2")]).map((e) => [e.id, e]));
  assert.deepEqual([by.e1.replied, by.e2.replied], [true, false]);
});

test("incomplete collection withholds every rate, while observed failures still alert (R2)", () => {
  const sends = Array.from({ length: 10 }, (_, i) => send(10, `c${i}`, [`q${i}`]));
  const at = sends.map((s, i) => att(s, `q${i}`, `x${i}`));
  const s = emailStats(sends, at, [], NOW - 30 * DAY, NOW, NOW, { collectionComplete: false });
  assert.deepEqual([s.complete, s.replyRate.rate, s.positiveRate.rate, s.bounce.rate], [false, null, null, null]);
  assert.equal(emailStats(sends, at, [], NOW - 30 * DAY, NOW, NOW).replyRate.rate, 0, "the same data with complete collection is measured");
  const recent = Array.from({ length: 10 }, (_, i) => send(3, `r${i}`, [`q${i}`])), ra = recent.map((x, i) => att(x, `q${i}`, `x${i}`, i ? {} : { delivery: "failed_invalid_address" }));
  const f = bounceCheck(recent, ra, NOW, undefined, false);
  assert.deepEqual([f.alert, f.complete, f.rate], [true, false, null]);
  const ok = { member: "ABE", backfill_done: true, last_sync_at: new Date(NOW - 3_600_000).toISOString(), last_error: null };
  assert.deepEqual(collectionOf([ok], NOW), { complete: true, gaps: [] });
  assert.equal(collectionOf([ok, { ...ok, member: "JOHN", backfill_done: false }], NOW).complete, false, "another member's backfilling mailbox counts: efforts span mailboxes");
  assert.equal(collectionOf([{ ...ok, last_error: "x" }], NOW).complete, false);
  assert.equal(collectionOf([{ ...ok, last_sync_at: new Date(NOW - 4 * 3_600_000).toISOString() }], NOW).complete, false);
  assert.equal(collectionOf([], NOW).complete, false);
});

test("a reply in a copy's thread (another mailbox saw the same send) reaches the original's effort", () => {
  const e1 = { ...send(20, "t1", ["p1"]), mailbox: "a@hq.test", message_key: "k1" }, e2 = { ...send(15, "t2", ["p1"]), mailbox: "a@hq.test", message_key: "k2" };
  const copy = { ...send(20, "c1", ["p1"]), mailbox: "b@hq.test", message_key: "k1" }, r = { ...reply(9, "c1", "p1"), mailbox: "b@hq.test" };
  const by = Object.fromEntries(efforts([e1, e2, copy, r], [att(e1, "p1", "e1"), att(e2, "p1", "e2")]).map((e) => [e.id, e]));
  assert.deepEqual([by.e1.replied, by.e2.replied], [true, false]);
});

test("a reply reaches the effort across a chain of copies in three mailboxes", () => {
  const m1a = { ...send(20, "a", ["p1"], "m1"), mailbox: "a@hq.test" }, m1b = { ...send(20, "b", ["p1"], "m1"), mailbox: "b@hq.test" };
  const m2b = { ...send(16, "b", ["p1"], "m2"), mailbox: "b@hq.test" }, m2c = { ...send(16, "c", ["p1"], "m2"), mailbox: "c@hq.test" };
  const other = { ...send(18, "z", ["p1"], "m9"), mailbox: "a@hq.test" };
  const r = { ...reply(15, "c", "p1"), mailbox: "c@hq.test" };
  const by = Object.fromEntries(efforts([m1a, m1b, m2b, m2c, other, r], [att(m1a, "p1", "e1"), att(m2b, "p1", "e1"), att(other, "p1", "e2")]).map((e) => [e.id, e]));
  assert.deepEqual([by.e1.replied, by.e2.replied], [true, false]);
});
