// Presentation never upgrades a backend decision. Accepted notes are explicitly waiting for a fix.
import { coveredByFixNote, parseFixNote } from "./approve-note";
import type { StoryAsset, StoryChannel } from "./story";

export function displayReviews(assets: Pick<StoryAsset, "id" | "sha256">[], rows: StoryChannel[], feedback: Array<{ body: string; resolved_at: string | null }>): StoryChannel[] {
  const hashes = new Map(assets.map((a) => [a.id, a.sha256]));
  const fixes = feedback.filter((f) => !f.resolved_at).flatMap((f) => { const n = parseFixNote(f.body); return n ? [n] : []; });
  // A row John sent back stays sent back, even under an open fix note: "Request changes" is his newer decision.
  return rows.map((r) => r.status !== "rejected" && (coveredByFixNote(fixes, r.asset_id, r.channel) || (r.status === "approved" && r.approved_sha256 !== hashes.get(r.asset_id)))
    ? { ...r, status: "pending" } : r);
}
