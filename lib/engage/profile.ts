import { assertLiveProvidersAllowed, providerFetch } from "../demo-safety";
// Who a commenter is, at a glance (VIB-428): photo, follower count, headline, company and website, so John can
// see the person and the signal before he replies. Read once per author from the public profile through Apify
// (LinkedIn: harvestapi/linkedin-profile-scraper, no cookies; Instagram: apify/instagram-profile-scraper), and
// only these fields are kept, on the comment row. A profile already read in the last 30 days is reused.
import type { SupabaseClient } from "@supabase/supabase-js";
import { must } from "../db";
import type { StoredComment } from "./parse";

export type AuthorProfile = {
  headline: string | null; company: string | null; website: string | null; followers: number | null;
  profileUrl: string | null; picture: string | null;
};

/** Profile reads older than this are refreshed (follower counts move). */
export const PROFILE_TTL_DAYS = 30;
/** One Apify run reads at most this many profiles: small enough to finish inside the cron's share (~10 s). */
const BATCH = 8;

type Author = Pick<StoredComment, "platform" | "author_username" | "author_name">;

/** The handle the platform's public profile is looked up by, or null when the comment carries none. */
export function profileHandle(a: Author): string | null {
  const h = a.author_username?.replace(/^@/, "").trim();
  if (!h) return null;
  if (a.platform === "linkedin") return /^[\p{L}\p{N}_%-]{3,100}$/u.test(h) ? h : null;
  if (a.platform === "instagram") return /^[a-z0-9._]{1,30}$/i.test(h) ? h.toLowerCase() : null;
  return null;
}

export const PROFILE_PLATFORMS = new Set(["linkedin", "instagram"]);

const str = (v: unknown, n: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);
// The scheme is lowercased: the database check is case-sensitive, and one "HTTPS://" would fail a whole batch.
const link = (v: unknown) => { const s = str(v, 500); return s && /^https?:\/\/[^\s]+$/i.test(s) ? s.replace(/^https?/i, (m) => m.toLowerCase()) : null; };
const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);

/** harvestapi/linkedin-profile-scraper item → the fields we keep. */
export function parseLinkedInProfile(p: Record<string, unknown>): AuthorProfile & { handle: string | null } {
  const sizes = ((p.profilePicture as { sizes?: { url?: string; width?: number }[] } | undefined)?.sizes ?? []);
  // The 200px rendition: sharp on a retina avatar without pulling the 800px original.
  const pic = sizes.find((s) => s.width === 200)?.url ?? (p.profilePicture as { url?: string } | undefined)?.url ?? p.photo;
  const position = Array.isArray(p.currentPosition) ? (p.currentPosition[0] as { companyName?: string; companyLinkedinUrl?: string } | undefined) : undefined;
  const sites = Array.isArray(p.websites) ? p.websites : [];
  return {
    handle: str(p.publicIdentifier, 100)?.toLowerCase() ?? null,
    headline: str(p.headline, 400), company: str(position?.companyName, 200),
    website: link(sites.find((s) => typeof s === "string")) ?? link(p.website) ?? link(position?.companyLinkedinUrl),
    followers: count(p.followerCount), profileUrl: link(p.linkedinUrl), picture: link(pic),
  };
}

/** apify/instagram-profile-scraper item → the fields we keep. */
export function parseInstagramProfile(p: Record<string, unknown>): AuthorProfile & { handle: string | null } {
  const raw = str(p.username, 30)?.toLowerCase() ?? null;
  const handle = raw && /^[a-z0-9._]{1,30}$/.test(raw) ? raw : null;
  return {
    handle, headline: str(p.biography, 400), company: str(p.businessCategoryName, 200),
    website: link(p.externalUrl), followers: count(p.followersCount),
    profileUrl: handle ? `https://www.instagram.com/${handle}/` : link(p.url), picture: link(p.profilePicUrlHD) ?? link(p.profilePicUrl),
  };
}

export type ProfileReader = (platform: string, handles: string[], opts?: { timeoutMs?: number }) => Promise<Map<string, AuthorProfile>>;

/** Apify run-sync per platform. null when APIFY_TOKEN is not set (the card then shows what the comment carries). */
export function apifyProfileReader(token: string | undefined = undefined, fetcher: typeof fetch = fetch): ProfileReader | null {
  assertLiveProvidersAllowed();
  token ??= process.env.APIFY_TOKEN;
  if (!token) return null;
  const actors: Record<string, { id: string; input: (h: string[]) => unknown; parse: (p: Record<string, unknown>) => AuthorProfile & { handle: string | null } }> = {
    linkedin: { id: "harvestapi~linkedin-profile-scraper", input: (h) => ({ profileScraperMode: "Profile details no email ($4 per 1k)", publicIdentifiers: h }), parse: parseLinkedInProfile },
    instagram: { id: "apify~instagram-profile-scraper", input: (h) => ({ usernames: h }), parse: parseInstagramProfile },
  };
  return async (platform, handles, opts = {}) => {
    const actor = actors[platform];
    const out = new Map<string, AuthorProfile>();
    if (!actor || !handles.length) return out;
    const secs = Math.max(10, Math.floor((opts.timeoutMs ?? 90_000) / 1000) - 5);
    const res = await providerFetch(fetcher)(`https://api.apify.com/v2/acts/${actor.id}/run-sync-get-dataset-items?timeout=${secs}`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(actor.input(handles)), signal: AbortSignal.timeout((secs + 5) * 1000),
    });
    const items = await res.json().catch(() => null) as Record<string, unknown>[] | { error?: { message?: string } } | null;
    if (!res.ok || !Array.isArray(items)) throw new Error(`apify ${platform}: ${res.status} ${(items as { error?: { message?: string } } | null)?.error?.message ?? ""}`.trim());
    const wanted = new Map(handles.map((h) => [h.toLowerCase(), h]));
    for (const item of items) {
      const { handle, ...profile } = actor.parse(item);
      // The input echo when present (harvestapi returns the query), else the profile's own handle.
      const query = str((item.originalQuery as { query?: string } | undefined)?.query ?? item.originalQuery, 200)?.toLowerCase();
      const key = (query && wanted.get(query)) ?? (handle && wanted.get(handle));
      if (key) out.set(key, profile);
    }
    return out;
  };
}

