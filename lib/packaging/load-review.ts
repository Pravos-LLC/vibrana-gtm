import { chunks } from "../seasons";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TemplateCandidate } from "../../components/review/template-review";
import type { StoryAsset } from "../story";
import { signedUrls } from "../sign-urls";
import { BUCKET } from "../review";
import { must } from "../db";
export async function loadTemplateReview(db: SupabaseClient, story?: string): Promise<TemplateCandidate[]> {
  let q = db.from("gtm_story_assets").select("*").contains("metadata", { packaging_candidate: true }).order("id");
  if (story) q = q.contains("metadata", { publication_story_id: story });
  const assets = must(await q, "template review") as StoryAsset[];
  const paths = assets.flatMap(a => a.storage_path ? [a.storage_path] : []);
  const { data } = await signedUrls(db, paths, 21600, BUCKET), urls = new Map(data.map(s => [s.path, s.signedUrl]));
  const notes = (await Promise.all(chunks(assets.map(a => a.id),20).map(async ids => must(await db.from("gtm_story_feedback").select("id,asset_id,body,resolved_at").in("asset_id",ids).order("created_at"), "template notes") ?? []))).flat();
  return assets.map(a => ({ id: a.id, storyId: typeof a.metadata.publication_story_id === "string" ? a.metadata.publication_story_id : a.story_id, title: a.title, style: String(a.metadata.packaging_style), brand: String(a.metadata.packaging_brand), theme: String(a.metadata.packaging_theme), shape: String(a.metadata.packaging_shape), revision: a.revision, sha256: a.sha256, src: a.storage_path ? urls.get(a.storage_path) ?? null : null, notes: (notes ?? []).filter(n => n.asset_id === a.id).map(n => ({ id: n.id, body: n.body, resolved: !!n.resolved_at })) }));
}
