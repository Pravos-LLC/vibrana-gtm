// Our own engagement numbers (VIB-417). Absolute counts come first; a ratio is only ever shown with its
// denominator named, and never summed across platforms, because each platform counts reach differently:
// LinkedIn per impression, Instagram per reach (accounts), YouTube per view. Pillar and format comparisons
// use medians, so one viral post cannot carry a whole pillar.

export type PostMetrics = {
  platform: string; published_at: string | null;
  impressions: number; reach: number; likes: number; comments: number; shares: number; saves: number; clicks: number; views: number;
  extras?: Record<string, number> | null;
};

/** Likes, comments, shares and saves: Zernio's interaction sum (clicks and follows are not engagement). */
export const engagements = (m: PostMetrics) => m.likes + m.comments + m.shares + m.saves;

/** Saves plus sends (LinkedIn and Instagram report sends; absent elsewhere). */
export const savesAndSends = (m: PostMetrics) => m.saves + (m.extras?.sends ?? 0);

export type Basis = { key: "impressions" | "reach" | "views"; per: string };

/** The denominator for each platform's engagement rate. */
export function rateBasis(platform: string): Basis {
  if (platform === "instagram") return { key: "reach", per: "account reached" };
  if (platform === "youtube") return { key: "views", per: "view" };
  return { key: "impressions", per: "impression" };
}

/** The platform's native reach number (what the rate divides by), labeled. */
export function nativeReach(m: PostMetrics): { value: number; unit: string } {
  const b = rateBasis(m.platform);
  return { value: m[b.key], unit: b.key };
}

/** Engagement rate in percent (1 dp) over the platform's own denominator; null when it is 0 (missing, not zero). */
export function ownRate(m: PostMetrics): { value: number; per: string } | null {
  const b = rateBasis(m.platform);
  const base = m[b.key];
  if (!base) return null;
  return { value: Math.round((engagements(m) / base) * 1000) / 10, per: b.per };
}

export function median(xs: number[]): number | null {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : Math.round(((v[mid - 1] + v[mid]) / 2) * 10) / 10;
}

/**
 * A post's numbers are still moving: Instagram for its first 48 hours, YouTube for 3 days (YouTube finalizes
 * late). Maturing posts are shown, but never ranked or compared.
 */
export function isMaturing(platform: string, publishedAt: string | null, now: Date): boolean {
  if (!publishedAt) return true;
  const ageH = (now.getTime() - Date.parse(publishedAt)) / 3600_000;
  if (platform === "instagram") return ageH < 48;
  if (platform === "youtube") return ageH < 72;
  return ageH < 24;
}

/** A post at least 7 days old has settled: the cohort the report compares against. */
export const isFinal = (publishedAt: string | null, now: Date) => !!publishedAt && now.getTime() - Date.parse(publishedAt) >= 7 * 86400_000;

/** Days since publishing, 1 dp. */
export const ageDays = (publishedAt: string | null, now: Date) => (publishedAt ? Math.round(((now.getTime() - Date.parse(publishedAt)) / 86400_000) * 10) / 10 : null);
