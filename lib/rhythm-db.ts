// Loads calendar rows for the weekly-rhythm lint (lib/rhythm.ts): the fields it needs and the LinkedIn caption, no
// thumbnails or signed URLs, so the calendar's lint strip and `gtm calendar lint` stay cheap.
import type { SupabaseClient } from "@supabase/supabase-js";
import { must } from "./db";
import { captionFor } from "./posts-parse";
import { traitPillarOf, type LintPost } from "./rhythm";
import { rowText, type CopyAsset } from "./row-text";

type Row = { id: string; date: string; channels: string[] | null; status: string; pillar: string | null; format: string; story_id: string | null; title: string; body: string | null; story_assets: string[] | null; zernio_post_id: string | null };

export async function loadLintPosts(db: SupabaseClient, from: string, to: string): Promise<LintPost[]> {
  await (await import("./rhythm-settings")).loadRhythm();
  const rows = must(await db.from("gtm_content_items").select("id,date,channels,status,pillar,format,story_id,title,body,story_assets,zernio_post_id")
    .gte("date", from).lte("date", to).order("date").order("id"), "calendar rows for the rhythm lint") as Row[];
  // A Story row with no text yet reads its Story's copy (lib/row-text.ts).
  const ids = [...new Set(rows.filter((r) => r.story_id).flatMap((r) => r.story_assets ?? []))];
  const copies = ids.length ? must(await db.from("gtm_story_assets").select("id,kind,body").in("id", ids).eq("kind", "copy"), "Story copy for the rhythm lint") as CopyAsset[] : [];
  const assets = new Map(copies.map((a) => [a.id, a]));
  return rows.map((r) => {
    const channels = r.channels ?? [];
    return {
      id: r.id, date: String(r.date).slice(0, 10), channels, status: r.status, pillar: r.pillar || traitPillarOf(r.story_id), format: r.format,
      storyId: r.story_id, title: r.title, caption: channels.includes("linkedin") ? captionFor(rowText(r, assets), "linkedin") : null,
    };
  });
}
