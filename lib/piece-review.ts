// Server-owned shared review contract. Every decision returns the state actually persisted.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { StoryAsset } from "./story";
import { must } from "./db";
import { readPages } from "./db-read";
import { loadPieceDeliveries } from "./piece-delivery";
import { reviewEligibility } from "./piece-eligibility";
export type SharedPart = "text" | "video";
export type SharedDecision = "pending" | "approved" | "changes" | "fixing";
export type SharedAsset = {
  asset: StoryAsset;
  fingerprint: string;
  status: SharedDecision;
  decidedAt: string | null;
};
export type SharedFix = {
  id: string;
  part: SharedPart;
  asset_id: string;
  feedback_id: string | null;
  note: string;
  base_revision: number;
  base_asset: StoryAsset;
  created_at: string;
};
export type DeliverySummary = {
  id: string;
  channel: string;
  state: string;
  date: string;
  time: string;
  url: string | null;
  error: string | null;
  textRevision: number | null;
  videoRevision: number | null;
  legacy: boolean;
  /** The provider post, once one is known: an unsent delivery (none) can be released. */
  providerId?: string | null;
};
export type PieceReviewSnapshot = {
  deliveries?: DeliverySummary[];
  storyId: string;
  channels: string[];
  text: SharedAsset;
  video: SharedAsset;
  fixes: SharedFix[];
  legacyFixes: Array<{
    id: string;
    asset_id: string;
    body: string;
    revision: number | null;
  }>;
  blockers: string[];
  ready: boolean;
  dispatchEnabled: boolean;
};
export type SharedCandidate = { asset: StoryAsset; fingerprint: string };

/** The platforms a shared piece can publish to (gtm_piece_reviews.channels). Newsletter and website stay legacy. */
export const SHARED_CHANNELS = ["linkedin", "instagram", "youtube"] as const;
/**
 * The channels of a shared piece: those declared on its canonical text and video, shared platforms only, in platform
 * order (LinkedIn, Instagram, YouTube). The one rule for configuring a review and for checking a restage against it, so
 * a Substack companion on the copy never reads as drift (review #145 N3).
 */
export function sharedChannels(assets: Array<{ id: string; channels: string[] }>, canonical: string[]): string[] {
  const declared = new Set(assets.filter((a) => canonical.includes(a.id)).flatMap((a) => a.channels));
  return SHARED_CHANNELS.filter((c) => declared.has(c));
}
/** Same channels, whatever order each side lists them in. */
export const sameChannels = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

export type SharedDeliveryState = { ok: true } | { ok: false; reason: string };
/**
 * Whether a shared piece can be published from this deployment: this build has the shared dispatcher, so it is ready
 * once the delivery ledger (brand.example.com #221, with the per-channel attempt columns this build records) is in the
 * database. A missing table or column means the website migration is not applied yet: staging with `--shared` and
 * adopting in /content stay off, and shared cards say why.
 */
