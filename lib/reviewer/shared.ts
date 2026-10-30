// What a third party sees at /shared: their pieces (gtm_stories.third_party_who), the final media only, the captions
// each platform posts with it, their own notes and their decision. Never John's notes, a rough cut, another party's
// piece or anything else in the cockpit. The page loads with the service client after the database has named the
// caller's parties (gtm_reviewer_parties), so this module is the only thing between the data and the reviewer: keep
// every filter here and covered by test/reviewer.test.ts.
import type { SupabaseClient } from "@supabase/supabase-js";
import { BUCKET } from "../review";
import { findAgentNotes } from "../copy-guard";
import { frontmatterData, splitFrontmatter } from "../frontmatter";
import { parsePieceTitle } from "../season";
import { isFinalStage } from "../stage";
import type { StoryAsset, StoryChannel } from "../story";
import { readPages, readChunks } from "../db-read";
import { must } from "../db";
import { signedUrls } from "../sign-urls";

export type SharedNote = {
  id: string;
  body: string;
  createdAt: string;
  label: string | null;
  kind: "changes" | "note";
};
export type SharedDecision = "pending" | "approved" | "changes";
/** One thing a third party sees: the video, an image, or the episode's listing (its copy). They decide on the video and images only (John, 2026-10-15); the listing is shown so they know what it goes out with. */
export type SharedAsset = {
  id: string;
  kind: "video" | "image" | "copy";
  title: string;
  sha256: string;
  revision: number;
  label: string | null;
  channels: string[];
  /** The video and images are decided on; a listing is shown for information. */
  reviewable: boolean;
  decision: SharedDecision;
  /** They decided on an earlier version: these bytes are new to them. */
  newVersion: boolean;
  /** Their own notes and change requests on this asset, oldest first. */
  notes: SharedNote[];
  src: string | null;
  poster: string | null;
  /** copy only: what the platform will show. */
  listing: {
    title: string | null;
    text: string;
    thumbnail: string | null;
  } | null;
};
export type SharedPiece = {
  storyId: string;
  name: string;
  party: string;
  /** The full episode, or one of the shorts cut from it. */
  format: "episode" | "short";
  /** "final" when every platform's media is final; "in-production" before that (nothing is shown); "empty" before anything is staged. */
  state: "final" | "in-production" | "empty";
  assets: SharedAsset[];
  /** approved only when every asset is approved on its current bytes; changes when any asset awaits a new version. */
  decision: SharedDecision;
};

export type AssetDecisionRow = {
  id: string;
  story_id: string;
  asset_id: string;
  asset_sha256: string;
  revision: number;
  decision: string;
  note: string;
  decided_at: string;
};
type Version = {
  asset_id: string;
  revision: number;
  metadata: { label?: string } | null;
};
export type SharedInput = {
  parties: string[];
  shared?: {
    storyId: string;
    textId: string;
    videoId: string;
    channels: string[];
    videoApproved: boolean;
    textApproved: boolean;
  }[];
  stories: Array<{
    id: string;
    title: string;
    third_party_who: string | null;
    pipeline?: string | null;
  }>;
  assets: StoryAsset[];
  channels: StoryChannel[];
  decisions: AssetDecisionRow[];
  versions: Version[];
  url: (path: string | null | undefined) => string | null;
};

const ORDER = ["youtube", "linkedin", "instagram"];
const KIND_ORDER = { video: 0, image: 1, copy: 2 } as const;

