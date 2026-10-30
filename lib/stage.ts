// Content stages, phase 0 (gtm_story_assets.stage). An asset at a stage before the final one (a rough cut) can be
// reviewed and approved, where approval means "the edit is good", but it is never scheduled or published. Null is a
// final (or legacy, single-stage) asset. Pure: imported by the server, the CLI and client components alike.
import { FEATURE_LABEL, PIPELINES, isFormat } from "./pipelines";

export const FINAL_STAGE = "final";
/** Matches the database check on gtm_story_assets.stage. */
export const STAGE_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;

/** A stage that may be scheduled and published: none (legacy) or final. */
export function isFinalStage(stage: string | null | undefined): boolean {
  return stage == null || stage === FINAL_STAGE;
}

/** The media assets (video, image) that are not final yet. Text has its own lane and never has a stage. */
export function nonFinal<A extends { kind: string; stage?: string | null }>(assets: A[]): A[] {
  return assets.filter((a) => (a.kind === "video" || a.kind === "image") && !isFinalStage(a.stage));
}

/** "Rough cut · no B-roll · no Motion" for a non-final stage of a pipeline (a short when none is given); null for a final one. */
export function stageBadge(stage: string | null | undefined, format: string | null = "short"): string | null {
  if (isFinalStage(stage)) return null;
  const pipeline = isFormat(format) ? PIPELINES[format] : PIPELINES.short;
  const at = pipeline.stages.findIndex((s) => s.key === stage);
  if (at < 0) return stage!.replaceAll("-", " ").replace(/^./, (c) => c.toUpperCase());
  const missing = pipeline.stages.slice(at + 1).flatMap((s) => (s.adds ?? []).map((f) => `no ${FEATURE_LABEL[f]}`));
  return [pipeline.stages[at].label, ...missing].join(" · ");
}

/** The earliest non-final stage among a piece's media, in pipeline order, which is what the piece is waiting on. */
export function pieceStage(assets: Array<{ kind: string; stage?: string | null }>, format: string | null = "short"): string | null {
  const order = (isFormat(format) ? PIPELINES[format] : PIPELINES.short).stages.map((s) => s.key);
  const rank = (k: string) => (order.indexOf(k) + 1 || order.length + 1);
  return nonFinal(assets).map((a) => a.stage!).sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

/**
 * A third-party hold blocks publishing, not a version: the third party only ever sees the final cut, never a rough one.
 * "Publishing blocked until example_approver / Example Series approves the final" (John, 2026-10-12: never tied to a version label).
 */
export function holdHeadline(who: string | null | undefined): string {
  return `Publishing blocked until ${who?.trim() || "a third party"} approves the final`;
}

/** The confirmation under the approve button on a non-final asset. */
export const NON_FINAL_APPROVAL = "Approving a stage never schedules; only the final does";

/** Why an item with a non-final asset is not scheduled: "not final: Video 9:16 is a rough cut (rough-cut)". */
export function notFinalReason(assets: Array<{ title: string; stage?: string | null }>): string {
  return `not final: ${assets.map((a) => `${a.title} is at stage ${a.stage}`).join(", ")}; only a final cut is scheduled`;
}