export async function sharedDeliveryInstalled(db: SupabaseClient): Promise<SharedDeliveryState> {
  const { error } = await db.from("gtm_piece_delivery_attempts").select("id,story_id,channel,calendar_id,posts,last_posted_at", { head: true, count: "exact" }).limit(1);
  if (!error) return { ok: true };
  if (/PGRST205|42P01|42703|does not exist|Could not find/i.test(`${error.code ?? ""} ${error.message}`)) return { ok: false, reason: "the shared delivery schema (brand.example.com #221) is not applied to this database" };
  throw new Error(`shared delivery check: ${error.message}`);
}
export async function loadPieceReview(
  db: SupabaseClient,
  storyId: string,
): Promise<PieceReviewSnapshot | null> {
  const s = must(
    await db.rpc("gtm_piece_snapshot", { p_story_id: storyId }),
    "shared review",
  ) as PieceReviewSnapshot | null;
  return s ? hydrateReview(db, s) : null;
}
export async function pieceCandidates(
  db: SupabaseClient,
  storyId: string,
): Promise<SharedCandidate[]> {
  return must(
    await db.rpc("gtm_piece_candidates", { p_story_id: storyId }),
    "piece candidates",
  ) as SharedCandidate[];
}
export async function configurePieceReview(
  db: SupabaseClient,
  input: {
    storyId: string;
    text: SharedCandidate;
    video: SharedCandidate;
    channels: string[];
  },
): Promise<PieceReviewSnapshot> {
  return hydrateReview(
    db,
    must(
      await db.rpc("gtm_configure_piece_review", {
        p_story_id: input.storyId,
        p_text_asset_id: input.text.asset.id,
        p_video_asset_id: input.video.asset.id,
        p_channels: input.channels,
        p_expected: {
          text: input.text.fingerprint,
          video: input.video.fingerprint,
        },
      }),
      "select shared assets",
    ) as PieceReviewSnapshot,
  );
}
export async function decidePiecePart(
  db: SupabaseClient,
  input: {
    storyId: string;
    part: SharedPart;
    decision: SharedDecision;
    note: string;
    fingerprint: string;
    revision: number;
  },
): Promise<PieceReviewSnapshot> {
  return hydrateReview(
    db,
    must(
      await db.rpc("gtm_decide_piece_part", {
        p_story_id: input.storyId,
        p_part: input.part,
        p_decision: input.decision,
        p_note: input.note,
        p_expected_fingerprint: input.fingerprint,
        p_expected_revision: input.revision,
      }),
      "shared decision",
    ) as PieceReviewSnapshot,
  );
}
export async function savePieceText(
  db: SupabaseClient,
  input: {
    storyId: string;
    body: string;
    fingerprint: string;
    revision: number;
  },
): Promise<PieceReviewSnapshot> {
  return hydrateReview(
    db,
    must(
      await db.rpc("gtm_save_piece_text", {
        p_story_id: input.storyId,
        p_body: input.body,
        p_expected_fingerprint: input.fingerprint,
        p_expected_revision: input.revision,
      }),
      "save shared text",
    ) as PieceReviewSnapshot,
  );
}
export async function completePieceFix(
  db: SupabaseClient,
  input: {
    fixId: string;
    fingerprint: string;
    revision: number;
    actor: string;
    verification: string;
    onlyAuthorisedChanges: boolean;
  },
): Promise<PieceReviewSnapshot> {
  return hydrateReview(
    db,
    must(
      await db.rpc("gtm_complete_piece_fix", {
        p_fix_id: input.fixId,
        p_expected_fingerprint: input.fingerprint,
        p_expected_revision: input.revision,
        p_actor: input.actor,
        p_verification: input.verification,
        p_only_authorised_changes: input.onlyAuthorisedChanges,
      }),
      "complete authorised fix",
    ) as PieceReviewSnapshot,
  );
}

async function hydrateReview(
  db: SupabaseClient,
  s: PieceReviewSnapshot,
): Promise<PieceReviewSnapshot> {
  const rows = await loadPieceDeliveries(db, s.storyId);
  const deliveries: DeliverySummary[] = rows.map((d) => ({
    id: d.id,
    channel: d.channel,
    state: d.state,
    date: d.slot_date,
    time: d.slot_time.slice(0, 5),
    url: d.publication_url,
    error: d.error,
    textRevision: d.review_snapshot.text.asset.revision,
    videoRevision: d.review_snapshot.video.asset.revision,
    legacy: false,
    providerId: d.provider_id,
  }));
  const legacy = await readPages<{
    id: string;
    channels: string[];
    status: string;
    date: string;
    time: string | null;
    urls: Record<string, string>;
  }>(
    (from, to) =>
      db
        .from("gtm_content_items")
        .select("id,channels,status,date,time,urls")
        .eq("story_id", s.storyId)
        .or("zernio_post_id.not.is.null,status.in.(scheduled,published)")
        .order("id")
        .range(from, to),
    "existing channel deliveries",
  );
  for (const r of legacy.filter(
    (r) => !rows.some((d) => d.calendar_id === r.id),
  ))
    for (const channel of r.channels.filter((c) => s.channels.includes(c)))
      deliveries.push({
        id: r.id,
        channel,
        state: r.status,
        date: r.date,
        time: r.time ?? "",
        url: r.urls?.[channel] ?? null,
        // Kept: the existing legacy post (info). Only a failed one reads as an error on the card (review #151 F2).
        error: r.status === "failed" ? "The existing legacy post failed; check it in the delivery report" : null,
        textRevision: null,
        videoRevision: null,
        legacy: true,
      });
  return { ...reviewEligibility(s), deliveries };
}

/**
 * Refuses `gtm story resolve` on a note that is a shared fix authorisation (an open gtm_piece_fixes row points at it,
 * review #147 F1): closing it there would leave the fix open and the piece blocked with no note under it. A plain change
 * request on a shared piece resolves as usual.
 */
export async function assertNotSharedFix(db: SupabaseClient, noteId: string): Promise<void> {
  const open = must(await db.from("gtm_piece_fixes").select("id,story_id").eq("feedback_id", noteId).eq("status", "open").limit(1), "shared fix check") as { id: string; story_id: string }[];
  if (open.length) throw new Error(`${noteId} is a shared fix authorisation (fix ${open[0].id} on ${open[0].story_id}): apply the fix, stage it, then run gtm piece complete-fix ${open[0].id} --fingerprint <verified> --revision <n> --actor <worker> --verification "<what was checked>" --only-authorised-changes`);
}
