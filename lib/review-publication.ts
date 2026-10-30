import type { SupabaseClient } from "@supabase/supabase-js";
import { readPages } from "./db-read";
import { publishedUrl } from "./newsletter-card";
import { referencedImages } from "./substack";

export type PublishedCard = { story_id: string | null; story_assets: string[] | null; channels: string[] | null };

/** Publication is durable calendar history, independent of the current asset's editable metadata or approval. */
export async function loadPublishedCards(db: SupabaseClient): Promise<PublishedCard[]> {
  return readPages<PublishedCard>((from, to) => db.from("gtm_content_items")
    .select("id,story_id,story_assets,channels", { count: "exact" }).eq("status", "published")
    .order("id").range(from, to), "published review cards");
}

/** Match the actual essay/platform binding, never the whole Story: its other posts may still need review. */
export function isPublishedCard(items: PublishedCard[], storyId: string, copyId: string, channel: string): boolean {
  return items.some((i) => i.story_id === storyId && i.channels?.includes(channel) && i.story_assets?.includes(copyId));
}

/** Published decisions cannot keep another card's pipeline pending or hide it as sent back. Shared images still count. */
export function withoutPublishedDecisions<R extends { asset_id: string; channel: string }>(assets: Array<{ id: string; story_id: string; kind: string; source: string; body?: string | null; metadata?: Record<string, unknown> | null }>, rows: R[], published: PublishedCard[]): R[] {
  return rows.filter((row) => {
    const asset = assets.find((a) => a.id === row.asset_id);
    if (!asset) return true;
    const copies = assets.filter((a) => a.story_id === asset.story_id && a.kind === "copy" && rows.some((r) => r.asset_id === a.id && r.channel === row.channel));
    const done = (a: typeof asset) => isPublishedCard(published, a.story_id, a.id, row.channel) || (row.channel === "newsletter" && !!publishedUrl(a));
    if (!copies.some(done)) return true;
    if (asset.kind === "copy") return !done(asset);
    const open = copies.filter((a) => !done(a));
    if (!open.length) return false;
    if (row.channel === "newsletter" && asset.kind === "image") {
      const name = asset.source.split("/").pop()!;
      const names = (a: typeof asset) => referencedImages(a.body ?? "").includes(name);
      if (copies.some((a) => done(a) && names(a)) && !open.some(names)) return false;
    }
    return true;
  });
}
