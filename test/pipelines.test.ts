import test from "node:test";
import assert from "node:assert/strict";
import { FINAL, LEGACY, PIPELINES, finalStage, pipelineOf, surfaceOf, validatePipeline, validatePipelines, type Pipeline } from "../lib/pipelines";
import { formatStages, planStageRows } from "../lib/stage-progress";
import { isBehind, missingFeatures, pipelineView, reviewStage, stageBadgeText, stepNodes, waitingOn, type StageRow } from "../lib/pipeline-state";

const short = PIPELINES.short;
const row = (stage: string, status: StageRow["status"]): StageRow => ({ stage, status });

test("every pipeline is valid: one final stage, last, keyed final, John's, reviewed in the cockpit", () => {
  assert.deepEqual(validatePipelines(), []);
  for (const p of [...Object.values(PIPELINES), LEGACY]) assert.equal(finalStage(p).key, FINAL);
});

test("validatePipeline catches a broken definition", () => {
  const bad: Pipeline = { format: "short", label: "Bad", stages: [
    { key: "x", label: "X", owner: "a", does: "", gate: "none", review: "none", spends: "credits" },
    { key: "x", label: "X", owner: "a", does: "", gate: "john", review: "none" },
  ] };
  const problems = validatePipeline(bad);
  assert.ok(problems.some((p) => /duplicate/.test(p)));
  assert.ok(problems.some((p) => /spends needs a John gate/.test(p)));
  assert.ok(problems.some((p) => /exactly one final/.test(p)));
  assert.ok(problems.some((p) => /place to review/.test(p)));
});

test("John's gates: only the posts (rough cut, final) wait on him, both in /content; there are no plan or storyboard gates", () => {
  const gates = short.stages.filter((s) => s.gate === "john").map((s) => [s.key, s.review, !!s.spends]);
  assert.deepEqual(gates, [["rough-cut", "cockpit", false], [FINAL, "cockpit", false]]);
  const all = Object.values(PIPELINES).flatMap((p) => p.stages.map((s) => ({ p: p.format, ...s })));
  assert.ok(all.every((s) => s.review !== ("studio" as string) && surfaceOf(s) !== ("studio" as string)), "nothing is reviewed in /studio");
  assert.deepEqual(all.filter((s) => ["storyboard", "enhance-plan", "slide-copy"].includes(s.key)), [], "the storyboard-era stages are gone");
  assert.deepEqual(PIPELINES.video.stages.map((s) => s.key), ["motion", "packaging", FINAL], "a video goes from build to the final review");
  // A third party sees the final only: no pipeline has a third-party stage.
  for (const p of Object.values(PIPELINES)) assert.ok(!p.stages.some((s) => /third/.test(s.key)), p.format);
});

test("a short at rough cut reads exactly 'Rough cut · no B-roll · no Motion' and waits on John in the cockpit", () => {
  const view = pipelineView(short, [row("paper-edit", "done"), row("rough-cut", "review")], { stagedStages: ["rough-cut"] });
  assert.equal(view.current?.stage.key, "rough-cut");
  assert.equal(stageBadgeText(view), "Rough cut · no B-roll · no Motion");
  assert.equal(stageBadgeText(view, "v4"), "Rough cut · v4 · no B-roll · no Motion");
  assert.deepEqual(waitingOn(view), { who: "john", label: "John", where: "cockpit" });
  assert.deepEqual(missingFeatures(view), ["B-roll", "Motion"]);
});

test("a paper edit is agent work: nothing waits on John until the rough cut", () => {
  const view = pipelineView(short, [], {});
  assert.equal(view.current?.stage.key, "paper-edit");
  assert.deepEqual(waitingOn(view), { who: "agent", label: "vibrana-podcast-clips" });
  assert.equal(reviewStage(view), null);
});

test("agent stages behind a started later stage read as done; an optional stage as skipped; a John gate never passes without its row", () => {
  const view = pipelineView(short, [row("rough-cut", "approved"), row("motion", "working")]);
  assert.deepEqual(view.stages.map((s) => [s.stage.key, s.status, s.implicit]).slice(2, 5), [["broll", "done", true], ["motion", "working", false], ["finish", "todo", true]]);
  assert.equal(view.current?.stage.key, "motion");
  assert.deepEqual(waitingOn(view), { who: "agent", label: "vibrana-motion" });
  const carousel = pipelineView(PIPELINES.carousel, [], { stagedStages: [FINAL], final: { staged: true, approved: false, changes: false } });
  assert.deepEqual(carousel.stages.map((s) => s.status), ["done", "review"]);
  const video = pipelineView(PIPELINES.video, [], { stagedStages: [FINAL], final: { staged: true, approved: false, changes: false } });
  assert.equal(video.current?.stage.key, FINAL, "a staged video final is the review, with no gate in front of it");
});

