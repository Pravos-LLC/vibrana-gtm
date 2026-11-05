// Pipeline > Traffic: attention on the three sites (vibrana.ai, john-ellison.com, aiosbrain.dev) from the Vercel Web
// Analytics API, the visits that signal intent, and the website front doors (the page that used to be /front-doors).
// Visitors are context, not a goal: the column that matters is high-intent visits and what they turn into.
import { redirect } from "next/navigation";
import { Section, Shell, Table } from "@/components/shell";
import { StatTile } from "@/components/stat-tile";
import { TrendChart } from "@/components/performance/trend-chart";
import { FrontDoorsReport } from "@/components/sales/front-doors-report";
import { SalesNav } from "@/components/sales/nav";
import { SourceNote } from "@/components/sales/parts";
import { adminDb } from "@/lib/db";
import { loadFrontDoors } from "@/lib/front-doors";
import { todayIn } from "@/lib/posts-db";
import { loadSettings, loadWeb, parsePeriod } from "@/lib/sales/load";
import { webStats, windowFor } from "@/lib/sales/metrics";
import { webConfig } from "@/lib/sales/web";
import { sessionDb } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const maxDuration = 30;
export const metadata = { title: "Traffic" };

const WEEKS = 8;

export default async function Traffic({ searchParams }: { searchParams: Promise<{ owner?: string; period?: string }> }) {
  const sp = await searchParams;
  const period = parsePeriod(sp.period);
  const now = new Date();
  const w = windowFor(period, now);
  const db = await sessionDb();
  const { data: claims } = await db.auth.getClaims();
  // The site's lead tables are service-role only, so the owner claim is checked here before the secret-key read.
  if ((claims?.claims?.app_metadata as { gtm_owner?: boolean } | undefined)?.gtm_owner !== true) redirect("/login");
  const [{ settings: s }, web, report] = await Promise.all([
    loadSettings(db), loadWeb(db, w.start), loadFrontDoors(adminDb(), { today: todayIn("UTC"), weeks: WEEKS }),
  ]);
  let configured = true;
  try { configured = !!webConfig(); } catch { configured = false; }
  const sites = web.data ? webStats(web.data, w) : [];

  return (
    <Shell title="Traffic" active="/pipeline">
      <SalesNav active="/pipeline/traffic" owner={null} period={period} showOwner={false} />
      {web.error && <SourceNote tone="bad">Site traffic could not be read ({web.error}).</SourceNote>}
      {!sites.length && !web.error && (
        <SourceNote>{configured ? "No site traffic stored for this period yet; the pipeline cron fills one finished day per site each hour." : "Site traffic is not connected: set VERCEL_ANALYTICS_TOKEN, VERCEL_TEAM_ID and VERCEL_ANALYTICS_SITES in production."}</SourceNote>
      )}
      {sites.map((site) => (
        <Section key={site.site} title={site.site} note={`${site.days} ${site.days === 1 ? "day" : "days"} stored in the period`}>
          <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
            <StatTile label="Visitors" value={site.visitors.toLocaleString("en-US")} note="daily visitors, summed" />
            <StatTile label="High-intent visits" value={site.highIntent == null ? null : site.highIntent.toLocaleString("en-US")} missing="no paths read"
              note={(s.highIntentPaths[site.site] ?? []).join(", ") || "no high-intent paths set"} />
            <StatTile label="Page views" value={site.pageviews.toLocaleString("en-US")} />
            <StatTile label="Top referrer" value={site.referrers[0]?.key ?? null} missing="none recorded" note={site.referrers[0] ? `${site.referrers[0].n} visitors` : undefined} />
          </div>
          <div className="grid gap-6 lg:grid-cols-[2fr_1fr_1fr]">
            <TrendChart title="Visitors a day" unit="visitors" summary={`${site.site} visitors per day`} data={site.series.map((p) => ({ x: p.day.slice(5), value: p.visitors }))} />
            <Table head={["Page", "Visitors"]} align={["l", "r"]} rows={site.paths.map((p) => [p.key, p.n])} />
            <Table head={["Referrer", "Visitors"]} align={["l", "r"]} rows={site.referrers.map((p) => [p.key, p.n])} />
          </div>
        </Section>
      ))}
      <p className="mb-12 text-sm text-ink-3">UTM sources are not grouped: the Vercel Pro plan needs the Web Analytics Plus add-on for that. Referrers and pages are.</p>

      <h2 className="mb-6 border-t border-line pt-8 font-display text-pl-xl font-semibold tracking-tight text-ink">Front doors</h2>
      <FrontDoorsReport report={report} weeks={WEEKS} />
    </Shell>
  );
}
