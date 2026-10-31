import { publicationConfig } from "./publications-server";
// The data half of /content: every read the review board needs, and the piece cards built from them. The page renders
// what this returns. With a piece filter (a link from the calendar or the work board) only that piece is read and signed.
// Reads are complete and ordered (lib/db-read.ts): a failed page throws, it never looks like an empty queue.
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildGroups, filterPieces, pieceParts, pieceView, type AssetVersion, type CardData, type FeedbackItem, type Filters, type PieceAsset, type PieceData, type StagePiece } from "@/lib/season-review";
import { storyHolds, type Hold, type HoldStory, type ThirdPartyDecision } from "@/lib/third-party";
import { playPath } from "@/lib/reviewer/shared";
import { BUCKET } from "@/lib/review";
import { splitFrontmatter } from "@/lib/render-copy";
import { boardStoryIds, onBoard } from "@/lib/season-board";
import { ROLES, bySlot, parsePieceTitle, partStatus, ratioOf, readFields } from "@/lib/season";
import { newsletterExport, newsletterParts, publishedUrl, withoutAlternatives } from "@/lib/newsletter-card";
import { publicUrlOf } from "@/lib/public-media";
import type { StoryAsset, StoryChannel } from "@/lib/story";
import { pieceStage } from "@/lib/stage";
import { isFormat } from "@/lib/pipelines";
import { finalState, stagedStages, type StageRow } from "@/lib/pipeline-state";
import { channelsSentBack, hiddenFromContent, partsSentBack, type Hidden } from "@/lib/content-visibility";
import { noteCovers } from "@/lib/approve-note";
import { signedUrls } from "@/lib/sign-urls";
import { readPages, readChunks } from "@/lib/db-read";
import { displayReviews } from "@/lib/review-display";
import { isPublishedCard, loadPublishedCards, withoutPublishedDecisions } from "./review-publication";

/** A piece is at its final once every posted asset is final (the pipeline's final state reads the same rows). */
const finalStateOf = (own: StoryAsset[], reviews: StoryChannel[]) => finalState(own.map((a) => ({ ...a, stage: a.stage ?? null })), reviews).staged;

/** A piece's pipeline for the page: progress rows, what is staged where, the final read from the platform approvals. */
function stagePiece(head: { pipeline?: string | null; series?: string | null; third_party_who?: string | null }, own: StoryAsset[], reviews: StoryChannel[], rows: StageRow[], hold: Hold | undefined): StagePiece | null {
  if (!isFormat(head.pipeline)) return null;
  const assets = own.map((a) => ({ ...a, stage: a.stage ?? null }));
  const piece: StagePiece = {
    format: head.pipeline, series: head.series ?? null, rows: rows.map(({ stage, status, note, actor, updated_at }) => ({ stage, status, note, actor, updated_at })),
    staged: [...stagedStages(assets)], final: finalState(assets, reviews), label: null,
    thirdParty: head.third_party_who ? { who: head.third_party_who, open: hold?.kind === "third_party" } : null,
  };
  const current = pieceView({ pipeline: piece })?.current;
  const labelled = current && own.find((a) => (a.stage ?? "final") === current.stage.key && typeof a.metadata?.label === "string");
  piece.label = labelled ? String(labelled.metadata.label) : null;
  return piece;
}

/**
 * Everything /content shows. `pieceOptions` lists every story on the board, also when a piece filter narrows the reads.
 * `sharedProblem` is set when the shared-review read failed: the legacy board still loads (review #147 B1).
 */