test("final is derived from the platform approvals; once approved nothing is current and a third party may still be waited on", () => {
  const rows = short.stages.filter((s) => !s.final).map((s) => row(s.key, s.gate === "john" ? "approved" : "done"));
  const review = pipelineView(short, rows, { final: { staged: true, approved: false, changes: false } });
  assert.equal(review.current?.stage.key, FINAL);
  assert.equal(stageBadgeText(review), null, "no stage badge at final");
  const done = pipelineView(short, rows, { final: { staged: true, approved: true, changes: false } });
  assert.equal(done.current, null);
  assert.deepEqual(waitingOn(done, { who: "example_approver / Example Series", open: true }), { who: "third_party", label: "example_approver / Example Series" });
  assert.equal(waitingOn(done, { who: "example_approver / Example Series", open: false }), null);
});

test("the episode stepper folds Assembly and Master + package into one node each", () => {
  const view = pipelineView(PIPELINES.episode, [row("ingest", "done"), row("paper-edit", "done"), row("audio", "done"), row("picture", "working")]);
  const nodes = stepNodes(view);
  assert.deepEqual(nodes.map((n) => [n.label, n.status]), [
    ["Ingest", "done"], ["Paper edit", "done"], ["Assembly", "current"], ["Review copy", "upcoming"], ["Master + package", "upcoming"], ["Final", "upcoming"],
  ]);
  assert.equal(nodes.find((n) => n.label === "Assembly")!.stages.length, 3);
});

test("staging at a stage the piece is already past needs --reopen", () => {
  const view = pipelineView(short, [row("rough-cut", "approved"), row("broll", "working")]);
  assert.equal(isBehind(view, "rough-cut"), true);
  assert.equal(isBehind(view, "broll"), false);
  assert.equal(isBehind(view, FINAL), false);
});

test("a Story without a pipeline is one final stage, as before", () => {
  const view = pipelineView(pipelineOf(null), [], { final: { staged: true, approved: false, changes: false } });
  assert.deepEqual(view.stages.map((s) => s.stage.key), [FINAL]);
  assert.equal(view.current?.stage.key, FINAL);
  assert.equal(stageBadgeText(view), null);
});

test("staging a rough cut fills in the paper edit and moves the cut to review; there is no plan gate to wait behind", () => {
  const ok = planStageRows(short, pipelineView(short, []), "rough-cut", { changed: true, reopen: false });
  assert.deepEqual(ok.rows.map((r) => [r.stage, r.status]), [["paper-edit", "done"], ["rough-cut", "review"]]);
  assert.deepEqual(ok.warnings, []);
  assert.throws(() => planStageRows(short, pipelineView(short, []), "colour", { changed: true, reopen: false }), /not in the short pipeline/);
});

test("staging the final fills in the agent stages behind it, with nothing held back", () => {
  const plan = planStageRows(PIPELINES.video, pipelineView(PIPELINES.video, []), FINAL, { changed: true, reopen: false });
  assert.deepEqual(plan.rows.map((r) => [r.stage, r.status]), [["motion", "done"], ["packaging", "done"]]);
  assert.deepEqual(plan.warnings, []);
  const carousel = planStageRows(PIPELINES.carousel, pipelineView(PIPELINES.carousel, []), FINAL, { changed: true, reopen: false });
  assert.deepEqual(carousel.rows.map((r) => [r.stage, r.status]), [["copy", "done"]]);
});

test("restaging a stage the piece is past needs --reopen, which returns the later stages to todo; unchanged bytes are never refused", () => {
  const rows = [row("paper-edit", "done"), row("rough-cut", "approved"), row("broll", "working")];
  const view = pipelineView(short, rows);
  assert.throws(() => planStageRows(short, view, "rough-cut", { changed: true, reopen: false }), /past Rough cut .*--reopen/);
  assert.deepEqual(planStageRows(short, view, "rough-cut", { changed: false, reopen: false }).rows, [], "an unchanged approved rough cut stays approved");
  const reopened = planStageRows(short, view, "rough-cut", { changed: true, reopen: true });
  assert.deepEqual(reopened.rows.map((r) => [r.stage, r.status]), [["rough-cut", "review"], ["broll", "todo"]]);
});

test("the stepper and CLI read the same pipeline", () => {
  const view = pipelineView(short, [row("paper-edit", "done"), row("rough-cut", "review")], { stagedStages: ["rough-cut"] });
  const text = formatStages(view, { who: "example_approver / Example Series", open: true });
  assert.match(text, /^✓ Paper edit {2}/m);
  assert.match(text, /^● Rough cut \[John, \/content\]  review$/m);
  assert.doesNotMatch(text, /studio/i);
  assert.match(text, /waiting on John$/);
});
