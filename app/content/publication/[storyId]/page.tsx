import { chunks } from "@/lib/seasons";
import { notFound } from "next/navigation";
import { Shell } from "@/components/shell";
import { PublicationReview } from "@/components/review/publication-review";
import { publicationPackage } from "@/lib/packaging/publication";
import { sessionDb } from "@/lib/supabase/server";
import { signedUrls } from "@/lib/sign-urls";
import { BUCKET } from "@/lib/review";
import { playPath } from "@/lib/reviewer/shared";
import type { StoryAsset, StoryChannel } from "@/lib/story";
import { packagingProfiles, defaultPackagingBrand } from "@/lib/packaging/server-catalog";
import { must } from "@/lib/db";
export const dynamic = "force-dynamic";
export const metadata = { title: "Publication" };

export default async function PublicationPage({ params, searchParams }: { params: Promise<{ storyId: string }>; searchParams: Promise<{ cover?: string }> }) {
  const { storyId } = await params, { cover } = await searchParams, db = await sessionDb();
  const story = must(await db.from("gtm_stories").select("id,title,link_url").eq("id",storyId).maybeSingle(), "publication Story");
  if (!story) notFound();
  const current = must(await db.from("gtm_story_assets").select("*").eq("story_id",storyId), "publication assets") as StoryAsset[];
  const specimens = must(await db.from("gtm_story_assets").select("*").contains("metadata", {packaging_candidate:true,publication_story_id:storyId}), "publication templates") as StoryAsset[];
  const own = [...current,...specimens];
  const candidate = own.find(a=>a.id===cover) ?? own.find(a=>a.metadata.packaging_candidate === true);
  const companions = Array.isArray(candidate?.metadata.publication_companion_stories) ? candidate.metadata.publication_companion_stories.filter((s: unknown): s is string=>typeof s === "string" && /^[a-z0-9-]+$/.test(s)).slice(0,32) : [];
  const related = companions.length ? must(await db.from("gtm_story_assets").select("*").in("story_id",companions), "companion assets") as StoryAsset[] : [];
  const assets = [...own,...related], paths = [...new Set(assets.flatMap(a=>[playPath(a),typeof a.metadata.poster_path === "string" ? a.metadata.poster_path : null]).filter((p):p is string=>!!p))];
  const { data } = await signedUrls(db,paths,21600,BUCKET), urls = new Map(data.flatMap(s=>s.path && s.signedUrl ? [[s.path,s.signedUrl] as const] : []));
  // Proxy playback is read-only and approval continues to bind the master bytes.
  for(const a of assets){const p=playPath(a);if(a.storage_path && p && urls.has(p))urls.set(a.storage_path,urls.get(p)!);}
  const channels = (await Promise.all(chunks(assets.map(a=>a.id),20).map(async ids => must(await db.from("gtm_story_asset_channels").select("*").in("asset_id",ids), "publication channels") ?? []))).flat() as StoryChannel[];
  const profiles = packagingProfiles();
  const profile = String(candidate?.metadata.packaging_brand ?? defaultPackagingBrand());
  const pack = publicationPackage(story,assets,channels,urls,profiles[profile]?.name ?? profiles[defaultPackagingBrand()].name,cover);
  return <Shell title="Publication review" active="/content" wide><PublicationReview pack={pack}/></Shell>;
}
