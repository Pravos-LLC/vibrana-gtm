// The Content review numbers without the page: platform cards, approvals, open notes, change requests.
// Same card rules as app/content/page.tsx (one card per season piece and platform that has copy).
import type { SupabaseClient } from "@supabase/supabase-js";
import { ROLES, partStatus } from "./season";
import { newsletterParts, publishedUrl } from "./newsletter-card";
import { boardStoryIds, onBoard } from "./season-board";
import { cardKey, summarize, type Overview, type SummaryCard, type SummaryStage } from "./season-review";
import { PIPELINES, isFormat } from "./pipelines";
import { readPages, readChunks } from "./db-read";
import { nonFinal } from "./stage";
import { isPublishedCard, loadPublishedCards } from "./review-publication";

export type ReviewSummary = Overview & { awaiting: number };

type Asset = { id: string; story_id: string; kind: string; stage: string | null; source: string; body: string | null; metadata: Record<string, unknown> | null };

export async function reviewSummary(db: SupabaseClient): Promise<ReviewSummary> {
  const [stories, { live, killed }, published] = await Promise.all([
    readPages<{ id: string; pipeline: string | null; season_id: string | null }>((from, to) => db.from("gtm_stories").select("id,pipeline,season_id", { count: "exact" }).order("id").range(from, to), "review summary stories"),
    boardStoryIds(db),
    loadPublishedCards(db),
  ]);
  const ids = stories.filter((s) => onBoard(s, live, killed)).map((s) => s.id);
  const assets = (ids.length ? await readChunks(ids, (chunk, from, to) => db.from("gtm_story_assets").select("id,story_id,kind,stage,source,body,metadata", { count: "exact" }).in("story_id", chunk).order("id").range(from, to), "summary assets") : []) as Asset[];
  const stageRows = (ids.length ? await readChunks(ids, (chunk, from, to) => db.from("gtm_story_stages").select("story_id,stage,status", { count: "exact" }).in("story_id", chunk).in("status", ["review", "changes"]).order("story_id").order("stage").range(from, to), "summary stages") : []) as { story_id: string; stage: string; status: string }[];
  // Stage reviews waiting on John in /content before the final (a rough cut).
  const pipelines = new Map(stories.map((s) => [s.id, s.pipeline]));
  const stages: SummaryStage[] = stageRows.flatMap((r) => {
    const format = pipelines.get(r.story_id);
    const st = isFormat(format) ? PIPELINES[format].stages.find((x) => x.key === r.stage) : undefined;
    return st && st.review === "cockpit" && !st.final ? [{ key: `${r.story_id}|${r.stage}`, storyId: r.story_id, label: st.label, status: r.status === "changes" ? "rejected" as const : "pending" as const }] : [];
  });
  const assetIds = assets.map((a) => a.id);
  // One read per table for every piece: no per-piece call (review #151 N7).
  const [reviews, notes] = await Promise.all([
    assetIds.length ? readChunks(assetIds, (chunk, from, to) => db.from("gtm_story_asset_channels").select("asset_id,channel,status", { count: "exact" }).in("asset_id", chunk).order("asset_id").order("channel").range(from, to), "summary approvals") : [],
    assetIds.length ? readChunks(assetIds, (chunk, from, to) => db.from("gtm_story_feedback").select("id,asset_id,channel,body", { count: "exact" }).in("asset_id", chunk).is("resolved_at", null).order("created_at").order("id").range(from, to), "summary notes") : [],
  ]) as [
    { asset_id: string; channel: string; status: string }[],
    { id: string; asset_id: string; channel: string | null; body: string }[],
  ];
  const cards: SummaryCard[] = [];
  for (const storyId of ids) {
    const own = assets.filter((a) => a.story_id === storyId);
    for (const role of ROLES) {
      const on = (a: { id: string }) => reviews.some((r) => r.asset_id === a.id && r.channel === role);
      const copy = own.find((a) => a.kind === "copy" && on(a));
      if (!copy || isPublishedCard(published, storyId, copy.id, role)) continue;
      const media = own.filter((a) => (a.kind === "video" || a.kind === "image") && on(a)).map((a) => a.id);
      const partIds = [copy.id, ...media];
      cards.push({
        key: cardKey(storyId, role), storyId,
        // Only the final counts: media short of final is never approved for publishing, whatever its rows say.
        textStatus: partStatus(reviews, [copy.id], role),
        assetStatus: nonFinal(own.filter((a) => media.includes(a.id))).length ? "pending" : partStatus(reviews, media, role),
        openNotes: notes.filter((n) => partIds.includes(n.asset_id) && (n.channel === null || n.channel === role)).length,
      });
    }
  }
  // Newsletter essays are cards in /content too (approved there, published by hand), one per essay.
  for (const storyId of ids) {
    const own = assets.filter((a) => a.story_id === storyId);
    // Only the images the essay names are decided; alternative headers are never counted as waiting.
    for (const { copy, named } of newsletterParts(own, reviews)) {
      if (publishedUrl(copy) || isPublishedCard(published, storyId, copy.id, "newsletter")) continue;
      const partIds = [copy.id, ...named.map((m) => m.id)];
      cards.push({
        key: cardKey(storyId, `newsletter:${copy.id}`), storyId,
        textStatus: partStatus(reviews, [copy.id], "newsletter"),
        assetStatus: named.length ? partStatus(reviews, named.map((m) => m.id), "newsletter") : "none",
        openNotes: notes.filter((n) => partIds.includes(n.asset_id) && (n.channel === null || n.channel === "newsletter")).length,
      });
    }
  }
  const awaiting = cards.filter((c) => c.textStatus === "pending" || c.assetStatus === "pending").length + stages.filter((s) => s.status === "pending").length;
  return { ...summarize(cards, stages), awaiting };
}
