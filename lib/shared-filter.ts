// The /content filters applied to shared pieces (review #147 B3): the same status words as the legacy cards, so an
// approved shared piece never sits under "Needs approval" and the toolbar counts every card on screen. Pure.
import type { PieceReviewSnapshot } from "./piece-review";
import type { Filters, StatusFilter } from "./season-review";

/** What the filters read about a shared piece besides its snapshot. */
export type SharedFacts = { title: string; series: string | null; pillar: string | null; notes: string[]; coverStatuses?: string[] };

/**
 * The status filters a shared piece is under. A part waiting on John is Needs approval; one sent back is Needs changes;
 * an accepted-with-note fix (a shared fix or a legacy accepted note still to assign) is Waiting for fix; Approved needs
 * both parts approved and no fix open. A shared piece has no "new version" state.
 */
export function sharedStatuses(s: Pick<PieceReviewSnapshot, "text" | "video" | "fixes" | "legacyFixes">, coverStatuses: string[] = []): StatusFilter[] {
  const parts = [s.text.status, s.video.status, ...coverStatuses.map((s) => s === "rejected" ? "changes" : s)];
  const out: StatusFilter[] = [];
  if (parts.includes("pending")) out.push("needs-approval");
  if (parts.includes("changes")) out.push("needs-changes");
  if (parts.includes("fixing") || s.fixes.length || s.legacyFixes.length) out.push("waiting-fix");
  if (parts.every((p) => p === "approved") && !s.fixes.length && !s.legacyFixes.length) out.push("approved");
  return out;
}

/** The stage filter's key for a shared piece: its video's stage, "final" at the final, "approved" once both are. */
export function sharedStageKey(s: Pick<PieceReviewSnapshot, "text" | "video">): string {
  if (s.text.status === "approved" && s.video.status === "approved") return "approved";
  return s.video.asset.stage ?? "final";
}

/** True when the shared piece passes every filter the legacy cards pass: piece, series, pillar, stage, platform, status, search. */
export function sharedMatches(s: PieceReviewSnapshot, f: Filters, facts: SharedFacts): boolean {
  if (f.piece && s.storyId !== f.piece) return false;
  if (f.series && facts.series !== f.series) return false;
  if (f.pillar && facts.pillar !== f.pillar) return false;
  if (f.stage && sharedStageKey(s) !== f.stage) return false;
  if (f.platform && !s.channels.includes(f.platform)) return false;
  if (f.status && !sharedStatuses(s, facts.coverStatuses).includes(f.status)) return false;
  const terms = f.q.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length) {
    const text = [facts.title, s.storyId, facts.pillar ?? "", ...s.channels, s.text.asset.body ?? "", ...facts.notes, ...s.fixes.map((x) => x.note)].join("\n").toLowerCase();
    if (!terms.every((t) => text.includes(t))) return false;
  }
  return true;
}
