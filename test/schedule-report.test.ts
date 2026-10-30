import test from "node:test";
import assert from "node:assert/strict";
import { mergeReport, reconcileScheduleReport, scheduleChecks, scheduleLines, withScheduleChecks } from "../lib/schedule-report";

const pass = {
  skipped: [
    { id: "kb-x-instagram", storyId: "kb-x", reason: "no instagram media is staged: Instagram needs an image or a video" },
    { id: "held-a-linkedin", storyId: "held-a", reason: "held: publishing blocked until example_approver approves the final" },
    { id: "news-a-newsletter", storyId: "news-a", reason: "newsletter is published by hand" },
    { id: "kb-y-linkedin", storyId: "kb-y", reason: "too long: the LinkedIn post is 4,323 characters; LinkedIn takes at most 4,000. Shorten it and restage." },
  ],
  failed: [{ id: "s1-02-sample-piece-02-youtube", storyId: "s1-02-sample-piece-02", error: "Zernio 400: bad video" }, { id: "sample-extra-38-linkedin", storyId: null, error: "Zernio 500" }],
};

test("what John sees: failures and real skips, not holds (they have their own banner) or hand-published channels", () => {
  assert.deepEqual(scheduleLines(pass).map((l) => [l.id, l.storyId, l.kind]), [
    ["s1-02-sample-piece-02-youtube", "s1-02-sample-piece-02", "failed"],
    ["sample-extra-38-linkedin", null, "failed"], // an item of no Story is never linked to one guessed from its id
    ["kb-x-instagram", "kb-x", "skipped"],
    ["kb-y-linkedin", "kb-y", "skipped"],
  ]);
});

test("a stale losing-send report follows current calendar delivery, preserving real or interrupted failures", () => {
  const now = Date.parse("2026-10-28T06:00:00Z");
  const ids = ["scheduled", "published", "skipped", "sending", "interrupted", "failed", "unknown"];
  const report = { ran_at: "t", lines: ids.map((id) => ({ id, storyId: "s", kind: "failed" as const, reason: "another send claimed it" })) };
  const rows = ids.filter((id) => id !== "unknown").map((id) => ({ id, status: ["sending", "interrupted"].includes(id) ? "approved" : id, zernio_post_id: ["sending", "interrupted"].includes(id) ? "pending" : id === "scheduled" ? "remote-id" : null, updated_at: id === "interrupted" ? "2026-10-28T05:00:00Z" : "2026-10-28T05:59:00Z" }));
  const result = reconcileScheduleReport(report, rows, now);
  assert.deepEqual(result.lines.map((l) => l.id), ["sending", "interrupted", "failed", "unknown"]);
  assert.deepEqual(scheduleChecks(result).map((c) => c.severity), ["warn", "block", "block", "block"]);
  assert.match(result.lines[0].reason, /^scheduling in progress/);
  assert.match(result.lines[1].reason, /interrupted/);
});

test("a full pass replaces the record; a pass for one Story replaces only that Story's lines", () => {
  const full = mergeReport(null, pass, "t1");
  assert.equal(full.lines.length, 4);
  const fixed = mergeReport(full, { skipped: [], failed: [] }, "t2", "kb-x");
  assert.deepEqual(fixed.lines.map((l) => l.id), ["s1-02-sample-piece-02-youtube", "sample-extra-38-linkedin", "kb-y-linkedin"]);
  assert.deepEqual(mergeReport(fixed, { skipped: [], failed: [] }, "t3").lines, []);
});

test("findings: a Zernio failure or an over-limit text is a BLOCK, other skips a WARN, each linked to its piece and counted", () => {
  const report = mergeReport(null, pass, "t1");
  const checks = scheduleChecks(report);
  assert.deepEqual(checks.map((c) => [c.severity, c.storyId]), [["block", "s1-02-sample-piece-02"], ["block", undefined], ["warn", "kb-x"], ["block", "kb-y"]]);
  assert.match(checks[2].message, /^Approved, not scheduled: kb-x-instagram: no instagram media/);
  assert.match(checks[3].message, /kb-y-linkedin: too long: the LinkedIn post is 4,323 characters/);
  const a = withScheduleChecks({ checks: [], summary: { block: 1, warn: 0, info: 0 } }, report);
  assert.deepEqual(a.summary, { block: 4, warn: 1, info: 0 });
  assert.equal(withScheduleChecks({ checks: [], summary: { block: 0, warn: 0, info: 0 } }, null).checks.length, 0);
});