const PROFILE_COLUMNS = "author_headline,author_company,author_website,author_followers,author_profile_url,author_picture,author_enriched_at";
const toColumns = (p: AuthorProfile) => ({
  author_headline: p.headline, author_company: p.company, author_website: p.website,
  author_profile_url: p.profileUrl, ...(p.followers != null ? { author_followers: p.followers } : {}), ...(p.picture ? { author_picture: p.picture } : {}),
});

/**
 * Fills the profile of every queued comment whose author has not been read yet: a profile read for the same
 * author in the last PROFILE_TTL_DAYS is copied, the rest are read in one Apify run per platform. Marks every
 * row it tried (author_enriched_at), found or not, so an unknown handle is not re-read every run.
 */
export async function enrichAuthors(db: SupabaseClient, opts: { read?: ProfileReader | null; deadline?: number; ids?: string[]; limit?: number } = {}) {
  const out = { rows: 0, reused: 0, read: 0, missing: 0, errors: [] as { source: string; error: string }[] };
  let q = db.from("gtm_comments").select("id,platform,author_username,author_name").is("author_enriched_at", null).eq("is_own", false).in("platform", [...PROFILE_PLATFORMS]);
  q = opts.ids ? q.in("id", opts.ids) : q.in("status", ["new", "drafted", "failed"]);
  const rows = must(await q.order("received_at", { ascending: false }).limit(opts.limit ?? 100), "unenriched comments") as (Author & { id: string })[];
  out.rows = rows.length;
  if (!rows.length) return out;
  const read = opts.read === undefined ? apifyProfileReader() : opts.read;
  const now = new Date().toISOString();
  const byPlatform = new Map<string, Map<string, string[]>>();
  for (const r of rows) {
    const h = profileHandle(r);
    if (!h) { must(await db.from("gtm_comments").update({ author_enriched_at: now }).eq("id", r.id), "mark unenrichable"); out.missing++; continue; }
    const m = byPlatform.get(r.platform) ?? new Map<string, string[]>();
    m.set(h, [...(m.get(h) ?? []), r.id]);
    byPlatform.set(r.platform, m);
  }
  const fresh = new Date(Date.now() - PROFILE_TTL_DAYS * 86400_000).toISOString();
  for (const [platform, handles] of byPlatform) {
    const unread: string[] = [];
    for (const [h, ids] of handles) {
      // The same person commenting again: reuse their recent profile rather than paying for a second read.
      const prior = must(await db.from("gtm_comments").select(PROFILE_COLUMNS).eq("platform", platform).ilike("author_username", h.replace(/[\\%_]/g, (c) => `\\${c}`))
        .gte("author_enriched_at", fresh).not("author_profile_url", "is", null).order("author_enriched_at", { ascending: false }).limit(1), "prior profile") as Record<string, unknown>[];
      if (prior[0]) {
        // Nulls are left out so a follower count Zernio sent with this comment is not blanked.
        must(await db.from("gtm_comments").update(Object.fromEntries(Object.entries(prior[0]).filter(([, v]) => v != null))).in("id", ids), "reuse profile");
        out.reused += ids.length;
      } else unread.push(h);
    }
    if (!read) continue;
    for (let i = 0; i < unread.length; i += BATCH) {
      const left = (opts.deadline ?? Infinity) - Date.now();
      if (left < 20_000) { out.errors.push({ source: `profile ${platform}`, error: `time budget used up, ${unread.length - i} profiles left for the next run` }); break; }
      const batch = unread.slice(i, i + BATCH);
      try {
        const found = await read(platform, batch, { timeoutMs: Math.min(90_000, left - 10_000) });
        for (const h of batch) {
          const p = found.get(h);
          must(await db.from("gtm_comments").update({ ...(p ? toColumns(p) : {}), author_enriched_at: new Date().toISOString() }).in("id", handles.get(h)!), "save profile");
          if (p) out.read += handles.get(h)!.length; else out.missing += handles.get(h)!.length;
        }
      } catch (e) {
        out.errors.push({ source: `profile ${platform}`, error: (e as Error).message.slice(0, 200) });
      }
    }
  }
  return out;
}
