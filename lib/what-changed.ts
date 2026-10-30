// "What changed" since John last decided on a piece's media: the agent's own summary, the notes it answered, what is
// provably unchanged (input hashes recorded at stage time), and jump points into the video. Built from evidence, not
// only from the agent's claims: "unchanged" is only ever said when both versions recorded the same input hash. Pure.
import type { FeedbackItem, PieceAsset } from "./season-review";
import type { ReviewPoint } from "./story";

export type JohnDecision = { stage: string; decision: string; assets: Array<{ asset_id: string; sha256: string; revision?: number }>; decided_at: string };

export type WhatChanged = {
  /** The version John last decided on (or commented on), e.g. "v1.3". Null when there is nothing newer. */
  since: { label: string; revision: number; why: string } | null;
  /** The agent's "what changed" for each newer version, oldest first. */
  summary: Array<{ label: string; text: string }>;
  /** Notes on earlier versions that the agent answered. */
  addressed: Array<{ body: string; resolution: string }>;
  /** Inputs identical to the decided version: "Edit (keep.json)", "Dialogue audio". */
  unchanged: string[];
  /** Points to jump to in the latest version. */
  points: ReviewPoint[];
};

/** Input names (manifest `inputs:` keys written by the clip scripts) as John reads them. */
export const INPUT_LABEL: Record<string, string> = {
  keep: "Edit (keep.json)", dialogue: "Dialogue audio", beats: "Motion beats", broll: "B-roll", plan: "B-roll + Motion plan",
  music: "Music", endcard: "End card", captions: "Captions",
};

const stageWord = (s: string) => s.replace(/-/g, " ");

/** What changed in `asset` since John last decided on it (a stage decision bound to its bytes, else his last note on it). */
export function whatChanged(asset: PieceAsset, decisions: JohnDecision[], notes: FeedbackItem[]): WhatChanged {
  const versions = [...asset.versions].sort((a, b) => a.revision - b.revision);
  const latest = versions[versions.length - 1];
  const points = latest?.meta?.review_points ?? [];
  const none: WhatChanged = { since: null, summary: [], addressed: [], unchanged: [], points };
  if (!latest) return none;
  // The revision John last looked at: a decision that names this asset, else the newest revision he left a note on.
  const decided = decisions.filter((d) => d.assets.some((a) => a.asset_id === asset.id))
    .sort((a, b) => a.decided_at.localeCompare(b.decided_at)).at(-1);
  const decidedRevision = decided?.assets.find((a) => a.asset_id === asset.id)?.revision;
  const noted = Math.max(0, ...notes.filter((n) => n.asset_id === asset.id && n.revision != null && n.revision < latest.revision).map((n) => n.revision!));
  const base = decidedRevision ?? (noted || undefined);
  if (base == null || base >= latest.revision) return none;
  const baseVersion = versions.filter((v) => v.revision <= base).at(-1);
  if (!baseVersion) return none;
  const why = decided && decidedRevision === base
    ? `your ${stageWord(decided.stage)} ${decided.decision === "approved" ? "approval" : "note"}`
    : "your last note";
  const newer = versions.filter((v) => v.revision > base);
  const summary = newer.filter((v) => v.changes?.trim()).map((v) => ({ label: v.label, text: v.changes!.trim() }));
  const addressed = notes.filter((n) => n.asset_id === asset.id && n.resolved_at && (n.revision ?? 0) <= base && (n.revision ?? 0) < latest.revision)
    .map((n) => ({ body: n.body, resolution: n.resolution }));
  const before = baseVersion.meta?.inputs ?? {}, after = latest.meta?.inputs ?? {};
  const unchanged = Object.keys(after).filter((k) => before[k] && before[k] === after[k]).map((k) => INPUT_LABEL[k] ?? k);
  return { since: { label: baseVersion.label, revision: baseVersion.revision, why }, summary, addressed, unchanged, points };
}

/** "0:09" for a jump chip. */
export const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
