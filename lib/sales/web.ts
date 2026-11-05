// Site traffic for the pipeline dashboard: one row per site and finished UTC day in gtm_web_daily, from the Vercel Web
// Analytics API (public since 2026-05; https://vercel.com/docs/analytics/web-analytics-api). Read-only, aggregates only.
//
// Config (production env only; this public repo holds no ids or tokens):
//   VERCEL_ANALYTICS_TOKEN  a read-capable Vercel access token
//   VERCEL_TEAM_ID          the team the projects belong to
//   VERCEL_ANALYTICS_SITES  JSON [{ "site": "brand.example.com", "projectId": "prj_..." }]
//
// Facts measured 2026-11-05 on the Pro plan: /visits/count takes full ISO bounds as given; /visits/aggregate moves
// `until` one hour later, so a day's breakdown asks until 23:00. requestPath and referrerHostname group on Pro; UTM
// dimensions answer 402 without the Web Analytics Plus add-on, so UTM rows stay empty until it is on.
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertLiveProvidersAllowed, providerFetch } from "../demo-safety";
import { must } from "../db";
import { isHighIntent } from "./metrics";
import type { SalesSettings } from "./settings";

const API = "https://api.vercel.com/v1/query/web-analytics/visits";
export type WebSite = { site: string; projectId: string };
export type WebConfig = { token: string; teamId: string; sites: WebSite[] };

export function webConfig(env: Record<string, string | undefined> = process.env): WebConfig | null {
  const token = env.VERCEL_ANALYTICS_TOKEN?.trim(), teamId = env.VERCEL_TEAM_ID?.trim();
  if (!token || !teamId || !env.VERCEL_ANALYTICS_SITES) return null;
  let sites: unknown;
  try { sites = JSON.parse(env.VERCEL_ANALYTICS_SITES); } catch { throw new Error("VERCEL_ANALYTICS_SITES is not valid JSON"); }
  if (!Array.isArray(sites) || sites.some((s) => !s || typeof s.site !== "string" || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(s.site) || typeof s.projectId !== "string" || !/^prj_[A-Za-z0-9]+$/.test(s.projectId)))
    throw new Error("VERCEL_ANALYTICS_SITES must be a list of { site, projectId }");
  return { token, teamId, sites: sites as WebSite[] };
}

type Row = { visitors: number; pageviews: number } & Record<string, unknown>;

export async function fetchDay(cfg: WebConfig, site: WebSite, day: string, highIntent: string[], fetcher: typeof fetch = fetch) {
  assertLiveProvidersAllowed();
  const get = async (path: string, extra: Record<string, string>) => {
    const q = new URLSearchParams({ teamId: cfg.teamId, projectId: site.projectId, ...extra });
    const res = await providerFetch(fetcher)(`${API}/${path}?${q}`, { headers: { Authorization: `Bearer ${cfg.token}` }, cache: "no-store", signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw Object.assign(new Error(`Vercel analytics ${res.status} for ${site.site}`), { status: res.status });
    return (await res.json()) as { data: unknown };
  };
  const start = `${day}T00:00:00Z`;
  const next = new Date(Date.parse(start) + 86_400_000).toISOString();
  const lastHour = new Date(Date.parse(start) + 23 * 3_600_000).toISOString();
  const total = (await get("count", { since: start, until: next })).data as { visitors: number; pageviews: number };
  const by = async (dim: string) => (((await get("aggregate", { since: start, until: lastHour, by: dim, limit: "50" })).data ?? []) as Row[])
    .filter((r) => typeof r[dim] === "string" && r[dim] !== "Others" && r[dim] !== "")
    .map((r) => ({ key: String(r[dim]).slice(0, 200), n: Number(r.visitors) || 0 }));
  const paths = await by("requestPath");
  const referrers = await by("referrerHostname");
  return {
    site: site.site, day, visitors: Number(total.visitors) || 0, pageviews: Number(total.pageviews) || 0,
    high_intent: paths.filter((p) => isHighIntent(p.key, highIntent)).reduce((a, p) => a + p.n, 0),
    paths: paths.slice(0, 25), referrers: referrers.slice(0, 25), utm: [] as { key: string; n: number }[],
  };
}

/** Finished UTC days a site still needs, oldest first: from the day after its newest row (or `backfillDays` ago) to yesterday. */
export function daysToFetch(newest: string | null, now: Date, backfillDays = 30, max = 10): string[] {
  const yesterday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 86_400_000);
  let d = newest ? new Date(Date.parse(`${newest}T00:00:00Z`) + 86_400_000) : new Date(yesterday.getTime() - (backfillDays - 1) * 86_400_000);
  const out: string[] = [];
  while (d <= yesterday && out.length < max) { out.push(d.toISOString().slice(0, 10)); d = new Date(d.getTime() + 86_400_000); }
  return out;
}

export type WebRun = Record<string, { days: number; error?: string }> & { skipped?: string };

export async function syncWeb(db: SupabaseClient, s: SalesSettings, now: Date, opts: { cfg?: WebConfig | null; fetcher?: typeof fetch; deadline?: number } = {}): Promise<WebRun> {
  const cfg = opts.cfg === undefined ? webConfig() : opts.cfg;
  if (!cfg) return { skipped: "VERCEL_ANALYTICS_TOKEN, VERCEL_TEAM_ID or VERCEL_ANALYTICS_SITES is not set" } as WebRun;
  const out: WebRun = {} as WebRun;
  for (const site of cfg.sites) {
    const r = (out[site.site] = { days: 0 } as { days: number; error?: string });
    try {
      const { data } = await db.from("gtm_web_daily").select("day").eq("site", site.site).order("day", { ascending: false }).limit(1);
      for (const day of daysToFetch((data?.[0] as { day: string } | undefined)?.day ?? null, now)) {
        if (opts.deadline && Date.now() > opts.deadline) break;
        const row = await fetchDay(cfg, site, day, s.highIntentPaths[site.site] ?? [], opts.fetcher);
        must(await db.from("gtm_web_daily").upsert({ ...row, captured_at: now.toISOString() }, { onConflict: "site,day" }), "save site day");
        r.days++;
      }
    } catch (e) { r.error = (e as Error).message.slice(0, 200); }
  }
  return out;
}