/** Pure: the pieces one reviewer may see, built from rows the loader already narrowed to their parties. */
export function buildSharedPieces(input: SharedInput): SharedPiece[] {
  const parties = new Set(input.parties.map((p) => p.trim()));
  return (
    input.stories
      .filter((s) => s.third_party_who && parties.has(s.third_party_who.trim()))
      // The full episode first (it is what they were sent), then the shorts in id order.
      .sort(
        (a, b) =>
          Number(b.pipeline === "episode") - Number(a.pipeline === "episode") ||
          a.id.localeCompare(b.id),
      )
      .map((story): SharedPiece => {
        const party = story.third_party_who!.trim();
        const shared = input.shared?.find((p) => p.storyId === story.id);
        const own = input.assets.filter(
          (a) =>
            a.story_id === story.id &&
            (!shared || [shared.textId, shared.videoId].includes(a.id)),
        );
        const bound = (a: StoryAsset) =>
          (shared
            ? shared.channels
            : input.channels
                .filter((c) => c.asset_id === a.id)
                .map((c) => c.channel)
          ).sort((x, y) => ORDER.indexOf(x) - ORDER.indexOf(y));
        const media = own.filter(
          (a) => (a.kind === "video" || a.kind === "image") && bound(a).length,
        );
        // A short reaches a third party only once John has approved its YouTube cut (the one 9:16 video every platform posts) on its current bytes.
        const johnApproved = (a: StoryAsset) =>
          shared
            ? shared.videoApproved
            : input.channels.some(
                (c) =>
                  c.asset_id === a.id &&
                  c.channel === "youtube" &&
                  c.status === "approved" &&
                  c.approved_sha256 === a.sha256,
              );
        const isShort = story.pipeline !== "episode";
        const state: SharedPiece["state"] = !media.length
          ? "empty"
          : media.every((m) => isFinalStage(m.stage)) &&
              (!(isShort || shared) || media.every(johnApproved))
            ? "final"
            : "in-production";
        const format =
          story.pipeline === "episode"
            ? ("episode" as const)
            : ("short" as const);
        const base = {
          storyId: story.id,
          name: parsePieceTitle(story.title).name,
          party,
          format,
        };
        if (state !== "final")
          return { ...base, state, assets: [], decision: "pending" };

        const labelOf = (assetId: string, revision: number | null) => {
          const v = input.versions.find(
            (x) => x.asset_id === assetId && x.revision === revision,
          );
          return typeof v?.metadata?.label === "string"
            ? v.metadata.label
            : null;
        };
        const assets: SharedAsset[] = [];
        for (const a of own) {
          const channels = bound(a);
          if (
            !channels.length ||
            (a.kind !== "video" && a.kind !== "image" && a.kind !== "copy")
          )
            continue;
          let listing: SharedAsset["listing"] = null;
          // A short is one 9:16 video for every platform: they watch and approve that, not a post per platform.
          if (
            a.kind === "copy" &&
            (format === "short" || (shared && !shared.textApproved))
          )
            continue;
          if (a.kind === "copy") {
            const { frontmatter, prose } = splitFrontmatter(a.body ?? "");
            // A listing still carrying a note to John is not ready to show anyone outside.
            if (!prose || findAgentNotes(prose).length) continue;
            const meta = frontmatterData(frontmatter);
            const t = (
              typeof meta.youtube_title === "string"
                ? meta.youtube_title
                : typeof meta.title === "string"
                  ? meta.title
                  : ""
            ).trim();
            const thumb = (a.metadata as { thumbnail_path?: string } | null)
              ?.thumbnail_path;
            listing = {
              title: t || null,
              text: prose,
              thumbnail: thumb ? input.url(thumb) : null,
            };
          }
          const rows = input.decisions
            .filter((d) => d.asset_id === a.id)
            .sort((x, y) => x.decided_at.localeCompare(y.decided_at));
          const current = rows
            .filter(
              (d) =>
                (d.decision === "approved" || d.decision === "changes") &&
                d.asset_sha256 === a.sha256 &&
                d.revision === a.revision,
            )
            .at(-1);
          const poster = (a.metadata as { poster_path?: string } | null)
            ?.poster_path;
          assets.push({
            id: a.id,
            kind: a.kind,
            title: a.title,
            sha256: a.sha256,
            revision: a.revision,
            label:
              typeof a.metadata?.label === "string" ? a.metadata.label : null,
            channels,
            reviewable: a.kind !== "copy",
            decision: (current?.decision ?? "pending") as SharedDecision,
            newVersion:
              !current &&
              rows.some(
                (d) => d.decision === "approved" || d.decision === "changes",
              ),
            notes: rows
              .filter(
                (d) =>
                  (d.decision === "changes" || d.decision === "note") &&
                  d.note.trim(),
              )
              .map((d) => ({
                id: d.id,
                body: d.note,
                createdAt: d.decided_at,
                label: labelOf(a.id, d.revision),
                kind: d.decision as "changes" | "note",
              })),
            // A large video (an episode final) plays from its review proxy; their approval binds to the master's sha256 above.
            src: a.kind === "copy" ? null : input.url(playPath(a)),
            poster: poster ? input.url(poster) : null,
            listing,
          });
        }
        assets.sort(
          (x, y) =>
            KIND_ORDER[x.kind] - KIND_ORDER[y.kind] ||
            ORDER.indexOf(x.channels[0]) - ORDER.indexOf(y.channels[0]) ||
            x.id.localeCompare(y.id),
        );
        const judged = assets.filter((a) => a.reviewable);
        const decision: SharedDecision = !judged.length
          ? "pending"
          : judged.every((a) => a.decision === "approved")
            ? "approved"
            : judged.some((a) => a.decision === "changes")
              ? "changes"
              : "pending";
        return { ...base, state, assets, decision };
      })
  );
}

/** What a reviewer's player loads: the review proxy of a large video, else the stored media itself. */
export function playPath(
  a: Pick<StoryAsset, "storage_path" | "metadata">,
): string | null {
  const proxy = (a.metadata as { proxy_path?: unknown } | null)?.proxy_path;
  return typeof proxy === "string" ? proxy : a.storage_path;
}

