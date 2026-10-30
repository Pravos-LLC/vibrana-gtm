// Account-level reach per day (VIB-417): Zernio's analytics dashboard, one call per platform, folded into
// the gtm_channel_daily rows the follower sync already writes. Only days that already have a row are
// filled, so a day before tracking never appears with a follower count of "unknown".
import type { SupabaseClient } from "@supabase/supabase-js";
import { must } from "../db";
import { addDays } from "../week";
import { analyticsDashboard, isSkipped, orSkip } from "../zernio-analytics";

const iso = (d: Date) => d.toISOString().slice(0, 10);

export async function syncChannelReach(db: SupabaseClient, opts: { days?: number; now?: Date } = {}) {
  const to = iso(opts.now ?? new Date());
  const from = addDays(to, -((opts.days ?? 7) - 1));
  const rows = must(await db.from("gtm_channel_daily").select("account_id,platform,date").gte("date", from).lte("date", to), "channel days") as { account_id: string; platform: string; date: string }[];
  const accountsByPlatform = new Map<string, Set<string>>();
  for (const r of rows) accountsByPlatform.set(r.platform, (accountsByPlatform.get(r.platform) ?? new Set()).add(r.account_id));
  const out: Record<string, number | string> = {};
  for (const [platform, accounts] of accountsByPlatform) {
    // The dashboard is per platform; with two accounts on one platform the split is unknown, so skip it.
    if (accounts.size !== 1) { out[platform] = `skipped: ${accounts.size} accounts on ${platform}`; continue; }
    const dash = await orSkip(() => analyticsDashboard({ platform, fromDate: from, toDate: to }));
    if (isSkipped(dash)) { out[platform] = dash.skipped; continue; }
    const days = new Map(dash.daily.map((d) => [d.date, d]));
    const patch = rows.filter((r) => r.platform === platform && days.has(r.date)).map((r) => ({
      account_id: r.account_id, platform, date: r.date, impressions: days.get(r.date)!.impressions, reach: days.get(r.date)!.reach,
    }));
    if (patch.length) must(await db.from("gtm_channel_daily").upsert(patch, { onConflict: "account_id,date" }), "channel reach");
    out[platform] = patch.length;
  }
  return out;
}
