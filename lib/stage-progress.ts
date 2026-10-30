// Stage progress from agents and the CLI (service role): what `gtm story stage --stage`, `gtm story progress` and
// `gtm story stages` read and write. John's own decisions in /content go through the owner-checked database functions;
// a John decision recorded here is one he gave outside the cockpit (a rough cut he approved in the terminal), with a note
import type { SupabaseClient } from "@supabase/supabase-js";
import { must } from "./db";
import { FINAL, isFormat, pipelineOf, stageIndex, stageOf, type Pipeline } from "./pipelines";
import { finalState, isBehind, isStageStatus, pipelineView, stagedStages, stepNodes, waitingOn, type PipelineView, type StageDecision, type StageRow, type StageStatus } from "./pipeline-state";
export { finalState, stagedStages };

export type StoryPipelineHead = { id: string; pipeline: string | null; series: string | null; third_party_who: string | null };

export async function loadPipeline(db: SupabaseClient, storyId: string) {
  const story = must(await db.from("gtm_stories").select("id,pipeline,series,third_party_who").eq("id", storyId).maybeSingle(), "story") as StoryPipelineHead | null;
  if (!story) throw new Error(`no Story ${storyId}`);
  const rows = must(await db.from("gtm_story_stages").select("stage,status,note,actor,updated_at").eq("story_id", storyId), "stage rows") as StageRow[];
  const assets = must(await db.from("gtm_story_assets").select("id,kind,stage,sha256,revision").eq("story_id", storyId), "story assets") as Array<{ id: string; kind: string; stage: string | null; sha256: string; revision: number }>;
  const channels = assets.length ? must(await db.from("gtm_story_asset_channels").select("asset_id,channel,status,approved_sha256").in("asset_id", assets.map((a) => a.id)), "channels") as Array<{ asset_id: string; channel: string; status: string; approved_sha256: string | null }> : [];
  const decisions = must(await db.from("gtm_story_stage_decisions").select("stage,party,who,decision,note,decided_at,assets").eq("story_id", storyId).order("decided_at"), "decisions") as Array<StageDecision & { assets: unknown }>;
  const pipeline = pipelineOf(story.pipeline);
  const view = pipelineView(pipeline, rows, { stagedStages: stagedStages(assets), final: finalState(assets, channels) });
  return { story, pipeline, rows, assets, channels, decisions, view };
}

/**
 * After staging media at `stage`: the stage row goes to review (a John gate) or done (agent work), an earlier agent or
 * optional stage without a row is filled in, and a cockpit gate that was never used is recorded as skipped.
 * Staging at a stage the piece is already past needs `reopen`, which returns the later stages to todo.
 */
export function planStageRows(pipeline: Pipeline, view: PipelineView, stage: string, opts: { changed: boolean; reopen: boolean }): { rows: StageRow[]; warnings: string[] } {
  const s = stageOf(pipeline, stage);
  if (!s) throw new Error(`stage "${stage}" is not in the ${pipeline.format} pipeline (${pipeline.stages.map((x) => x.key).join(", ")})`);
  if (isBehind(view, stage) && !opts.reopen && opts.changed) {
    throw new Error(`this piece is past ${s.label} (now at ${view.current?.stage.label ?? "final, approved"}); staging a new ${s.label} would overwrite later work. Pass --reopen if that is what you mean.`);
  }
  const at = stageIndex(pipeline, stage);
  const rows: StageRow[] = [];
  const warnings: string[] = [];
  const now = new Date().toISOString();
  for (const sv of view.stages.slice(0, at)) {
    if (!sv.implicit) continue;
    if (sv.stage.optional) rows.push({ stage: sv.stage.key, status: "skipped", note: `skipped: staged ${s.label}`, actor: "stage", updated_at: now });
    else if (sv.stage.gate === "none") rows.push({ stage: sv.stage.key, status: "done", note: `implied by staging ${s.label}`, actor: "stage", updated_at: now });
    else if (sv.stage.review === "cockpit") rows.push({ stage: sv.stage.key, status: "skipped", note: `never staged; went straight to ${s.label}`, actor: "stage", updated_at: now });
    else warnings.push(`${sv.stage.label} is not approved yet: ${s.label} stays out of /content until John approves it (or his decision is recorded: gtm story progress <id> ${sv.stage.key} approved --note "John approved in the terminal").`);
  }
  for (const sv of view.stages.slice(0, at)) {
    if (!sv.implicit && sv.stage.gate === "john" && sv.status !== "approved" && sv.status !== "skipped") {
      warnings.push(`${sv.stage.label} is ${sv.status}: ${s.label} waits behind it and stays out of /content until John approves it.`);
    }
  }
  if (!s.final) {
    const current = view.stages[at];
    const keep = !opts.changed && (current.status === "approved" || current.status === "done");
    if (!keep) rows.push({ stage: s.key, status: s.gate === "john" ? "review" : "done", note: "", actor: "stage", updated_at: now });
  }
  if (opts.reopen && opts.changed) {
    for (const sv of view.stages.slice(at + 1)) if (!sv.stage.final && sv.status !== "todo") rows.push({ stage: sv.stage.key, status: "todo", note: `reopened: ${s.label} restaged`, actor: "stage", updated_at: now });
  }
  return { rows, warnings };
}

