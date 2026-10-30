import type { SupabaseClient } from "@supabase/supabase-js";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { guardVideoFile } from "./media-guard";
import { renderReviewProxy, sha256File, tusUpload, LARGE_MEDIA_BYTES } from "./large-media";
import { BUCKET } from "./review";
import { must } from "./db";

export const needsReviewProxy = (bytes: number) => bytes > 4 * 1024 * 1024;

/** Playback derivative only. It never modifies the approved master, its hash, or any platform decision. */
export async function stageReviewProxy(db: SupabaseClient, storyId: string, asset: { id: string; abs: string; sha256: string; bytes: number }): Promise<Record<string, unknown>> {
  const dir = mkdtempSync(join(tmpdir(), "gtm-review-proxy-"));
  try {
    const file = join(dir, "proxy.mp4");
    renderReviewProxy(asset.abs, file);
    if (sha256File(asset.abs) !== asset.sha256) throw new Error(`${asset.id}: master changed while rendering its review proxy`);
    const bytes = statSync(file).size;
    if (bytes >= asset.bytes) return {};
    const key = `stories/${storyId}/${asset.id}-${asset.sha256.slice(0, 16)}-review-v2.mp4`;
    const hash = sha256File(file);
    guardVideoFile(file, "video/mp4", key);
    if (bytes > LARGE_MEDIA_BYTES) await tusUpload({ bucket: BUCKET, object: key, file, contentType: "video/mp4", sha256: hash });
    else must(await db.storage.from(BUCKET).upload(key, readFileSync(file), { contentType: "video/mp4", upsert: true }), `upload ${asset.id} review proxy`);
    return { proxy_path: key, proxy_sha256: hash, proxy_bytes: bytes, proxy_master_sha256: asset.sha256 };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
