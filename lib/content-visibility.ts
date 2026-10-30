// What /content shows (John, 2026-10-13): "I only want to see /content that I've directed to go there... why do I see the
// v1.0 that was PRE-FEEDBACK?" A staged final is hidden from /content while it is not the version John is waiting for:
//
//   changes    John's last verdict was "Request changes" and no newer version has been staged since (a restage resets
//              the platform rows, and resolving the note returns them to "needs approval", so a row still at "rejected"
//              means nothing newer has landed). This is per part: a video he sent back leaves, its platforms' text stays;
//              a card goes when every part of it was sent back, and the piece goes when every card did.
//   stale      John approved an earlier gate (the storyboard in /studio, a rough cut) AFTER the staged final was made, so
//              the final predates his direction. It stays hidden until a final staged after that approval exists.
//   withdrawn  An agent withdrew it (`gtm story withdraw <id> --note`, stored as the final's stage row at "working"),
//              and no final has been staged since.
//
// Only staged finals are judged: a rough cut under review is John's to see. Nothing here changes an approval, a note or a
// schedule; it decides what the page lists. Pure, so the page, the CLI (`gtm story hidden`) and the tests agree.
import { FINAL } from "./pipelines";

export type HiddenReason = "changes" | "stale" | "withdrawn";
export type Hidden = { storyId: string; reason: HiddenReason; detail: string };

export type VisibilityAsset = { id: string; kind: string; stage: string | null; revision: number };
export type VisibilityVersion = { asset_id: string; revision: number; created_at: string };
export type VisibilityRow = { asset_id: string; channel: string; status: string };
export type VisibilityStage = { stage: string; status: string; note?: string | null; updated_at?: string | null };
/** `assets` is what the decision was bound to: Story assets at a revision (a rough cut) or a storyboard version. */
export type VisibilityDecision = { stage: string; party: string; decision: string; decided_at: string; assets?: unknown };

export type VisibilityInput = {
  storyId: string;
  /** Every asset bound to a platform is final (or text): the piece is at its final. */
  finalStaged: boolean;
  assets: VisibilityAsset[];
  /** Platform rows of the Story's assets. */
  rows: VisibilityRow[];
  versions: VisibilityVersion[];
  stages: VisibilityStage[];
  decisions: VisibilityDecision[];
};

const MEDIA = new Set(["video", "image"]);

/**
 * When the final on screen was staged: the newest current version of its media (bound to a platform), or of its text
 * when the post has no media. Null when no version row exists.
 */
export function finalStagedAt(input: Pick<VisibilityInput, "assets" | "rows" | "versions">): string | null {
  const bound = input.assets.filter((a) => a.kind !== "link" && input.rows.some((r) => r.asset_id === a.id));
  const media = bound.filter((a) => MEDIA.has(a.kind));
  const pool = media.length ? media : bound;
  const times = pool.flatMap((a) => input.versions.filter((v) => v.asset_id === a.id && v.revision === a.revision).map((v) => v.created_at));
  return times.sort().at(-1) ?? null;
}

const ts = (x: string) => Date.parse(x);

/**
 * A decision bound to Story assets at an older revision than they are now (John approved the rough cut, v1; the final is
 * v2 of the same file) is already behind the staged final, whatever the clocks say: the final was made from it.
 */
function supersededBy(d: VisibilityDecision, assets: VisibilityAsset[]): boolean {
  const bound = (Array.isArray(d.assets) ? d.assets : []) as Array<{ asset_id?: unknown; revision?: unknown }>;
  return bound.some((b) => {
    const a = typeof b.asset_id === "string" ? assets.find((x) => x.id === b.asset_id) : undefined;
    return !!a && typeof b.revision === "number" && b.revision < a.revision;
  });
}

/**
 * The parts John sent back at the final ("Request changes") with nothing newer staged, as `<asset_id>|<channel>`. Each
 * part leaves on its own (John, 2026-10-13: "I should be able to request changes to the video... and then make changes
 * to the text"): a video sent back leaves its cards, their text stays to review and edit.
 */
export function partsSentBack(input: Pick<VisibilityInput, "finalStaged" | "rows">): Set<string> {
  return new Set(input.finalStaged ? input.rows.filter((r) => r.status === "rejected").map((r) => `${r.asset_id}|${r.channel}`) : []);
}

/** The platforms whose every part was sent back: their cards are left out. */
export function channelsSentBack(input: Pick<VisibilityInput, "finalStaged" | "rows">): Set<string> {
  if (!input.finalStaged) return new Set();
  const channels = new Set(input.rows.map((r) => r.channel));
  return new Set([...channels].filter((c) => input.rows.every((r) => r.channel !== c || r.status === "rejected")));
}

/**
 * Why this piece is hidden from /content, or null when John should see it. `cards` are the platforms the piece has a
 * card for; a piece whose every card was sent back is hidden as "changes".
 */
export function hiddenFromContent(input: VisibilityInput, cards: string[] = []): Hidden | null {
  if (!input.finalStaged) return null;
  const { storyId } = input;
  const stagedAt = finalStagedAt(input);
  const withdrawn = input.stages.find((s) => s.stage === FINAL && s.status === "working" && s.updated_at);
  if (withdrawn && (!stagedAt || ts(withdrawn.updated_at!) >= ts(stagedAt))) {
    return { storyId, reason: "withdrawn", detail: `withdrawn by the agent${withdrawn.note ? `: ${withdrawn.note}` : ""}; it comes back when the new final is staged` };
  }
  const upstream = input.decisions
    .filter((d) => d.party === "john" && d.decision === "approved" && d.stage !== FINAL && !supersededBy(d, input.assets))
    .sort((a, b) => ts(a.decided_at) - ts(b.decided_at)).at(-1);
  if (upstream && stagedAt && ts(upstream.decided_at) > ts(stagedAt)) {
    return { storyId, reason: "stale", detail: `staged before you approved the ${upstream.stage.replace(/-/g, " ")}; it comes back when a final made from it is staged` };
  }
  const back = channelsSentBack(input);
  if (cards.length && cards.every((c) => back.has(c))) {
    return { storyId, reason: "changes", detail: "you asked for changes; it comes back when the new version is staged" };
  }
  return null;
}
