// Where a piece is in its pipeline, derived from the stage rows (gtm_story_stages) and what is staged. Pure: no React,
// no database, so the cockpit page, the Story page and the `gtm story stages` CLI all read the same answer.
import { FEATURE_LABEL, FINAL, stageIndex, type Pipeline, type Stage } from "./pipelines";
import { isFinalStage } from "./stage";

export const STAGE_STATUSES = ["todo", "working", "review", "changes", "approved", "done", "skipped", "blocked"] as const;
export type StageStatus = (typeof STAGE_STATUSES)[number];
export const isStageStatus = (v: unknown): v is StageStatus => typeof v === "string" && (STAGE_STATUSES as readonly string[]).includes(v);
const COMPLETE = new Set<StageStatus>(["approved", "done", "skipped"]);
export const isComplete = (s: StageStatus) => COMPLETE.has(s);

export type StageRow = { stage: string; status: StageStatus; note?: string; actor?: string | null; updated_at?: string | null };
export type StageDecision = {
  stage: string; party: "john" | "third_party"; who: string | null; decision: "approved" | "changes" | "reopened";
  note: string; decided_at: string;
};
/** The final stage is decided per platform (text and media), so its state comes from the channel approvals. */
export type FinalState = { staged: boolean; approved: boolean; changes: boolean };
/** A third party who signs off on the final before it may publish (gtm_stories.third_party_who). */
export type ThirdParty = { who: string; open: boolean };

export type StageView = {
  stage: Stage; status: StageStatus; note: string; actor: string | null; updatedAt: string | null;
  /** No row: the status is inferred (an agent step behind a staged later stage is done, an optional one skipped). */
  implicit: boolean;
  /** Something is staged at this stage. */
  staged: boolean;
};

export type PipelineView = {
  pipeline: Pipeline;
  stages: StageView[];
  /** The first stage that is not approved, done or skipped; null once the final is approved. */
  current: StageView | null;
};

/**
 * Every stage's status. A missing row reads as: skipped for an optional stage; done for an agent stage once a later stage
 * has started (something staged there, or a row); todo otherwise. A John gate never passes without its row.
 */
export function pipelineView(pipeline: Pipeline, rows: StageRow[], opts: { stagedStages?: Iterable<string>; final?: FinalState } = {}): PipelineView {
  const staged = new Set(opts.stagedStages ?? []);
  const byKey = new Map(rows.map((r) => [r.stage, r]));
  const started = (i: number) => pipeline.stages.slice(i + 1).some((s) => staged.has(s.key) || (byKey.get(s.key) && byKey.get(s.key)!.status !== "todo"));
  const stages = pipeline.stages.map((stage, i): StageView => {
    const row = byKey.get(stage.key);
    let status: StageStatus;
    let implicit = false;
    if (stage.final && opts.final) {
      const f = opts.final;
      status = f.approved ? "approved" : f.changes ? "changes" : f.staged ? "review" : row?.status && row.status !== "approved" ? row.status : "todo";
    } else if (row) {
      // A stage that used to be John's gate (paper edit, storyboard) can still hold a "review" or "approved" row written
      // before the gates were removed (2026-10-28). It is agent work now: read those rows as done, never as waiting.
      status = stage.gate === "none" && (row.status === "review" || row.status === "approved") ? "done" : row.status;
    }
    else {
      implicit = true;
      status = stage.optional ? "skipped" : stage.gate === "none" && started(i) ? "done" : "todo";
    }
    return { stage, status, note: row?.note ?? "", actor: row?.actor ?? null, updatedAt: row?.updated_at ?? null, implicit, staged: staged.has(stage.key) };
  });
  return { pipeline, stages, current: stages.find((s) => !isComplete(s.status)) ?? null };
}

/** The features still missing from the piece: what the stages after the current one add ("B-roll", "Motion"). */
export function missingFeatures(view: PipelineView): string[] {
  if (!view.current) return [];
  const at = stageIndex(view.pipeline, view.current.stage.key);
  return view.pipeline.stages.slice(at + 1).flatMap((s) => (s.adds ?? []).map((f) => FEATURE_LABEL[f]));
}

/** "Rough cut · no B-roll · no Motion" (with the pipeline's own version label when the asset has one); null at final. */
export function stageBadgeText(view: PipelineView, label?: string | null): string | null {
  const c = view.current;
  if (!c || c.stage.final) return null;
  return [label ? `${c.stage.label} · ${label}` : c.stage.label, ...missingFeatures(view).map((f) => `no ${f}`)].join(" · ");
}

/** `parts`: the open parts it waits on, named ("Substack essay"), when the page knows them. */
export type WaitingOn = { who: "john" | "agent" | "third_party"; label: string; where?: "cockpit"; parts?: string[] };
/** The open parts of a piece at its final, by who has them (lib/season-review.ts openParts). */
export type FinalParts = { john: string[]; fixing: string[]; changes: string[] };