export async function loadContentBoard(db: SupabaseClient, filters: Filters) {
  const [storyRows, { live, killed }, published] = await Promise.all([
    readPages((from, to) => db.from("gtm_stories").select("id,title,season_id,hold_who,hold_note,held_at,pipeline,series,third_party_who", { count: "exact" }).order("id").range(from, to), "stories"),
    boardStoryIds(db),
    loadPublishedCards(db),
  ]);
  // An adopted piece's text and video are reviewed in the shared section above; only its Substack essays (and their
  // images) stay here, decided as before (review #151 N2). A failed or missing shared read never takes the page down
  // (review #147 B1); the assets' own shared stamp still keeps an adopted piece's platform cards out.
  let adoptedIds = new Set<string>(), sharedProblem: string | null = null;
  try {
    adoptedIds = new Set((await readPages((from, to) => db.from("gtm_piece_reviews").select("story_id", { count: "exact" }).order("story_id").range(from, to), "shared pieces") as { story_id: string }[]).map((p) => p.story_id));
  } catch (e) { sharedProblem = e instanceof Error ? e.message : String(e); }
  // A killed piece (a recorded kill, lib/season-board.ts) leaves the board; an adopted piece stays for its Substack cards.
  const board = bySlot(storyRows.filter((s) => onBoard(s, live, killed) || (adoptedIds.has(s.id) && !killed.has(s.id))));
  // A one-piece lookup (/content?piece=, every calendar and work-board link) reads and signs that piece only (#159,
  // John 2026-10-17: 10-12 s before the piece opened). The piece list in the toolbar still comes from every story.
  const scoped = filters.piece ? board.filter((s) => s.id === filters.piece) : board;
  const boardIds = scoped.map((s) => s.id);
  const boardAssets = (boardIds.length ? await readChunks(boardIds, (chunk, from, to) => db.from("gtm_story_assets").select("*", { count: "exact" }).in("story_id", chunk).order("id").range(from, to), "story assets") : []) as StoryAsset[];
  const sharedStories = new Set([...adoptedIds, ...boardAssets.filter((a) => a.metadata?.shared_review === true).map((a) => a.story_id)]);
  const stories = scoped;
  const ids = stories.map((s) => s.id);
  const assets = boardAssets;
  const assetIds = assets.map((a) => a.id);
  const stagesPromise = ids.length ? Promise.all([
    readChunks(ids, (chunk, from, to) => db.from("gtm_story_stages").select("story_id,stage,status,note,actor,updated_at", { count: "exact" }).in("story_id", chunk).order("story_id").order("stage").range(from, to), "gtm_story_stages").then((data) => ({ data })),
    readChunks(ids, (chunk, from, to) => db.from("gtm_story_stage_decisions").select("story_id,stage,party,decision,assets,decided_at", { count: "exact" }).in("story_id", chunk).order("decided_at").order("id").range(from, to), "gtm_story_stage_decisions").then((data) => ({ data })),
  ]) : [{ data: [] }, { data: [] }];
  const assetsPromise = assetIds.length
    ? Promise.all([
        readChunks(assetIds, (chunk, from, to) => db.from("gtm_story_asset_channels").select("*", { count: "exact" }).in("asset_id", chunk).order("asset_id").order("channel").range(from, to), "gtm_story_asset_channels").then((data) => ({ data })),
        readChunks(assetIds, (chunk, from, to) => db.from("gtm_story_feedback").select("*", { count: "exact" }).in("asset_id", chunk).order("created_at").order("id").range(from, to), "gtm_story_feedback").then((data) => ({ data })),
        readChunks(assetIds, (chunk, from, to) => db.from("gtm_story_asset_versions").select("*", { count: "exact" }).in("asset_id", chunk).order("asset_id").order("revision").range(from, to), "gtm_story_asset_versions").then((data) => ({ data })),
      ])
    : [{ data: [] }, { data: [] }, { data: [] }];
  const itemsPromise = ids.length ? readChunks(ids, (chunk, from, to) => db.from("gtm_content_items").select("story_id,pillar,date,status,channels,zernio_post_id", { count: "exact" }).in("story_id", chunk).order("id").range(from, to), "calendar items") : Promise.resolve([]);
  const [[{ data: stageRows }, { data: decisionRows }], [{ data: reviewRows }, { data: feedbackRows }, { data: versionRows }], itemRows] = await Promise.all([stagesPromise, assetsPromise, itemsPromise]);
  type VersionRow = { asset_id: string; revision: number; label: string; sha256: string; storage_path: string | null; poster_path: string | null; body: string | null; created_at: string; stage: string | null; changes: string | null; metadata: AssetVersion["meta"] | null };
  const versionsByAsset = new Map<string, VersionRow[]>();
  for (const v of (versionRows ?? []) as VersionRow[]) versionsByAsset.set(v.asset_id, [...(versionsByAsset.get(v.asset_id) ?? []), v]);
  const rawReviews = withoutPublishedDecisions(assets, (reviewRows ?? []) as StoryChannel[], published);
  const feedback = (feedbackRows ?? []) as FeedbackItem[];
  // A large video (an episode final) plays from its 720p review proxy; approval still binds to the master's sha256.
  // A version made before versions kept the proxy plays the asset's proxy when it is the same master.
  const versionPlayPath = (v: VersionRow) => {
    const current = assets.find((a) => a.id === v.asset_id && a.sha256 === v.sha256);
    return playPath({ storage_path: current ? playPath(current) : v.storage_path, metadata: (v.metadata ?? {}) as Record<string, unknown> });
  };
  const reviews = displayReviews(assets, rawReviews, feedback);

  const toAsset = (a: StoryAsset, channel: string | null): PieceAsset => {
    const text = a.kind === "copy" ? splitFrontmatter(a.body ?? "") : { prose: "", frontmatter: "" };
    const poster = (a.metadata as { poster_path?: string })?.poster_path;
    return {
      id: a.id, title: a.title, kind: a.kind as PieceAsset["kind"], revision: a.revision, source: a.source, stage: a.stage ?? null, sha256: a.sha256,
      label: typeof a.metadata?.label === "string" ? a.metadata.label : null,
      src: playPath(a),
      poster: poster ?? null,
      ratio: ratioOf(a.source),
      prose: text.prose, fields: readFields(text.frontmatter),
      status: (reviews.find((r) => r.asset_id === a.id && (channel === null || r.channel === channel))?.status ?? "pending") as PieceAsset["status"],
      versions: (versionsByAsset.get(a.id) ?? []).map((v): AssetVersion => {
        const parts = v.body ? splitFrontmatter(v.body) : { prose: "", frontmatter: "" };
        return { revision: v.revision, label: v.label, createdAt: v.created_at, src: versionPlayPath(v), poster: v.poster_path, prose: parts.prose, fields: readFields(parts.frontmatter), stage: v.stage ?? null, changes: v.changes ?? "", meta: v.metadata ?? {} };
      }),
      // A note for all formats of a video is stored once and shows on every format it names.
      feedback: feedback.filter((f) => noteCovers(f, a.id) && (channel === null || f.channel === null || f.channel === channel)),
    };
  };

  const items = (itemRows ?? []) as { story_id: string; pillar: string | null; date: string | null; status: string; channels: string[]; zernio_post_id: string | null }[];

  // What blocks publishing besides John: a manual hold, or a third party who has not approved the final at its bytes.
  const holds = storyHolds(stories as HoldStory[], assets.map((a) => ({ ...a, stage: a.stage ?? null })), new Set(rawReviews.map((r) => r.asset_id)), ((decisionRows ?? []) as ThirdPartyDecision[]).filter((d) => d.party === "third_party"));
  const all: PieceData[] = stories.flatMap((story): PieceData[] => {
    const own = assets.filter((a) => a.story_id === story.id);
    const cards: CardData[] = [];
    for (const role of sharedStories.has(story.id) ? [] : ROLES) {
      const copy = own.find((a) => a.kind === "copy" && reviews.some((r) => r.asset_id === a.id && r.channel === role));
      if (!copy || isPublishedCard(published, story.id, copy.id, role)) continue;
      const media = own.filter((a) => (a.kind === "video" || a.kind === "image") && reviews.some((r) => r.asset_id === a.id && r.channel === role))
        .sort((x, y) => x.id.localeCompare(y.id));
      cards.push({
        channel: role,
        copy: toAsset(copy, role),
        media: media.map((m) => toAsset(m, role)),
        textStatus: partStatus(reviews, [copy.id], role),
        assetStatus: partStatus(reviews, media.map((m) => m.id), role),
      });
    }
    // Substack: each newsletter essay is a card, approved here and pasted into Substack by John. It is never scheduled.
    // Images the essay does not name are alternatives: shown, never decided, so they cannot keep the card pending.
    for (const { copy, media, named, alternatives } of newsletterParts(own, reviews)) {
      if (publishedUrl(copy) || isPublishedCard(published, story.id, copy.id, "newsletter")) continue;
      cards.push({
        channel: "newsletter",
        copy: toAsset(copy, "newsletter"),
        media: media.map((m) => toAsset(m, "newsletter")),
        textStatus: partStatus(reviews, [copy.id], "newsletter"),
        assetStatus: partStatus(reviews, named.map((m) => m.id), "newsletter"),
        alternatives: alternatives.map((a) => a.id),
      });
    }
    // An adopted piece with no Substack essay has nothing left to decide here.
    if (!cards.length) return [];
    const { slot, name } = parsePieceTitle(story.title);
    const mine = items.filter((i) => i.story_id === story.id);
    const active = mine.filter((i) => i.status !== "skipped" && i.channels?.some((c) => (ROLES as readonly string[]).includes(c)));
    const delivered = (i: typeof mine[number]) => i.status === "published" || (i.status === "scheduled" && !!i.zernio_post_id && i.zernio_post_id !== "pending");
    const scheduled = active.length > 0 && active.every(delivered)
      && cards.filter((c) => c.channel !== "newsletter").every((c) => mine.some((i) => i.channels?.includes(c.channel) && (i.status === "skipped" || delivered(i))));
    const date = mine.map((i) => String(i.date ?? "").slice(0, 10)).filter(Boolean).sort()[0] ?? null;
    const found = holds.find((h) => h.storyId === story.id);
    const hold = found ? { who: found.who, note: found.note, heldAt: found.heldAt, kind: found.kind, finalStaged: found.finalStaged } : null;
    const head = story as { pipeline?: string | null; series?: string | null; third_party_who?: string | null };
    // The final is read without alternative newsletter images: an unused header option is not something to approve.
    const pipeline = stagePiece(head, own, withoutAlternatives(own, reviews), (stageRows ?? []).filter((r) => r.story_id === story.id), found);
    // Before the final, the media column shows what is staged at the current stage when it is reviewed in /content
    // (a rough cut), never a paper edit; a plan image has no platform, so it is not on any card.
    const current = pieceView({ pipeline })?.current;
    const stageAssets = !sharedStories.has(story.id) && current && !current.stage.final && current.stage.review === "cockpit"
      ? own.filter((a) => (a.kind === "video" || a.kind === "image") && a.stage === current.stage.key).sort((x, y) => x.id.localeCompare(y.id)).map((a) => toAsset(a, null))
      : [];
    return [{ storyId: story.id, slot, name, pillar: mine.find((i) => i.pillar)?.pillar ?? null, date, cards, scheduled, groups: buildGroups(cards), stageAssets,
      decisions: ((decisionRows ?? []) as Array<{ story_id: string; party: string; stage: string; decision: string; assets: Array<{ asset_id: string; sha256: string; revision?: number }>; decided_at: string }>)
        .filter((d) => d.story_id === story.id && d.party === "john").map(({ stage, decision, assets: seen, decided_at }) => ({ stage, decision, assets: seen, decided_at })), hold, stage: pieceStage(own, head.pipeline ?? null), pipeline }];
  });

  // What John directed here (lib/content-visibility.ts): a final he sent back, one staged before his latest storyboard or
  // rough-cut approval, or one an agent withdrew is left out until a newer version is staged.
  const hiddenPieces: Hidden[] = [];
  const directed: PieceData[] = [];
  for (const p of all) {
    const own = assets.filter((a) => a.story_id === p.storyId);
    // A published Substack essay and unused header options have nothing left to decide: their rows (sent back, pending) must not hide the piece.
    const live = withoutAlternatives(own, rawReviews);
    const input = {
      storyId: p.storyId, finalStaged: finalStateOf(own, live), assets: own.map((a) => ({ ...a, stage: a.stage ?? null })),
      rows: live.filter((r) => own.some((a) => a.id === r.asset_id)),
      versions: ((versionRows ?? []) as VersionRow[]).filter((v) => own.some((a) => a.id === v.asset_id)),
      stages: (stageRows ?? []).filter((r) => r.story_id === p.storyId),
      decisions: ((decisionRows ?? []) as Array<{ story_id: string; stage: string; party: string; decision: string; decided_at: string; assets: unknown }>).filter((d) => d.story_id === p.storyId),
    };
    const hidden = hiddenFromContent(input, p.cards.map((c) => c.channel));
    if (hidden) { hiddenPieces.push(hidden); continue; }
    const parts = partsSentBack(input);
    if (!parts.size) { directed.push(p); continue; }
    // A card whose every part was sent back is left out; otherwise only its media sent back leaves, and its text stays.
    const back = channelsSentBack(input);
    const cards = p.cards.filter((c) => !back.has(c.channel))
      .map((c) => ({ ...c, media: c.media.filter((m) => !parts.has(`${m.id}|${c.channel}`)) }));
    directed.push({ ...p, cards, groups: buildGroups(cards) });
  }
  // Sign only the pieces this filter renders. Historical bytes remain available for those pieces' version switchers.
  // Temporary paths never leave this loader: every media reference below is replaced by a signed URL or null.
  const mediaOf = (p: PieceData) => [...p.cards.flatMap((c) => [c.copy, ...c.media]), ...(p.groups ?? []).flatMap((g) => g.assets), ...(p.stageAssets ?? [])];
  const paths = [...new Set(filterPieces(directed, filters).flatMap(mediaOf).flatMap((a) => [a.src, a.poster, ...a.versions.flatMap((v) => [v.src, v.poster])]).filter((p): p is string => !!p))];
  const { data: signed } = await signedUrls(db, paths, 60 * 60 * 6, BUCKET);
  const urls = new Map(signed.filter((s) => !s.error).map((s) => [s.path ?? "", s.signedUrl]));
  const converted = new Set<PieceAsset>();
  for (const p of [...all, ...directed]) for (const a of mediaOf(p)) {
    if (converted.has(a)) continue;
    converted.add(a);
    a.src = a.src ? urls.get(a.src) ?? null : null;
    a.poster = a.poster ? urls.get(a.poster) ?? null : null;
    a.versions = a.versions.map((v) => ({ ...v, src: v.src ? urls.get(v.src) ?? null : null, poster: v.poster ? urls.get(v.poster) ?? null : null }));
  }
  for (const p of [...all, ...directed]) for (const c of p.cards) if (c.channel === "newsletter") {
    const stored = assets.filter((a) => a.story_id === p.storyId && a.kind === "image" && playPath(a)).map((a) => ({ source: a.source, signedUrl: urls.get(playPath(a)!) ?? null, publicUrl: publicUrlOf(a), alt: a.title }));
    c.substack = newsletterExport(assets.find((a) => a.id === c.copy.id)?.body ?? "", stored, publicationConfig());
  }
  // Overview rows cover the whole season, shown or not; only the final counts as approved. Part states cover both the
  // season and the cards on screen (a card left out regroups its piece's media).
  const { summary, stages, initial: seasonInitial } = pieceParts(all);
  const initial = { ...seasonInitial, ...pieceParts(directed).initial };
  const pieceOptions = board.map((s) => ({ id: s.id, label: parsePieceTitle(s.title).name }));
  return { error: null, storyRows, stories, all, directed, hiddenPieces, holds, summary, stages, initial, pieceOptions, sharedProblem } as const;
}
