// The Zernio analytics delta feed (VIB-417): on each `analytics.synced` webhook (or `gtm stats --delta`),
// read only the posts whose metrics changed and fold them into today's snapshot rows. Cheaper than
// re-pulling 90 days, and idempotent: rows upsert on (post, platform, UTC day) and metrics are absolute.
//
// Cursor rules from the docs (docs.zernio.com/analytics/get-analytics-delta):
// - bootstrap by taking the cursor FIRST, then loading the baseline (`syncStats`), then resuming from it;
// - an empty page means "poll again with the same cursor", never advance past it;
// - a cursor older than 6 days is a 400: bootstrap again.
import type { SupabaseClient } from "@supabase/supabase-js";
import { must } from "../db";
import { itemIndex, metricExtras, syncStats, upsertSnapshots, type MetricRow } from "../sync";
import { ZernioError } from "../zernio";
import { analyticsDelta, isSkipped, orSkip, type DeltaEntry } from "../zernio-analytics";

export const DELTA_CURSOR_KEY = "zernio.analytics_delta";

async function readCursor(db: SupabaseClient): Promise<string | null> {
  const row = must(await db.from("gtm_sync_state").select("value").eq("key", DELTA_CURSOR_KEY).maybeSingle(), "read delta cursor") as { value: { cursor?: string } } | null;
  return typeof row?.value?.cursor === "string" && row.value.cursor ? row.value.cursor : null;
}

async function saveCursor(db: SupabaseClient, cursor: string | null) {
  if (cursor === null) return must(await db.from("gtm_sync_state").delete().eq("key", DELTA_CURSOR_KEY), "clear delta cursor");
  must(await db.from("gtm_sync_state").upsert({ key: DELTA_CURSOR_KEY, value: { cursor }, updated_at: new Date().toISOString() }), "save delta cursor");
}

/** Zernio's own engagement rate: interactions over the first non-zero of impressions, reach, views (percent, 2 dp). */
export function zernioRate(m: { likes?: number; comments?: number; shares?: number; saves?: number; impressions?: number; reach?: number; views?: number }): number | null {
  const base = m.impressions || m.reach || m.views || 0;
  if (!base) return null;
  return Math.round((((m.likes ?? 0) + (m.comments ?? 0) + (m.shares ?? 0) + (m.saves ?? 0)) / base) * 10_000) / 100;
}

/** Turns delta entries into snapshot rows, keeping the URL, preview and calendar link already on record. */
export async function deltaRows(db: SupabaseClient, entries: DeltaEntry[], capturedAt: string): Promise<MetricRow[]> {
  const live = entries.filter((e) => !e.isDeleted);
  if (!live.length) return [];
  const ids = [...new Set(live.map((e) => e.postId))];
  type Known = { zernio_post_id: string; platform: string; content_item_id: string | null; platform_post_url: string | null; content_preview: string | null; is_external: boolean; published_at: string | null };
  const known: Known[] = [];
  // Chunked so a long delta (up to 20 pages of 100) never builds an oversized GET query string.
  for (let i = 0; i < ids.length; i += 200) {
    known.push(...must(await db.from("gtm_post_metrics").select("zernio_post_id,platform,content_item_id,platform_post_url,content_preview,is_external,published_at").in("zernio_post_id", ids.slice(i, i + 200)).order("captured_at", { ascending: false }), "known posts") as Known[]);
  }
  const prior = new Map<string, (typeof known)[number]>();
  for (const k of known) if (!prior.has(`${k.zernio_post_id}|${k.platform}`)) prior.set(`${k.zernio_post_id}|${k.platform}`, k);
  const itemFor = await itemIndex(db);
  return live.map((e) => {
    const p = prior.get(`${e.postId}|${e.platform}`);
    const m = e.metrics ?? {};
    const n = (k: "impressions" | "reach" | "likes" | "comments" | "shares" | "saves" | "clicks" | "views") => (typeof m[k] === "number" ? (m[k] as number) : 0);
    const core = { impressions: n("impressions"), reach: n("reach"), likes: n("likes"), comments: n("comments"), shares: n("shares"), saves: n("saves"), clicks: n("clicks"), views: n("views") };
    return {
      zernio_post_id: e.postId, platform: e.platform, captured_at: capturedAt,
      content_item_id: p?.content_item_id ?? itemFor([e.postId], p?.platform_post_url),
      // A delta entry without publishedAt must not blank the date the full sync recorded.
      is_external: p?.is_external ?? false, published_at: e.publishedAt || p?.published_at || null,
      platform_post_url: p?.platform_post_url ?? null, content_preview: p?.content_preview ?? "",
      ...core, engagement_rate: zernioRate(core), extras: metricExtras(m),
    };
  });
}

/**
 * Reads the delta feed from the stored cursor and upserts today's snapshot for every changed post. With no
 * cursor (first run, or one that expired) it bootstraps: cursor first, then a full `syncStats`.
 */
export async function syncDelta(db: SupabaseClient, opts: { maxPages?: number; now?: Date; retried?: boolean } = {}) {
  const maxPages = opts.maxPages ?? 20;
  let cursor = await readCursor(db);
  if (!cursor) {
    const first = await orSkip(() => analyticsDelta());
    if (isSkipped(first)) return { skipped: first.skipped, rows: 0 };
    const baseline = await syncStats(90);
    await saveCursor(db, first.nextCursor);
    return { bootstrapped: true, baseline };
  }
  const entries: DeltaEntry[] = [];
  let pages = 0;
  try {
    for (;;) {
      const page = await analyticsDelta(cursor, 100);
      pages++;
      if (!page.data.length) break; // not "nothing changed": the newest rows may still be settling; keep the cursor
      entries.push(...page.data);
      cursor = page.nextCursor;
      if (!page.hasMore || pages >= maxPages) break;
    }
  } catch (e) {
    if (e instanceof ZernioError && (e.status === 402 || e.status === 403)) return { skipped: "Zernio analytics not enabled on this plan", rows: 0 };
    if (e instanceof ZernioError && e.status === 400 && !opts.retried) {
      // Expired or malformed cursor: start over from a fresh one plus a full snapshot.
      await saveCursor(db, null);
      return syncDelta(db, { ...opts, retried: true });
    }
    throw e;
  }
  const rows = await deltaRows(db, entries, (opts.now ?? new Date()).toISOString());
  const written = await upsertSnapshots(db, rows);
  // Advance only after the rows are stored, so a failed write re-reads the same changes next time.
  await saveCursor(db, cursor);
  return { pages, changed: entries.length, rows: written };
}
