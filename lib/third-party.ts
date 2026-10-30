// What blocks publishing besides John (2026-10-12): a third party's sign-off on the final, and a manual hold.
//
// A third party (example_approver / Example Series) sees the final only, never a rough cut, and until they approve it the piece does not
// publish. It blocks publishing, never a version. The gate is open while the Story names a third party
// (gtm_stories.third_party_who) and no third-party approval in the decision log covers the platform media at their
// current bytes, so a new final version re-opens it. A manual hold (gtm_stories.held_at, the "Pending third-party
// approval" button or `gtm hold`) blocks publishing until it is released. Pure, so the scheduler, the publish gate and the
// cockpit page all read the same answer.
import { isFinalStage } from "./stage";

export type Hold = {
  storyId: string; who: string; note: string;
  /** When a manual hold was set; null for a third party's open gate. */
  heldAt: string | null;
  kind: "hold" | "third_party";
  /** Every platform's media is final, so there is something for the third party to approve. */
  finalStaged: boolean;
};

export type HoldStory = { id: string; hold_who: string | null; hold_note: string | null; held_at: string | null; third_party_who: string | null };
export type HoldAsset = { id: string; story_id: string; kind: string; sha256: string; stage: string | null };
export type DecisionAsset = { asset_id: string; sha256: string; revision?: number };
export type ThirdPartyDecision = { story_id: string; stage: string; party: string; decision: string; assets: DecisionAsset[]; decided_at?: string };

/** "Publishing blocked until example_approver / Example Series approves the final" */
export function blockedUntil(who: string | null | undefined): string {
  return `Publishing blocked until ${who?.trim() || "a third party"} approves the final`;
}

/** The media a Story posts: video and images bound to at least one platform (a plan image is not one). */
export function postMedia(assets: HoldAsset[], boundIds: Set<string>): HoldAsset[] {
  return assets.filter((a) => (a.kind === "video" || a.kind === "image") && boundIds.has(a.id));
}

/**
 * True when the third party's latest decision on the final at its current bytes is an approval. A later "changes" on
 * the same bytes (from their review link, /shared) closes the gate again; a new final needs a new decision.
 */
export function thirdPartyApproved(media: HoldAsset[], decisions: ThirdPartyDecision[]): boolean {
  if (!media.every((m) => isFinalStage(m.stage))) return false;
  const covering = decisions.filter((d) => d.party === "third_party" && d.stage === "final" && d.decision !== "reopened"
    && media.every((m) => d.assets.some((a) => a.asset_id === m.id && a.sha256 === m.sha256)));
  const latest = covering.reduce<ThirdPartyDecision | null>((last, d) => (!last || (d.decided_at ?? "") >= (last.decided_at ?? "") ? d : last), null);
  return latest?.decision === "approved";
}

/** Every Story that may not publish yet because of a hold or a third party's open gate. */
export function storyHolds(stories: HoldStory[], assets: HoldAsset[], boundIds: Set<string>, decisions: ThirdPartyDecision[]): Hold[] {
  const out: Hold[] = [];
  for (const s of stories) {
    const media = postMedia(assets.filter((a) => a.story_id === s.id), boundIds);
    const finalStaged = media.every((m) => isFinalStage(m.stage));
    const who = (s.hold_who?.trim() || s.third_party_who?.trim() || "");
    if (s.held_at) { out.push({ storyId: s.id, who, note: s.hold_note ?? "", heldAt: s.held_at, kind: s.third_party_who ? "third_party" : "hold", finalStaged }); continue; }
    if (s.third_party_who && !thirdPartyApproved(media, decisions.filter((d) => d.story_id === s.id))) {
      out.push({ storyId: s.id, who: s.third_party_who.trim(), note: "", heldAt: null, kind: "third_party", finalStaged });
    }
  }
  return out;
}
