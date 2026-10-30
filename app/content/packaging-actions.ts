"use server";
import { sessionDb } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
/** Feedback on a specimen is not an approval and cannot schedule a post. */
export async function packagingFeedback(input: { assetId: string; sha256: string; revision: number; body: string }) {
  if (!input.body?.trim() || input.body.length > 4800) return { ok: false, error: "Write a note of 1 to 4800 characters." };
  const db = await sessionDb(), { data } = await db.auth.getClaims();
  if ((data?.claims?.app_metadata as { gtm_owner?: boolean })?.gtm_owner !== true) return { ok: false, error: "Sign in as the cockpit owner." };
  const { data: asset, error } = await db.from("gtm_story_assets").select("sha256,revision,metadata").eq("id", input.assetId).maybeSingle();
  if (error || !asset || asset.metadata?.packaging_candidate !== true) return { ok: false, error: "Template candidate not found." };
  if (asset.sha256 !== input.sha256 || asset.revision !== input.revision) return { ok: false, error: "This template changed. Refresh before reviewing it." };
  // Keep the viewed version/hash explicit even if a restage races the feedback RPC's own revision snapshot.
  const body = `[Template review v${input.revision}; sha256 ${input.sha256}]\n${input.body.trim()}`;
  const result = await db.rpc("gtm_add_story_feedback", { p_asset_id: input.assetId, p_channel: null, p_body: body });
  if (result.error) return { ok: false, error: result.error.message };
  revalidatePath("/content"); return { ok: true };
}
