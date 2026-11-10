// The owners' reply review (lib/email/review.ts) and the human override in suppression detection. Synthetic rows only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { humanLabelProblems, replyRows, type LabelRow } from "../lib/email/review.ts";
import { withoutOverruled } from "../lib/email/suppression.ts";

const label = (id: number, event_id: number, source: string, intent: string, opt_out = "none", extra: Partial<LabelRow> = {}): LabelRow =>
  ({ id, event_id, person_id: "00000000-0000-4000-8000-000000000001", source, intent, opt_out, model: source === "model" ? "jev-1.13-free" : null, labeled_by: source === "human" ? "owner@example.test" : null, labeled_at: "2026-11-09T10:00:00Z", superseded_at: null, ...extra });

test("a human label needs a known intent and stop choice", () => {
  assert.deepEqual(humanLabelProblems("interested", "none"), []);
  assert.deepEqual(humanLabelProblems("not_now", "person"), []);
  assert.equal(humanLabelProblems("uncertain", "none").length, 1, "uncertain is the machines' answer, not a person's");
  assert.equal(humanLabelProblems("interested", "uncertain").length, 1);
});

test("replies needing review come first: a possible stop, or no confident model answer, and no human label", () => {
  const events = [{ id: 1, member: "JOHN", at: "2026-11-09T10:00:00Z" }, { id: 2, member: "ABE", at: "2026-11-09T11:00:00Z" },
    { id: 3, member: "JOHN", at: "2026-11-09T12:00:00Z" }, { id: 4, member: "JOHN", at: "2026-11-09T13:00:00Z" }];
  const rows = replyRows(events, [
    label(1, 1, "deterministic", "uncertain"), label(2, 1, "model", "interested"),                      // confident: no review
    label(3, 2, "deterministic", "uncertain", "uncertain"), label(4, 2, "model", "not_interested"),    // rule saw a possible stop
    label(5, 3, "deterministic", "auto_reply"),                                                          // auto-reply: never
    label(6, 4, "deterministic", "uncertain"), label(7, 4, "model", "uncertain"), label(8, 4, "human", "not_now"),   // labeled
  ]);
  assert.deepEqual(rows.map((r) => [r.eventId, r.needsReview]), [[2, true], [4, false], [3, false], [1, false]]);
  assert.equal(rows.find((r) => r.eventId === 4)!.human!.intent, "not_now");
  assert.equal(rows[0].personId, "00000000-0000-4000-8000-000000000001");
});

test("a superseded label is ignored", () => {
  const rows = replyRows([{ id: 1, member: "ABE", at: "2026-11-09T10:00:00Z" }], [label(1, 1, "human", "interested", "none", { superseded_at: "2026-11-09T11:00:00Z" })]);
  assert.equal(rows[0].human, null);
});

test("on a reply a person labeled, only the person's label can open suppression", () => {
  const ls = [label(1, 10, "model", "uncertain", "uncertain"), label(2, 10, "human", "interested", "person"), label(3, 11, "deterministic", "uncertain", "uncertain")];
  assert.deepEqual(withoutOverruled(ls, new Set([10])).map((l) => l.id), [2, 3]);
  assert.deepEqual(withoutOverruled(ls, new Set()).map((l) => l.id), [1, 2, 3]);
});
