// Pulls Zernio + Twenty into Supabase. Shared by the CLI and the Vercel cron route.
import { adminDb, must } from "./db";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  listAccounts,
  listAnalytics,
  getPost,
  findCalendarPost,
  ZernioError,
  type ZMetrics,
  type ZPost,
} from "./zernio";
import { readPages } from "./db-read";
import {
  loadPieceDeliveries,
  reconcilePieceDeliveries,
} from "./piece-delivery";
import { crmSnapshot } from "./twenty";
import { weekOfDate, type Item } from "./calendar";

const iso = (d: Date) => d.toISOString().slice(0, 10);

export async function pushItems(items: Item[], { allowEmpty = false } = {}) {
  // An empty or truncated calendar must not silently wipe the cockpit's mirror.
  if (!items.length && !allowEmpty)
    return { upserted: 0, removed: 0, skipped: "calendar has no items" };
  const db = adminDb();
  // A row with a shared delivery is owned by the delivery ledger: its payload, slot and status are frozen, and the
  // database refuses a write to them. The import leaves those rows exactly as they are and says so.
  const frozen = new Set((await loadPieceDeliveries(db)).map((d) => d.calendar_id));
  const rows = items.filter((i) => !frozen.has(i.id)).map((i) => ({
    id: i.id,
    week: weekOfDate(i.date, i.week),
    date: i.date,
    time: i.time ?? null,
    pillar: i.pillar,
    title: i.title,
    format: i.format,
    channels: i.channels,
    status: i.status,
    link: i.link ?? null,
    cta: i.cta ?? null,
    ...(i.story_id ? { story_id: i.story_id } : {}),
    zernio_post_id: i.zernio_post_id ?? null,
    published_at: i.published_at ?? null,
    urls: i.urls ?? {},
    updated_at: new Date().toISOString(),
  }));
  must(await db.from("gtm_content_items").upsert(rows), "upsert content_items");
  const ids = items.map((i) => i.id);
  // Items deleted from calendar.yaml disappear from the cockpit too.
  const existing = must(
    await db.from("gtm_content_items").select("id"),
    "list content_items",
  ) as { id: string }[];
  const stale = existing.map((r) => r.id).filter((id) => !ids.includes(id) && !frozen.has(id));
  if (stale.length)
    must(
      await db.from("gtm_content_items").delete().in("id", stale),
      "delete stale items",
    );
  const kept = items.filter((i) => frozen.has(i.id)).map((i) => i.id);
  return { upserted: rows.length, removed: stale.length, ...(kept.length ? { frozen: kept } : {}) };
}

/** Reconcile scheduled items with Zernio post status. Returns patches for calendar write-back. */
export async function syncStatus() {
  const db = adminDb();
  await reconcilePieceDeliveries(db);
  const shared = new Set(
    (await loadPieceDeliveries(db)).map((d) => d.calendar_id),
  );
  const open = (
    await readPages<{ id: string; zernio_post_id: string; status: string }>(
      (from, to) =>
        db
          .from("gtm_content_items")
          .select("id,zernio_post_id,status")
          .not("zernio_post_id", "is", null)
          // Only rows whose outcome can still change (review #151 N5): queued or failed posts, and an interrupted send
          // still marked pending. A published post is final and is not read again on every run.
          .or("status.in.(scheduled,failed),zernio_post_id.eq.pending")
          .order("id")
          .range(from, to),
      "provider-linked items",
    )
  ).filter((r) => !shared.has(r.id));
  const patches: Array<{
    id: string;
    status: string;
    published_at?: string;
    urls?: Record<string, string>;
    zernio_post_id?: string | null;
  }> = [];
  const errors: string[] = [];
  for (const row of open) {
    let post: ZPost;
    const interrupted = row.zernio_post_id === "pending";
    try {
      const observed = interrupted
        ? await findCalendarPost(row.id)
        : await getPost(row.zernio_post_id);
      if (!observed) continue; // Absence is unverified and never opens the retry gate.
      post = observed;
    } catch (e) {
      // A published post deleted at Zernio later is history, not an error to repeat on every run.
      if (!interrupted && row.status === "published" && e instanceof ZernioError && e.status === 404) continue;
      if (
        !interrupted &&
        row.status !== "published" &&
        e instanceof ZernioError &&
        e.status === 404
      ) {
        // Deleted in Zernio: surface it as failed and unlink, keep syncing the rest.
        const patch = { id: row.id, status: "failed", zernio_post_id: null };
        must(
          await db
            .from("gtm_content_items")
            .update({ ...patch, updated_at: new Date().toISOString() })
            .eq("id", row.id),
          "update item",
        );
        patches.push(patch);
        continue;
      }
      errors.push(row.id);
      console.error(`status reconciliation unavailable for ${row.id}`);
      continue;
    }
    const urls: Record<string, string> = {};
    let publishedAt: string | undefined;
    for (const p of post.platforms ?? []) {
      if (p.platformPostUrl) urls[p.platform] = p.platformPostUrl;
      if (p.publishedAt && (!publishedAt || p.publishedAt < publishedAt))
        publishedAt = p.publishedAt;
    }
    const status =
      post.status === "published"
        ? "published"
        : post.status === "failed" || post.status === "partial"
          ? "failed"
          : ["scheduled", "publishing"].includes(post.status)
            ? "scheduled"
            : row.status;
    if (status === row.status && !Object.keys(urls).length && !interrupted)
      continue;
    const patch = {
      id: row.id,
      status,
      urls,
      ...(interrupted ? { zernio_post_id: post._id } : {}),
      ...(publishedAt ? { published_at: publishedAt } : {}),
    };
    must(
      await db
        .from("gtm_content_items")
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq("id", row.id),
      "update item",
    );
    patches.push(patch);
  }
  // A retired shared post that Zernio brings back is an alert in the cron result, never a silent double post.
  const { retiredPostAlerts, raiseRetiredAlerts } = await import("./piece-delivery");
  const alerts = await retiredPostAlerts(db);
  if (alerts.length) await raiseRetiredAlerts(db, alerts);
  if (errors.length || alerts.length)
    throw new Error(
      [errors.length ? `Status reconciliation unavailable for ${errors.join(", ")}; remaining channel outcomes were still checked` : "", ...alerts.map((a) => a.message)].filter(Boolean).join(". "),
    );
  return patches;
}

