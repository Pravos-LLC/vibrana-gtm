// "This essay is live on Substack" (John, 2026-10-18). One write, shared by `gtm story mark-published` and the Mark
// published button on the Substack card in /content: the essay's copy asset gets metadata.published_url, and its card
// leaves /content (lib/newsletter-card.ts publishedUrl). A row write, no deploy.
import type { SupabaseClient } from "@supabase/supabase-js";

export type MarkPublished = { asset: string; url: string; replaced: string | null };

/** An https URL with a host, trimmed. Anything else (a paste of the wrong thing) is refused with a plain reason. */
export function parsePublishedUrl(raw: string): string {
  const text = raw.trim();
  let host = "";
  try { host = new URL(text).hostname; } catch { /* reported below */ }
  if (!text.startsWith("https://") || !host.includes(".")) throw new Error("Paste the full https link to the published post, e.g. https://sample_author.substack.com/p/your-post");
  return new URL(text).href;
}

/**
 * Records the live URL on a Substack essay. Refuses an asset that is not a copy of that Story on the newsletter channel,
 * and replacing a different URL unless `force`. The update is guarded on the bytes and metadata just read (as lib/story.ts does), so an edit
 * or restage in between changes one of them and nothing is written.
 */
export async function markEssayPublished(db: SupabaseClient, storyId: string, assetId: string, rawUrl: string, opts: { force?: boolean; dryRun?: boolean } = {}): Promise<MarkPublished> {
  const url = parsePublishedUrl(rawUrl);
  const { data: asset, error } = await db.from("gtm_story_assets").select("id,story_id,kind,sha256,metadata").eq("id", assetId).eq("story_id", storyId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!asset || asset.kind !== "copy") throw new Error(`${assetId} is not a copy asset of ${storyId}`);
  const { data: onNewsletter, error: channelError } = await db.from("gtm_story_asset_channels").select("channel").eq("asset_id", asset.id).eq("channel", "newsletter");
  if (channelError) throw new Error(channelError.message);
  if (!onNewsletter?.length) throw new Error(`${asset.id} is not a newsletter essay (no newsletter channel), so there is no Substack card to remove`);
  const had = (asset.metadata as Record<string, unknown> | null)?.published_url;
  const replaced = typeof had === "string" && had !== url ? had : null;
  if (replaced && !opts.force) throw new Error(`${asset.id} is already marked published at ${replaced}; it must be replaced on purpose (gtm story mark-published --force)`);
  if (!opts.dryRun) {
    const metadata = { ...(asset.metadata ?? {}), published_url: url, published_at: new Date().toISOString() };
    const { data: updated, error: updateError } = await db.from("gtm_story_assets").update({ metadata }).eq("id", asset.id).eq("sha256", asset.sha256).eq("metadata", JSON.stringify(asset.metadata ?? {})).select("id");
    if (updateError) throw new Error(updateError.message);
    if (!updated?.length) throw new Error(`${asset.id} changed while it was being marked; try again`);
  }
  return { asset: asset.id, url, replaced };
}