/** The rows behind a reviewer's /shared page and the storage keys it shows (final media, posters, listing thumbnails). */
async function sharedInput(
  db: SupabaseClient,
  parties: string[],
): Promise<{ input: Omit<SharedInput, "url">; paths: string[] } | null> {
  if (!parties.length) return null;
  // Matched trimmed, as the database functions match it; buildSharedPieces filters again.
  const wantedParties = new Set(parties.map((p) => p.trim()));
  const rows = await readPages<SharedInput["stories"][number]>(
    (from, to) =>
      db
        .from("gtm_stories")
        .select("id,title,third_party_who,pipeline")
        .not("third_party_who", "is", null)
        .order("id")
        .range(from, to),
    "reviewer pieces",
  );
  const stories = rows.filter((s) =>
      wantedParties.has(String(s.third_party_who).trim()),
    ),
    ids = stories.map((s) => s.id);
  if (!ids.length) return null;
  const assets = await readChunks<StoryAsset>(
      ids,
      (chunk, from, to) =>
        db
          .from("gtm_story_assets")
          .select(
            "id,story_id,title,kind,source,sha256,revision,storage_path,body,url,metadata,stage",
          )
          .in("story_id", chunk)
          .order("id")
          .range(from, to),
      "reviewer assets",
    ),
    assetIds = assets.map((a) => a.id);
  const [channels, decisions, versions, canonical] = await Promise.all([
    readChunks<StoryChannel>(
      assetIds,
      (chunk, from, to) =>
        db
          .from("gtm_story_asset_channels")
          .select("asset_id,channel,status,approved_sha256,note")
          .in("asset_id", chunk)
          .order("asset_id")
          .order("channel")
          .range(from, to),
      "reviewer assignments",
    ),
    readChunks<AssetDecisionRow>(
      assetIds,
      (chunk, from, to) =>
        db
          .from("gtm_reviewer_asset_decisions")
          .select(
            "id,story_id,asset_id,asset_sha256,revision,decision,note,decided_at",
          )
          .in("asset_id", chunk)
          .in("party", [...wantedParties])
          .order("id")
          .range(from, to),
      "reviewer decisions",
    ),
    readChunks<Version>(
      assetIds,
      (chunk, from, to) =>
        db
          .from("gtm_story_asset_versions")
          .select("asset_id,revision,metadata")
          .in("asset_id", chunk)
          .order("asset_id")
          .order("revision")
          .range(from, to),
      "reviewer versions",
    ),
    readChunks<{
      story_id: string;
      text_asset_id: string;
      video_asset_id: string;
      channels: string[];
    }>(
      ids,
      (chunk, from, to) =>
        db
          .from("gtm_piece_reviews")
          .select("story_id,text_asset_id,video_asset_id,channels")
          .in("story_id", chunk)
          .order("story_id")
          .range(from, to),
      "canonical reviewer assets",
    ),
  ]);
  const shared: NonNullable<SharedInput["shared"]> = [];
  for (const p of canonical) {
    const s = must(
      await db.rpc("gtm_piece_snapshot", { p_story_id: p.story_id }),
      "canonical review scope",
    ) as { video: { status: string }; text: { status: string } } | null;
    if (!s) throw new Error("Canonical review scope unavailable");
    shared.push({
      storyId: p.story_id,
      textId: p.text_asset_id,
      videoId: p.video_asset_id,
      channels: p.channels,
      videoApproved: s.video.status === "approved",
      textApproved: s.text.status === "approved",
    });
  }
  const input: Omit<SharedInput, "url"> = {
    parties,
    stories,
    assets,
    channels,
    decisions,
    versions,
    shared,
  };
  // Sign only what the reviewer will see: the final media of their pieces, its posters and each listing's thumbnail.
  const visible = buildSharedPieces({ ...input, url: (p) => p ?? null });
  const wanted = new Set(visible.flatMap((p) => p.assets.map((m) => m.id)));
  const paths = assets
    .filter((a) => wanted.has(a.id))
    .flatMap((a) => [
      a.kind === "copy" ? null : playPath(a),
      (a.metadata as { poster_path?: string })?.poster_path ?? null,
      (a.metadata as { thumbnail_path?: string })?.thumbnail_path ?? null,
    ])
    .filter((p): p is string => !!p);
  return { input, paths };
}

/** Loads the pieces for these parties with the service client. Call only with parties the database returned. */
export async function loadShared(
  db: SupabaseClient,
  parties: string[],
): Promise<SharedPiece[]> {
  const loaded = await sharedInput(db, parties);
  if (!loaded) return [];
  const { data: signed } = await signedUrls(
    db,
    loaded.paths,
    60 * 60 * 6,
    BUCKET,
  );
  const urls = new Map((signed ?? []).map((s) => [s.path ?? "", s.signedUrl]));
  return buildSharedPieces({
    ...loaded.input,
    url: (p) => (p ? (urls.get(p) ?? null) : null),
  });
}

/** The storage keys a reviewer's /shared page shows: all they may re-sign or report. Call only with database parties. */
export async function sharedKeys(
  db: SupabaseClient,
  parties: string[],
): Promise<Set<string>> {
  return new Set((await sharedInput(db, parties))?.paths ?? []);
}