/** Per-post metrics kept in gtm_post_metrics.extras. Zernio reports 0 where a platform has no such metric. */
export const EXTRA_KEYS = [
  "sends",
  "follows",
  "igReelsAvgWatchTime",
  "igReelsVideoViewTotalTime",
  "reelsSkipRate",
  "profileViews",
  "websiteClicks",
  "reposts",
  "videoDurationSeconds",
] as const;

/**
 * The extras worth keeping: a number that is not 0, because Zernio sends 0 for "this platform does not report
 * it" and a missing value must read as missing, never as zero. `follows` is the exception: Zernio sends null
 * where Meta has no follows metric, so a 0 there is a real zero.
 */
export function metricExtras(
  a: ZMetrics | Record<string, unknown> | null | undefined,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of EXTRA_KEYS) {
    const v = (a as Record<string, unknown> | null | undefined)?.[k];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    if (v !== 0 || k === "follows") out[k] = v;
  }
  return out;
}

export type MetricRow = {
  zernio_post_id: string;
  platform: string;
  captured_at: string;
  content_item_id: string | null;
  is_external: boolean;
  published_at: string | null;
  platform_post_url: string | null;
  content_preview: string;
  impressions: number;
  reach: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  clicks: number;
  views: number;
  engagement_rate: number | null;
  extras: Record<string, number>;
};

/**
 * Writes snapshots as one row per (post, platform, UTC day): the table's unique key, so a second run on the
 * same day (the Vercel cron, a manual `gtm stats`, the analytics webhook) updates that day's row instead of
 * appending another. Rows repeated within one batch keep the last.
 */
export async function upsertSnapshots(db: SupabaseClient, rows: MetricRow[]) {
  const byKey = new Map<string, MetricRow>();
  for (const r of rows)
    byKey.set(
      `${r.zernio_post_id}|${r.platform}|${r.captured_at.slice(0, 10)}`,
      r,
    );
  const unique = [...byKey.values()];
  for (let i = 0; i < unique.length; i += 500) {
    must(
      await db
        .from("gtm_post_metrics")
        .upsert(unique.slice(i, i + 500), {
          onConflict: "zernio_post_id,platform,captured_on",
        }),
      "upsert post_metrics",
    );
  }
  return unique.length;
}