/**
 * `gtm story progress`: an agent reports an agent stage (working, done, skipped, blocked), or records a decision John
 * gave outside the cockpit (approved or changes on a gate, with a note saying so). A cockpit gate is never approved from
 * here: John decides those in /content. The final is never set: it is the platform approvals.
 */
export async function recordProgress(db: SupabaseClient, storyId: string, stage: string, status: string, note = "", actor = "agent") {
  if (!isStageStatus(status)) throw new Error(`status must be one of todo, working, review, changes, approved, done, skipped, blocked`);
  const { story, pipeline } = await loadPipeline(db, storyId);
  if (!isFormat(story.pipeline)) throw new Error(`${storyId} has no pipeline; set pipeline: in its manifest and restage it`);
  const s = stageOf(pipeline, stage);
  if (!s) throw new Error(`stage "${stage}" is not in the ${pipeline.format} pipeline (${pipeline.stages.map((x) => x.key).join(", ")})`);
  if (s.final) throw new Error("the final is approved per platform in /content, not recorded as progress");
  const trimmed = note.trim();
  if (trimmed.length > 2000) throw new Error("--note is limited to 2000 characters");
  if (s.gate === "john") {
    if (s.review === "cockpit" && (status === "approved" || status === "changes")) throw new Error(`${s.label} is John's gate in /content; only he approves it there`);
  } else if (status === "approved" || status === "review" || status === "changes") {
    throw new Error(`${s.label} is agent work with no gate: use working, done, skipped or blocked`);
  }
  must(await db.from("gtm_story_stages").upsert({ story_id: storyId, stage: s.key, status, note: trimmed, actor, updated_at: new Date().toISOString() }), "progress");
  if (s.gate === "john" && (status === "approved" || status === "changes")) {
    must(await db.from("gtm_story_stage_decisions").insert({ story_id: storyId, stage: s.key, party: "john", decision: status, note: trimmed, assets: [] }), "decision");
  }
  return (await loadPipeline(db, storyId)).view;
}

const GLYPH: Record<string, string> = { done: "✓", current: "●", upcoming: "○", skipped: "–", changes: "✕", waiting: "◐" };

/** The pipeline in the terminal: "✓ Paper edit  ● Rough cut (review, waiting on John)  ○ B-roll ...". */
export function formatStages(view: PipelineView, thirdParty?: { who: string; open: boolean } | null): string {
  const lines = stepNodes(view).map((n) => {
    const detail = n.stages.map((s) => `${n.stages.length > 1 ? `${s.stage.label} ` : ""}${s.status}${s.note ? `: ${s.note}` : ""}`).join("; ");
    const gate = n.gate ? " [John, /content]" : "";
    return `${GLYPH[n.status]} ${n.label}${gate}${n.spends ? ` [spends ${n.spends}]` : ""}  ${detail}`;
  });
  const w = waitingOn(view, thirdParty);
  lines.push(w ? `waiting on ${w.label}` : "final approved");
  return lines.join("\n");
}

export type { StageStatus };
