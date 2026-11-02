// Fills each calendar row's text the one way (lib/row-text.ts): a Story row's text is its Story's copy until it is sent,
// and after a send that recorded none (the shared delivery path freezes queued rows), still the Story's copy.
import type { SupabaseClient } from "@supabase/supabase-js";
import { must } from "./db";
import { rowText, type CopyAsset, type TextRow } from "./row-text";

export const TEXT_COLUMNS = "body,story_id,story_assets,status,zernio_post_id";

export async function withRowText<T extends TextRow>(db: SupabaseClient, rows: T[]): Promise<T[]> {
  const ids = [...new Set(rows.filter((r) => r.story_id).flatMap((r) => r.story_assets ?? []))];
  if (!ids.length) return rows;
  const copies = must(await db.from("gtm_story_assets").select("id,kind,body").in("id", ids).eq("kind", "copy"), "Story copy") as CopyAsset[];
  const assets = new Map(copies.map((a) => [a.id, a]));
  return rows.map((r) => ({ ...r, body: rowText(r, assets) }));
}
