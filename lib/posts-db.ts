// Loads calendar posts with their thumbnail, caption and link-rule state for the Calendar and Today screens.
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseCopy } from "./calendar";
import { calendarConfig } from "./calendar-db";
import { checkChannelLinks } from "./channel-rules";
import { BUCKET } from "./review";
import { DONE, type Post } from "./posts";
import { captionFor, thumbFor } from "./posts-parse";
import { signedUrls } from "./sign-urls";

type Row = {
  id: string; date: string; time: string | null; title: string; channels: string[] | null; status: string; pillar: string | null;
  format: string; story_id: string | null; publication: string | null; body: string | null; media: string[] | null;
  story_assets: string[] | null; urls: Record<string, string> | null;
};

/** Every post in [from, to] (both optional, ISO dates), oldest first. Signed thumbnail URLs last six hours. */
export async function loadPosts(db: SupabaseClient, range: { from?: string; to?: string } = {}): Promise<{ posts: Post[]; error: string | null }> {
  let query = db.from("gtm_content_items")
    .select("id,date,time,title,channels,status,pillar,format,story_id,publication,body,media,story_assets,urls");
  if (range.from) query = query.gte("date", range.from);
  if (range.to) query = query.lte("date", range.to);
  const { data, error } = await query.order("date").order("time").order("id");
  if (error) return { posts: [], error: error.message };
  const rows = (data ?? []) as Row[];

  const assetIds = [...new Set(rows.flatMap((r) => r.story_assets ?? []))];
  const { data: assetRows } = assetIds.length
    ? await db.from("gtm_story_assets").select("id,kind,storage_path,metadata").in("id", assetIds)
    : { data: [] };
  const assets = new Map(((assetRows ?? []) as { id: string; kind: string; storage_path: string | null; metadata: unknown }[]).map((a) => [a.id, a]));
  const thumbs = rows.map((r) => thumbFor(r, assets));
  const paths = [...new Set(thumbs.map((t) => t.path).filter((p): p is string => !!p && !/^https?:\/\//.test(p)))];
  const { data: signed } = await signedUrls(db, paths, 60 * 60 * 6, BUCKET);
  const urls = new Map((signed ?? []).map((s) => [s.path ?? "", s.signedUrl]));

  const manual = new Set(calendarConfig().manual);
  const posts = rows.map((r, i): Post => {
    const channels = r.channels ?? [];
    // Same hard rules the scheduler enforces: no URL in an Instagram caption or a LinkedIn body.
    const linkProblems = r.body && !DONE.includes(r.status)
      ? checkChannelLinks(r.id, channels.filter((c) => !manual.has(c)), parseCopy(r.body)).errors.map((e) => e.replace(`${r.id}: `, ""))
      : [];
    return {
      id: r.id, date: String(r.date).slice(0, 10), time: r.time, title: r.title, channels, status: r.status, pillar: r.pillar,
      format: r.format, storyId: r.story_id, publication: r.publication, caption: captionFor(r.body, channels[0]),
      thumb: !thumbs[i].path ? null : /^https?:\/\//.test(thumbs[i].path!) ? thumbs[i].path : urls.get(thumbs[i].path!) ?? null, mediaKind: thumbs[i].kind,
      urls: r.urls ?? {}, handsOn: channels.length > 0 && channels.every((c) => manual.has(c)), linkProblems,
    };
  });
  return { posts, error: null };
}

/** Today's date in the calendar timezone. */
export function todayIn(timeZone = calendarConfig().timezone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
