// Loads calendar rows for the weekly-rhythm lint (lib/rhythm.ts): the fields it needs and the LinkedIn caption, no
// thumbnails or signed URLs, so the calendar's lint strip and `gtm calendar lint` stay cheap.
import type { SupabaseClient } from "@supabase/supabase-js";
import { must } from "./db";
import { captionFor } from "./posts-parse";
import type { LintPost } from "./rhythm";

type Row = { id: string; date: string; channels: string[] | null; status: string; pillar: string | null; format: string; story_id: string | null; title: string; body: string | null };

export async function loadLintPosts(db: SupabaseClient, from: string, to: string): Promise<LintPost[]> {
  const rows = must(await db.from("gtm_content_items").select("id,date,channels,status,pillar,format,story_id,title,body")
    .gte("date", from).lte("date", to).order("date").order("id"), "calendar rows for the rhythm lint") as Row[];
  return rows.map((r) => {
    const channels = r.channels ?? [];
    return {
      id: r.id, date: String(r.date).slice(0, 10), channels, status: r.status, pillar: r.pillar, format: r.format,
      storyId: r.story_id, title: r.title, caption: channels.includes("linkedin") ? captionFor(r.body, "linkedin") : null,
    };
  });
}