/**
 * Who the piece is waiting on now: John (in /content), the agent that owns the stage, or a third party.
 * At the final, `parts` (the live part states) decides: John only while a part needs his approval; a final whose only
 * open parts are accepted-with-note fixes or sent back waits on the agent (it is not John's turn, 2026-10-17); nothing
 * open is nothing waiting.
 */
export function waitingOn(view: PipelineView, thirdParty?: ThirdParty | null, parts?: FinalParts | null): WaitingOn | null {
  const c = view.current;
  if (!c) return thirdParty?.open ? { who: "third_party", label: thirdParty.who || "the third party" } : null;
  const s = c.stage;
  if (s.final && parts && (c.status === "review" || c.status === "changes")) {
    if (parts.john.length) return { who: "john", label: "John", where: "cockpit", parts: parts.john };
    if (parts.fixing.length) return { who: "agent", label: "the agent (fix)", parts: parts.fixing };
    if (parts.changes.length) return { who: "agent", label: `${s.owner} (changes)`, parts: parts.changes };
    return thirdParty?.open ? { who: "third_party", label: thirdParty.who || "the third party" } : null;
  }
  if (s.gate === "john" && c.status === "review") return { who: "john", label: "John", where: "cockpit" };
  if (c.status === "blocked") return { who: "agent", label: `${s.owner} (blocked)` };
  return { who: "agent", label: s.owner };
}

export type StepNode = {
  /** waiting: a gate ahead of the current stage that already waits on John. */
  key: string; label: string; status: "done" | "current" | "upcoming" | "skipped" | "changes" | "waiting";
  stages: StageView[]; gate: boolean; spends?: string; final: boolean;
};

/** Stepper nodes: agent steps that share a group fold into one node, so a pipeline reads in five to seven nodes. */
export function stepNodes(view: PipelineView): StepNode[] {
  const nodes: StepNode[] = [];
  for (const sv of view.stages) {
    const last = nodes[nodes.length - 1];
    if (sv.stage.group && last && last.stages[0].stage.group === sv.stage.group) { last.stages.push(sv); continue; }
    nodes.push({ key: sv.stage.key, label: sv.stage.group ?? sv.stage.label, status: "upcoming", stages: [sv], gate: sv.stage.gate === "john", spends: sv.stage.spends, final: !!sv.stage.final });
  }
  for (const n of nodes) {
    const current = view.current && n.stages.includes(view.current);
    if (current) n.status = view.current!.status === "changes" ? "changes" : "current";
    else if (n.stages.every((s) => s.status === "skipped")) n.status = "skipped";
    else if (n.stages.every((s) => isComplete(s.status))) n.status = "done";
    else if (n.stages.some((s) => s.status === "review" || s.status === "changes")) n.status = "waiting";
  }
  return nodes;
}

/** True when a stage at or after `key` is complete or underway: staging at `key` then needs --reopen. */
export function isBehind(view: PipelineView, key: string): boolean {
  const at = stageIndex(view.pipeline, key);
  const cur = view.current ? stageIndex(view.pipeline, view.current.stage.key) : view.pipeline.stages.length;
  return at >= 0 && at < cur;
}

/** The stage that the piece's review screen shows media for: the current one, when it is reviewed in the cockpit. */
export function reviewStage(view: PipelineView): Stage | null {
  const c = view.current;
  if (!c) return view.pipeline.stages[view.pipeline.stages.length - 1];
  return c.stage.review === "cockpit" ? c.stage : null;
}

export const FINAL_KEY = FINAL;

/** The stages something is staged at: each media asset's stage (null is final); text alone means the final. */
export function stagedStages(assets: Array<{ kind: string; stage: string | null }>): Set<string> {
  const media = assets.filter((a) => a.kind === "video" || a.kind === "image");
  const out = new Set(media.map((a) => a.stage ?? FINAL));
  if (!media.length && assets.some((a) => a.kind === "copy")) out.add(FINAL);
  return out;
}

/** The final, read from the platform approvals: every row on final assets approved for the current bytes. */
export function finalState(assets: Array<{ id: string; kind: string; stage: string | null; sha256: string }>, channels: Array<{ asset_id: string; status: string; approved_sha256: string | null }>) {
  const posted = assets.filter((a) => a.kind !== "link" && channels.some((c) => c.asset_id === a.id));
  const staged = posted.length > 0 && posted.every((a) => a.kind === "copy" || isFinalStage(a.stage));
  const rows = channels.filter((c) => posted.some((a) => a.id === c.asset_id));
  const approved = staged && rows.length > 0 && rows.every((c) => c.status === "approved" && c.approved_sha256 === posted.find((a) => a.id === c.asset_id)!.sha256);
  return { staged, approved, changes: staged && rows.some((c) => c.status === "rejected") };
}
