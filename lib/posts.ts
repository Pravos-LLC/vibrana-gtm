// One post on the content calendar, as the Calendar (week and list) and Today screens show it: the asset
// thumbnail, the platform, the caption and the status. Pure helpers only (no database, no React), so the
// filter and grouping rules are unit tested. Client-safe: server-only parsing lives in lib/posts-parse.ts and
// the loader in lib/posts-db.ts.
import { isSeasonStory } from "./season-id";

export type Post = {
  id: string; date: string; time: string | null; title: string; channels: string[]; status: string;
  pillar: string | null; format: string; storyId: string | null; publication: string | null;
  /** The caption for the post's channel, frontmatter stripped. Empty when no copy is attached yet. */
  caption: string;
  thumb: string | null; mediaKind: "video" | "image" | "document" | null;
  urls: Record<string, string>; handsOn: boolean; linkProblems: string[];
};

export const CHANNELS = ["linkedin", "instagram", "youtube", "newsletter", "website"] as const;
export const DONE = ["published", "skipped"];

export type PostFilters = { q: string; channel: string; status: string; pillar: string };
export const NO_POST_FILTERS: PostFilters = { q: "", channel: "", status: "", pillar: "" };

/** Killed posts (`skipped`) are off the calendar: they show only when the status filter asks for them (John, 2026-10-17). */
export function filterPosts(posts: Post[], f: PostFilters): Post[] {
  const q = f.q.toLowerCase();
  return posts.filter((p) =>
    (!f.channel || p.channels.includes(f.channel))
    && (f.status ? p.status === f.status : p.status !== "skipped")
    && (!f.pillar || p.pillar === f.pillar)
    && (!q || [p.title, p.caption, p.id, p.pillar ?? "", p.format].some((s) => s.toLowerCase().includes(q))));
}

export const hasPostFilters = (f: PostFilters) => Object.values(f).some(Boolean);

/** Overdue (past and not out yet), then upcoming grouped by week (Monday), then what went out, newest first. */
export function groupForList(posts: Post[], today: string, mondayOf: (iso: string) => string) {
  const overdue = posts.filter((p) => p.date < today && !DONE.includes(p.status));
  const upcoming = posts.filter((p) => p.date >= today && p.status !== "published");
  const done = posts.filter((p) => p.status === "published" || (p.date < today && p.status === "skipped"))
    .sort((a, b) => b.date.localeCompare(a.date) || (b.time ?? "").localeCompare(a.time ?? ""));
  const weeks = new Map<string, Post[]>();
  for (const p of upcoming) weeks.set(mondayOf(p.date), [...(weeks.get(mondayOf(p.date)) ?? []), p]);
  return { overdue, weeks: [...weeks.entries()].map(([monday, list]) => ({ monday, posts: list })), done };
}

/** Where the post's text and asset are reviewed: its piece on /content, or the legacy Story page for non-season pieces. */
export function reviewHref(post: Pick<Post, "storyId" | "channels">): string | null {
  if (!post.storyId) return null;
  if (!isSeasonStory(post.storyId)) return `/stories/${post.storyId}`;
  const platform = ["linkedin", "instagram", "youtube"].find((c) => post.channels.includes(c));
  return `/content?piece=${encodeURIComponent(post.storyId)}${platform ? `&platform=${platform}` : ""}`;
}

/** Posts that already went out (or never will) stay where they are. */
export const movable = (post: Pick<Post, "status">) => !DONE.includes(post.status);

/** The posts a move takes along: the post itself, plus (when `all`) its Story's other legs that can still move. */
export function pieceLegs(posts: Post[], id: string, all: boolean): string[] {
  const post = posts.find((p) => p.id === id);
  if (!all || !post?.storyId) return [id];
  return [id, ...posts.filter((p) => p.id !== id && p.storyId === post.storyId && movable(p)).map((p) => p.id)];
}
