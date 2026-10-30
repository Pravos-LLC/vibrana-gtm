// Zernio analytics endpoints beyond GET /v1/analytics (VIB-417). Thin typed wrappers over `zernio()` in
// lib/zernio.ts, so they share its auth, base URL and 429 retry. Shapes follow docs.zernio.com
// (checked 2026-10-11); fields the cockpit does not read are left out of the types.
// Every analytics endpoint answers 402 (no analytics add-on) or 403 (scope or profile) when the plan or
// the connection cannot serve it: `orSkip` turns those into a `skipped` reason instead of a failure.
import { zernio, ZernioError, type ZMetrics } from "./zernio";

export type Skipped = { skipped: string };

/** Runs an analytics read; a 402/403 becomes `{ skipped }` (same rule as syncStats), anything else throws. */
export async function orSkip<T>(read: () => Promise<T>): Promise<T | Skipped> {
  try {
    return await read();
  } catch (e) {
    if (e instanceof ZernioError && (e.status === 402 || e.status === 403)) {
      return { skipped: e.status === 402 ? "Zernio analytics not enabled on this plan" : `Zernio refused (403): ${e.body.slice(0, 160)}` };
    }
    throw e;
  }
}
export const isSkipped = (x: unknown): x is Skipped => !!x && typeof x === "object" && "skipped" in x;

type Range = { fromDate: string; toDate: string };

// ---- dashboard: totals, followers and a daily series for a window ----------------------------------

export type DashboardTotals = { impressions: number; reach: number; likes: number; comments: number; shares: number; saves: number; clicks: number; views: number; engagementRate: number };
export type DashboardFollowers = { current: number; gained: number; byAccount: { accountId: string; platform: string; current: number; gained: number }[] };
export type Dashboard = {
  dateRange: { fromDate: string; toDate: string };
  totals: DashboardTotals; previousTotals?: DashboardTotals;
  followers: DashboardFollowers; previousFollowers?: DashboardFollowers;
  daily: { date: string; impressions: number; reach: number; engagement: number; views: number; followersGained: number }[];
  dataAsOf: string | null;
};

/** GET /v1/analytics/dashboard. `compare: "previous_period"` adds the same-length window before it. */
export function analyticsDashboard(q: Range & { platform?: string; compare?: "previous_period"; topPosts?: number; recentPosts?: number }) {
  return zernio<Dashboard>("/analytics/dashboard", { query: { topPosts: 0, recentPosts: 0, ...q } });
}

// ---- followers ---------------------------------------------------------------------------------

export type FollowerStats = {
  accounts: { _id: string; platform: string; username?: string; currentFollowers?: number; growth?: number; lastUpdated?: string }[];
  stats: Record<string, { date: string; followers: number }[]>;
};

/** GET /v1/accounts/follower-stats: a daily follower series per account (refreshed once a day). */
export function followerStats(q: Partial<Range> & { accountIds?: string[] } = {}) {
  return zernio<FollowerStats>("/accounts/follower-stats", { query: { fromDate: q.fromDate, toDate: q.toDate, accountIds: q.accountIds?.join(",") } });
}

// ---- per post ----------------------------------------------------------------------------------

export type TimelinePoint = { date: string; platform: string; platformPostId: string } & Required<Pick<ZMetrics, "impressions" | "reach" | "likes" | "comments" | "shares" | "saves" | "clicks" | "views">> & { follows: number | null };

/** GET /v1/analytics/post-timeline: daily metrics for one post (external, platform or Zernio post id). */
export function postTimeline(postId: string, q: Partial<Range> = {}, opts: { timeoutMs?: number } = {}) {
  return zernio<{ postId: string; timeline: TimelinePoint[] }>("/analytics/post-timeline", { query: { postId, ...q }, timeoutMs: opts.timeoutMs });
}

// ---- patterns across posts ----------------------------------------------------------------------

type Scope = { platform?: string; accountId?: string; source?: "late" | "external" };

/** GET /v1/analytics/content-decay: share of final engagement reached by post age bucket. */
export function contentDecay(q: Scope = {}) {
  return zernio<{ buckets: { bucket_order: number; bucket_label: string; avg_pct_of_final: number; post_count: number }[] }>("/analytics/content-decay", { query: q });
}

/** GET /v1/analytics/best-time: average engagement by weekday (0 = Monday) and UTC hour. */
export function bestTime(q: Scope = {}, opts: { timeoutMs?: number } = {}) {
  return zernio<{ slots: { day_of_week: number; hour: number; avg_engagement: number; post_count: number }[] }>("/analytics/best-time", { query: q, timeoutMs: opts.timeoutMs });
}

