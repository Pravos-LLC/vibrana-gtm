import { loadContent } from "../../lib/content-overlay.mjs";
// The Signal Desk's configuration (content/guide/signals.json) and the shapes shared by every stage.
const signalsJson = loadContent("guide/signals.json") as typeof import("../../content/sample/guide/signals.json");

export type Lane = { slug: string; name: string; threshold: number; question: string };
export type FeedSource = { name: string; url: string; lanes: string[] };
export type SignalsConfig = {
  version: number;
  about: string;
  lanes: Lane[];
  flags: Record<string, string>;
  ranking: { window_hours: number; max_item_age_hours: number; cluster_similarity: number; top_n_briefs: number; digest_size: number };
  sources: {
    rss: FeedSource[];
    arxiv: { categories: string[]; query: string; max: number };
    hn: { min_points: number; max: number };
    github: { created_within_days: number; min_stars: number; topics: string[]; max: number };
    hf_papers: { max: number };
    google_news: { max_per_query: number; queries: string[] };
    reddit: { subreddits: string[]; max: number };
    bluesky: { per_account: number; accounts: { handle: string; name: string }[] };
  };
  x: {
    bookmarks: number;
    likes: number;
    news: { count: number; ai_only: boolean };
    searches: { query: string; lanes: string[] }[];
    users: string[];
  };
};

export const SOURCE_KINDS = [
  "rss", "hn", "github", "arxiv", "hf", "gdelt", "reddit", "bluesky",
  "x_bookmark", "x_like", "x_list", "x_search", "x_news", "x_user",
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** One sighting of a piece of news, normalized from any source. `url` is the dedupe key. */
export type SignalItem = {
  url: string;
  source: string;
  source_kind: SourceKind;
  author?: string | null;
  title: string;
  body?: string;
  published_at?: string | null;
  metrics?: Record<string, number>;
};

export const STATUSES = ["new", "saved", "queued", "drafted", "dismissed"] as const;
export type StoryStatus = (typeof STATUSES)[number];
export const FORMATS = ["story", "repost", "video"] as const;
export type StoryFormat = (typeof FORMATS)[number];

export type Brief = {
  headline: string;
  what_happened: string;
  why_it_matters: string;
  tension: string;
  angles: { linkedin_take: string; story: string; video: string };
  sources: { title: string; url: string; source: string }[];
  /** 0..1: would Vibrana's reader (STRATEGY.md) act on this? Briefs written before VIB-420 lack it. */
  audience_fit?: number;
  audience_reason?: string;
};

export type SignalStory = {
  id: string; title: string; lanes: string[]; score: number; velocity: number; source_count: number; item_count: number;
  first_seen: string; last_seen: string; brief: Brief | null; briefed_at: string | null; status: StoryStatus;
  requested_format: StoryFormat | null; gtm_story_id: string | null; acted_by: string | null; acted_at: string | null;
};

export function signalsConfig(): SignalsConfig {
  return signalsJson as SignalsConfig;
}

export function validateConfig(cfg: SignalsConfig): string[] {
  const out: string[] = [];
  const slugs = new Set<string>();
  for (const lane of cfg.lanes) {
    if (!/^[a-z][a-z0-9_]*$/.test(lane.slug)) out.push(`lane slug ${lane.slug} must be lowercase`);
    if (slugs.has(lane.slug)) out.push(`lane ${lane.slug} appears twice`);
    slugs.add(lane.slug);
    if (!(lane.threshold > 0 && lane.threshold < 1)) out.push(`lane ${lane.slug} threshold must be between 0 and 1`);
    if (!lane.question.trim().endsWith("?")) out.push(`lane ${lane.slug} question must be a question`);
  }
  const questions = cfg.lanes.length + Object.keys(cfg.flags).length;
  if (questions > 64) out.push(`Clef takes at most 64 questions; config asks ${questions}`);
  for (const feed of cfg.sources.rss) {
    if (!/^https:\/\//.test(feed.url)) out.push(`feed ${feed.name} must be https`);
    for (const lane of feed.lanes) if (!slugs.has(lane)) out.push(`feed ${feed.name} names unknown lane ${lane}`);
  }
  for (const search of cfg.x.searches) for (const lane of search.lanes) if (!slugs.has(lane)) out.push(`x search names unknown lane ${lane}`);
  return out;
}
