// Fills each calendar row's text the one way (lib/row-text.ts): a Story row's text is its Story's copy until it is sent,
// and after a send that recorded none (the shared delivery path freezes queued rows), still the Story's copy.
import type { SupabaseClient } from "@supabase/supabase-js";
import { readChunks } from "./db-read";
import { rowText, type CopyAsset, type TextRow } from "./row-text";

export const TEXT_COLUMNS = "body,story_id,story_assets,status,zernio_post_id";

export async function withRowText<T extends TextRow>(db: SupabaseClient, rows: T[]): Promise<T[]> {
  const ids = [...new Set(rows.filter((r) => r.story_id).flatMap((r) => r.story_assets ?? []))];
  if (!ids.length) return rows;
  const copies = await readChunks<CopyAsset>(ids, (chunk, from, to) => db.from("gtm_story_assets").select("id,kind,body").in("id", chunk).eq("kind", "copy").order("id").range(from, to), "Story copy");
  const assets = new Map(copies.map((a) => [a.id, a]));
  return rows.map((r) => ({ ...r, body: rowText(r, assets) }));
}