/** GET /v1/analytics/posting-frequency: engagement at each observed posts-per-week rate. */
export function postingFrequency(q: Scope = {}) {
  return zernio<{ frequency: { platform: string; posts_per_week: number; avg_engagement_rate: number; avg_engagement: number; weeks_count: number }[] }>("/analytics/posting-frequency", { query: q });
}

/** GET /v1/analytics/daily-metrics. `attribution: "received"` buckets engagement by the day it arrived. */
export function dailyMetrics(q: Partial<Range> & Scope & { attribution?: "publish" | "received" } = {}) {
  return zernio<{ dailyData: { date: string; postCount: number; metrics: Record<string, number> }[]; platformBreakdown: ({ platform: string; postCount: number } & Record<string, number>)[] }>("/analytics/daily-metrics", { query: q });
}

// ---- platform specific --------------------------------------------------------------------------

export type LinkedInAggregate = {
  accountId: string; accountType?: string; aggregation: "TOTAL" | "DAILY";
  analytics: Record<string, number | { date: string; count: number }[]>;
  skippedMetrics?: string[];
};

/** GET /v1/accounts/{id}/linkedin-aggregate-analytics (personal accounts; posts sent through Zernio only). `toDate` is exclusive. */
export function linkedinAggregate(accountId: string, q: Partial<Range> & { aggregation?: "TOTAL" | "DAILY"; metrics?: string[] } = {}) {
  return zernio<LinkedInAggregate>(`/accounts/${encodeURIComponent(accountId)}/linkedin-aggregate-analytics`, {
    query: { aggregation: q.aggregation, fromDate: q.fromDate, toDate: q.toDate, metrics: q.metrics?.join(",") },
  });
}

export type YoutubeDailyViews = {
  videoId: string; durationSeconds: number | null; provisionalSince?: string; totalViews: number;
  dailyViews: { date: string; views: number; estimatedMinutesWatched: number; averageViewDuration: number; averageViewPercentage: number; subscribersGained: number; subscribersLost: number; likes: number; comments: number; shares: number }[];
};

/** GET /v1/analytics/youtube/daily-views. YouTube finalizes about 3 days late (see provisionalSince). */
export function youtubeDailyViews(videoId: string, accountId: string, q: Partial<Range> = {}) {
  return zernio<YoutubeDailyViews>("/analytics/youtube/daily-views", { query: { videoId, accountId, ...q } });
}

export type VideoRetention = {
  videoId: string; durationSeconds: number | null; note?: string;
  retentionCurve: { elapsedVideoTimeRatio: number; audienceWatchRatio: number; relativeRetentionPerformance: number }[];
};

/** GET /v1/analytics/youtube/video-retention: up to 100 points of the lifetime retention curve. */
export function videoRetention(videoId: string, accountId: string, q: Partial<Range> = {}, opts: { timeoutMs?: number } = {}) {
  return zernio<VideoRetention>("/analytics/youtube/video-retention", { query: { videoId, accountId, ...q }, timeoutMs: opts.timeoutMs });
}

export type InstagramInsights = { metrics: Record<string, { total: number; values?: { date: string; value: number }[] }>; dateRange?: { since: string; until: string } };

/** GET /v1/analytics/instagram/account-insights (total_value by default; only reach has a time series). */
export function instagramAccountInsights(accountId: string, q: Partial<Range> & { metrics?: string[]; metricType?: "total_value" | "time_series" } = {}) {
  return zernio<InstagramInsights>("/analytics/instagram/account-insights", {
    query: { accountId, fromDate: q.fromDate, toDate: q.toDate, metrics: q.metrics?.join(","), metricType: q.metricType },
  });
}

// ---- the delta feed ------------------------------------------------------------------------------

export type DeltaEntry = {
  postId: string; accountId: string; profileId: string; platform: string; platformPostId: string;
  publishedAt: string; syncedAt: string; isDeleted: boolean; metrics: ZMetrics & Record<string, unknown>;
};
export type DeltaPage = { data: DeltaEntry[]; nextCursor: string; hasMore: boolean };

/**
 * GET /v1/analytics/delta: changed post snapshots since `cursor`, oldest first. No cursor returns an empty
 * page carrying the current position. The cursor is opaque, lives 7 days, and an empty page means "poll
 * again with the same cursor", never "advance".
 */
export function analyticsDelta(cursor?: string, limit?: number) {
  return zernio<DeltaPage>("/analytics/delta", { query: { cursor, limit } });
}