/** gtm_content_items lookups for a metrics row: by Zernio post id, then by the post's URL on that platform. */
export async function itemIndex(db: SupabaseClient) {
  const items = must(
    await db.from("gtm_content_items").select("id,zernio_post_id,urls"),
    "items",
  ) as {
    id: string;
    zernio_post_id: string | null;
    urls: Record<string, string> | null;
  }[];
  const byPost = new Map(
    items
      .filter((i) => i.zernio_post_id && i.zernio_post_id !== "pending")
      .map((i) => [i.zernio_post_id!, i.id]),
  );
  const byUrl = new Map<string, string>();
  for (const i of items)
    for (const url of Object.values(i.urls ?? {}))
      if (typeof url === "string" && url) byUrl.set(url, i.id);
  return (ids: (string | null | undefined)[], url?: string | null) => {
    for (const id of ids) if (id && byPost.has(id)) return byPost.get(id)!;
    return (url && byUrl.get(url)) || null;
  };
}

/**
 * Snapshot per-post, per-platform metrics for the last `days` days (includes posts made outside Zernio).
 * Idempotent per UTC day. Posts join the calendar through Zernio's `latePostId` (the id we scheduled), not
 * `_id`, which is the external post id and never matched a calendar row.
 */
export async function syncStats(days = 90) {
  const db = adminDb();
  const to = new Date();
  const from = new Date(to.getTime() - days * 86400_000);
  let posts;
  try {
    posts = await listAnalytics(iso(from), iso(to));
  } catch (e) {
    if (e instanceof ZernioError && (e.status === 402 || e.status === 403)) {
      return {
        skipped:
          "Zernio analytics not enabled on this plan (upgrade to usage-based)",
        rows: 0,
      };
    }
    throw e;
  }
  const itemFor = await itemIndex(db);
  const capturedAt = new Date().toISOString();
  const rows: MetricRow[] = [];
  for (const p of posts) {
    const entries = p.platforms?.length
      ? p.platforms
      : [
          {
            platform: p.platform ?? "unknown",
            accountId: "",
            platformPostUrl: p.platformPostUrl,
            analytics: p.analytics,
          },
        ];
    for (const e of entries) {
      const a = e.analytics ?? {};
      rows.push({
        zernio_post_id: p._id,
        platform: e.platform,
        captured_at: capturedAt,
        content_item_id: itemFor([p.latePostId, p._id], e.platformPostUrl),
        is_external: !!p.isExternal,
        published_at: p.publishedAt ?? null,
        platform_post_url: e.platformPostUrl ?? null,
        content_preview: (p.content ?? "").slice(0, 280),
        impressions: a.impressions ?? 0,
        reach: a.reach ?? 0,
        likes: a.likes ?? 0,
        comments: a.comments ?? 0,
        shares: a.shares ?? 0,
        saves: a.saves ?? 0,
        clicks: a.clicks ?? 0,
        views: a.views ?? 0,
        engagement_rate: a.engagementRate ?? null,
        extras: metricExtras(a),
      });
    }
  }
  const written = await upsertSnapshots(db, rows);
  return { posts: posts.length, rows: written };
}

export async function syncChannels() {
  const db = adminDb();
  const { accounts, hasAnalyticsAccess } = await listAccounts();
  const date = iso(new Date());
  const rows = accounts.map((a) => ({
    account_id: a._id,
    platform: a.platform,
    username: a.username ?? a.displayName ?? null,
    date,
    followers: a.followersCount ?? null,
    active: a.isActive && !a.needsReconnection,
  }));
  must(
    await db
      .from("gtm_channel_daily")
      .upsert(rows, { onConflict: "account_id,date" }),
    "upsert channel_daily",
  );
  return { accounts: rows.length, hasAnalyticsAccess };
}

export async function syncCrm() {
  const db = adminDb();
  const snap = await crmSnapshot();
  // The capture block rides inside the metrics JSON: gtm_crm_snapshots has no column for it, and needs no migration.
  const row = {
    date: iso(new Date()),
    captured_at: new Date().toISOString(),
    metrics: { ...snap.metrics, meeting_capture: snap.meeting_capture },
    opportunities: snap.opportunities,
  };
  must(await db.from("gtm_crm_snapshots").upsert(row), "upsert crm_snapshots");
  return snap;
}

export type EnrichmentRun = {
  run: string;
  status: string;
  selected: number;
  submitted: number;
  returned: number;
  no_result: number;
  saved: number;
  conflicted: number;
  failed: number;
  credits: number;
  cap_usd: number | null;
  at: string;
};
export async function pushEnrichment(runs: EnrichmentRun[]) {
  must(
    await adminDb().from("gtm_enrichment_runs").upsert(runs),
    "upsert enrichment_runs",
  );
  return { runs: runs.length };
}
