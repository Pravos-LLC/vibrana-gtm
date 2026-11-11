// When the hourly health check raises the Origami step and mailbox incidents: carried-over backlog is not a failure, and
// a mailbox error that clears itself waits for its second run in a row. Pure functions, no database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { collectionFailing, origamiStepProblems } from "../lib/email/run.ts";
import { selfHealing } from "../lib/team/mailbox.ts";

const NOW = Date.parse("2026-11-11T05:20:00Z");
const ago = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const keys = (run: Parameters<typeof origamiStepProblems>[0]) => origamiStepProblems(run, NOW).map((i) => `${i.key}/${i.severity}`);

test("Origami step: runs that only carry older scans forward are progress, not a critical failure", () => {
  const run = { at: ago(0), ok: false, error: null, deferred: true, lastOkAt: ago(4), lastProgressAt: ago(0), firstAt: ago(30) };
  assert.deepEqual(keys(run), []);
});

test("Origami step: an error, or three hours without reading new replies, is critical", () => {
  assert.deepEqual(keys({ at: ago(0), ok: false, error: "replies: Origami 500", lastOkAt: ago(1), lastProgressAt: ago(1) }), ["suppression:origami_step/critical"]);
  const stalled = origamiStepProblems({ at: ago(0), ok: false, error: null, deferred: true, lastOkAt: ago(5), lastProgressAt: ago(4) }, NOW);
  assert.equal(stalled[0].severity, "critical");
  assert.match(stalled[0].summary, /not read new Origami replies for over three hours/);
  assert.deepEqual(keys(null), ["suppression:origami_step/critical"]);
});

test("Origami step: a state saved before progress was recorded falls back to the last full pass", () => {
  assert.deepEqual(keys({ at: ago(0), ok: false, error: null, deferred: true, lastOkAt: ago(4) }), ["suppression:origami_step/critical"]);
  assert.deepEqual(keys({ at: ago(0), ok: true, error: null, lastOkAt: ago(1) }), []);
});

test("Origami step: no full pass for 24 hours is a warning while replies are still read", () => {
  assert.deepEqual(keys({ at: ago(0), ok: false, error: null, deferred: true, lastOkAt: ago(25), lastProgressAt: ago(0) }), ["suppression:origami_backlog/warning"]);
  assert.deepEqual(keys({ at: ago(0), ok: false, error: null, deferred: true, lastOkAt: null, lastProgressAt: ago(0), firstAt: ago(25) }), ["suppression:origami_backlog/warning"]);
  assert.deepEqual(keys({ at: ago(0), ok: false, error: null, deferred: true, lastOkAt: null, lastProgressAt: ago(0), firstAt: ago(2) }), []);
});

test("mailbox: only errors that say they retry or resume next hour wait for a second run", () => {
  for (const m of ["The sync stopped early (thread re-read); it resumes where it left off next hour.", "The CRM rejected a lookup; the sync retries next hour.",
    "Gmail answered 503; the sync retries next hour.", "The sync state could not be read; the sync retries next hour."]) assert.equal(selfHealing(m), true, m);
  for (const m of ["Google no longer accepts the stored connection. Reconnect the mailbox.", "The connected Google account is not the configured mailbox. Reconnect it."]) assert.equal(selfHealing(m), false, m);
  const early = "The CRM rejected a lookup; the sync retries next hour.";
  assert.equal(collectionFailing(early, { count: 1, since: ago(0) }), false);
  assert.equal(collectionFailing(early, { count: 2, since: ago(1) }), true);
  assert.equal(collectionFailing(early, null), true, "no streak on record: alert rather than guess");
  assert.equal(collectionFailing("Google no longer accepts the stored connection. Reconnect the mailbox.", { count: 1, since: ago(0) }), true);
});
