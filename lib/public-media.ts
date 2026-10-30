import { assertLiveProvidersAllowed, providerFetch } from "./demo-safety";
// Copies approved-for-publication Story images to the PUBLIC R2 bucket so pasted newsletters keep
// working after the private content-review signed URLs expire. The private bucket stays private.
//
// Keys reuse the content-addressed storage path (stories/<story>/<asset>-<sha16>.<ext>), so a public
// URL is immutable: changed bytes get a new key, never an overwrite.
import type { SupabaseClient } from "@supabase/supabase-js";
import { must } from "./db";
import { guardMediaBytes } from "./media-guard";
import { BUCKET } from "./review";
import { digest, type StoryAsset } from "./story";

export type PublicMediaConfig = { accountId: string; token: string; bucket: string; baseUrl: string };

export function publicMediaConfig(env: Record<string, string | undefined> = process.env): PublicMediaConfig {
  assertLiveProvidersAllowed();
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  assertLiveProvidersAllowed();
  const token = env.CLOUDFLARE_R2_API_TOKEN ?? env.CLOUDFLARE_API_TOKEN;
  const bucket = env.GTM_PUBLIC_MEDIA_BUCKET;
  const baseUrl = env.GTM_PUBLIC_MEDIA_BASE_URL?.replace(/\/+$/, "");
  const missing = Object.entries({ CLOUDFLARE_ACCOUNT_ID: accountId, "CLOUDFLARE_R2_API_TOKEN (or CLOUDFLARE_API_TOKEN)": token, GTM_PUBLIC_MEDIA_BUCKET: bucket, GTM_PUBLIC_MEDIA_BASE_URL: baseUrl })
    .filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) throw new Error(`public media needs ${missing.join(", ")}`);
  if (!/^https:\/\//.test(baseUrl!)) throw new Error("GTM_PUBLIC_MEDIA_BASE_URL must be https");
  return { accountId: accountId!, token: token!, bucket: bucket!, baseUrl: baseUrl! };
}

const CONTENT_TYPE: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

/** The public URL is only trusted while it still serves the exact bytes the asset row describes. */
export function publicUrlOf(asset: Pick<StoryAsset, "sha256" | "metadata">): string | null {
  const meta = asset.metadata ?? {};
  return typeof meta.public_url === "string" && meta.public_sha256 === asset.sha256 ? meta.public_url : null;
}

/** Story images referenced (by file name) from any copy asset in the same Story. */
export function referencedImages(assets: StoryAsset[]): StoryAsset[] {
  const bodies = assets.filter((asset) => asset.kind === "copy").map((asset) => asset.body ?? "").join("\n");
  return assets.filter((asset) => asset.kind === "image" && bodies.includes(asset.source.split("/").pop() ?? "\0"));
}

export async function publishStoryMedia(db: SupabaseClient, storyId: string, opts: { assetIds?: string[]; dryRun?: boolean; config?: PublicMediaConfig } = {}) {
  assertLiveProvidersAllowed();
  const assets = must(await db.from("gtm_story_assets").select("*").eq("story_id", storyId), "story assets") as StoryAsset[];
  if (!assets.length) throw new Error(`no Story ${storyId}`);
  const chosen = opts.assetIds?.length ? assets.filter((asset) => opts.assetIds!.includes(asset.id)) : referencedImages(assets);
  const unknown = (opts.assetIds ?? []).filter((id) => !assets.some((asset) => asset.id === id));
  if (unknown.length) throw new Error(`not in Story ${storyId}: ${unknown.join(", ")}`);
  const notImages = chosen.filter((asset) => asset.kind !== "image" || !asset.storage_path);
  if (notImages.length) throw new Error(`only stored images can be made public: ${notImages.map((asset) => asset.id).join(", ")}`);
  const plan = chosen.map((asset) => ({ id: asset.id, key: asset.storage_path!, already: publicUrlOf(asset) }));
  if (opts.dryRun) return { dryRun: true as const, story: storyId, images: plan };
  const config = opts.config ?? publicMediaConfig();
  const results = [];
  for (const asset of chosen) {
    const key = asset.storage_path!;
    const url = `${config.baseUrl}/${key}`;
    const ext = key.split(".").pop()!.toLowerCase();
    const contentType = CONTENT_TYPE[ext];
    if (!contentType) throw new Error(`${asset.id}: unsupported image type .${ext}`);
    const { data, error } = await db.storage.from(BUCKET).download(key);
    if (error || !data) throw new Error(`${asset.id}: download ${key}: ${error?.message}`);
    const bytes = Buffer.from(await data.arrayBuffer());
    if (digest(bytes) !== asset.sha256) throw new Error(`${asset.id}: stored bytes do not match the asset digest; restage the Story`);
    guardMediaBytes(bytes, contentType, key);
    const put = await providerFetch()(`https://api.cloudflare.com/client/v4/accounts/${config.accountId}/r2/buckets/${config.bucket}/objects/${key.split("/").map(encodeURIComponent).join("/")}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${config.token}`, "content-type": contentType, "cache-control": "public, max-age=31536000, immutable" },
      body: bytes,
    });
    if (!put.ok) throw new Error(`${asset.id}: R2 upload failed (HTTP ${put.status})`);
    // Verify the property that matters: the public URL serves these exact bytes.
    const check = await providerFetch()(url, { cache: "no-store" });
    const served = Buffer.from(await check.arrayBuffer());
    if (!check.ok || digest(served) !== asset.sha256) throw new Error(`${asset.id}: public URL ${url} did not serve the uploaded bytes (HTTP ${check.status})`);
    must(await db.from("gtm_story_assets").update({
      metadata: { ...(asset.metadata ?? {}), public_url: url, public_sha256: asset.sha256, public_at: new Date().toISOString() },
    }).eq("id", asset.id).eq("sha256", asset.sha256), `record public URL for ${asset.id}`);
    results.push({ id: asset.id, url, bytes: bytes.length, contentType: check.headers.get("content-type") });
  }
  return { story: storyId, images: results };
}
