import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Section, Shell } from "@/components/shell";
import { StatTile } from "@/components/stat-tile";
import { SocialMark } from "@/components/guide/social-mark";
import { ManualEntry } from "@/components/performance/manual-entry";
import { BestTimeHeatmap, FilterRow, Leaderboard, PillarHeatmap, PlatformRows, ReportStrip, StatusChip, SyncLine, num, type Query } from "@/components/performance/parts";
import { TrendChart } from "@/components/performance/trend-chart";
import { Sparkline } from "@/components/stat-tile";
import { COMPARE_LABEL, PLATFORM_LABEL, PLATFORMS, UNIT_LABEL, compact, countDelta, resolveWeek, weekLabel, type CompareMode, type SortKey } from "@/lib/analytics/dashboard";
import { loadPerformance } from "@/lib/analytics/load";
import { loadYouTube } from "@/lib/youtube/view";
import { localDate } from "@/lib/reports/week";
import { sessionDb } from "@/lib/supabase/server";
import { addDays } from "@/lib/week";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Params = { week?: string; compare?: string; platform?: string; sort?: string };
const SORTS: SortKey[] = ["comments", "engagements", "saves_sends", "rate"];
const short = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

export const metadata = { title: "Performance" };

/**
 * Performance, one week at a time (VIB-419). The week is the unit of navigation, the weekly report is the
 * reading, and the numbers below are the evidence. Awareness phase: conversations lead.
 */
export default async function Performance({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const now = new Date();
  const week = resolveWeek(sp.week, localDate(now));
  const compare: CompareMode = sp.compare === "median4" ? "median4" : "prev";
  const platform = sp.platform && PLATFORMS.includes(sp.platform) ? sp.platform : null;
  const sort: SortKey = SORTS.includes(sp.sort as SortKey) ? (sp.sort as SortKey) : "comments";
  const q: Query = { week: week.current ? undefined : week.from, compare, platform, sort };

  const db = await sessionDb();
  const [d, yt] = await Promise.all([loadPerformance(db, { week, compare, platform, sort, now }), !platform || platform === "youtube" ? loadYouTube(db, addDays(week.to, 0)) : Promise.resolve(null)]);
  const t = d.tiles.current;
  const cmp = COMPARE_LABEL[compare];
  // Every tile is a count, so its delta is a whole number.
  const delta = (cur: number | null | undefined, base: number | null, goodWhen: "up" | "down" = "up") => {
    const v = countDelta(cur, base);
    return v == null ? null : { value: v, label: cmp, goodWhen };
  };
  const conv = t.conversations;
  const label = platform ? PLATFORM_LABEL[platform] : null;
  const weekEnded = week.to < localDate(now);

  return (
    <Shell title={label ? `Performance: ${label}` : "Performance"} active="/performance" updated={d.sync.metrics}>
      <div className="space-y-3">
        <FilterRow q={q} from={week.from} prev={addDays(week.from, -7)} next={week.current ? null : addDays(week.from, 7)} seasonWeek={d.season?.week ?? null} current={week.current} />
        <SyncLine sync={d.sync} now={now} />
      </div>
      {d.errors.length > 0 && <p role="alert" className="mt-4 text-sm text-red-strong">Some data could not load: {d.errors.join("; ")}</p>}

      <div className="mt-6"><ReportStrip report={d.report} /></div>

      <div className="mb-12 mt-6 grid grid-cols-2 gap-3 md:grid-cols-4 md:gap-4" data-testid="tiles">
        <StatTile label="Conversations" value={t.conversations ? num(t.conversations.total) : null}
          missing="no comments recorded this week"
          delta={delta(t.conversations?.total, d.tiles.base.conversations)} spark={d.tiles.series.conversations.slice(-8)}
          note={conv ? [
            conv.source === "queue" ? `${num(conv.comments)} comments, ${num(conv.dms)} DMs from others` : "platform comment counts; the comment queue could not be read",
            d.tiles.comparable.conversations ? null : "no comparable week",
          ].filter(Boolean).join("; ") : undefined}
          href={platform ? undefined : "/engage"} />
        <StatTile label="Engagements" value={t.engagements == null ? null : compact(t.engagements)} missing="nothing published this week"
          delta={delta(t.engagements, d.tiles.base.engagements)} spark={d.tiles.series.engagements.slice(-8)}
          note={t.posts ? `on ${t.posts} ${t.posts === 1 ? "post" : "posts"} from this week` : undefined} />
        <StatTile label="Net followers" value={t.netFollowers ? (t.netFollowers.total > 0 ? `+${num(t.netFollowers.total)}` : num(t.netFollowers.total)) : null}
          missing="needs two follower counts in the week" delta={delta(t.netFollowers?.total, d.tiles.base.netFollowers)} spark={d.tiles.series.netFollowers.slice(-8)}
          note={t.netFollowers?.unknown.length ? `${t.netFollowers.unknown.map((p) => PLATFORM_LABEL[p]).join(", ")} unknown` : undefined} />
        <StatTile label="Saves + sends" value={t.savesSends == null ? null : compact(t.savesSends)} missing="nothing published this week"
          delta={delta(t.savesSends, d.tiles.base.savesSends)} spark={d.tiles.series.savesSends.slice(-8)}
          note={t.posts ? "sends where reported" : undefined} />
      </div>

      <Section title={platform ? "This week" : "By platform"} note="each in its own units; reach is never added across platforms">
        <PlatformRows rows={d.rows} q={q} />
        <div className="mt-6 flex flex-wrap items-start justify-between gap-4" data-testid="manual-rows">
          <ul className="flex flex-wrap gap-x-8 gap-y-3 text-sm">
            {d.manualChannels.map((c) => (
              <li key={c.slug} className="flex items-center gap-3">
                <SocialMark channel={c.slug} mono className="size-3.5 text-ink-2" />
                <span className="text-ink-2">{c.label}</span>
                {c.metrics ? (
                  <span className="text-ink">{c.fields.filter((f) => c.metrics![f.key] != null).map((f) => `${num(c.metrics![f.key])}${f.kind === "percent" ? "%" : ""} ${f.key === "ctr" ? "CTR" : f.key}`).join(", ")}</span>
                ) : null}
                {!c.complete && <StatusChip kind={weekEnded ? "manual" : "pending"}>{weekEnded ? "Manual due" : "Manual at week end"}</StatusChip>}
                <Sparkline points={c.series.slice(-8)} />
              </li>
            ))}
          </ul>
          {d.manualChannels.length > 0 && <ManualEntry week={week.from} weekLabel={weekLabel(week.from)} channels={d.manualChannels} initial={d.manualChannels.find((c) => !c.complete)?.slug} />}
        </div>
        <Link href="/pipeline" className="group mt-8 flex flex-wrap items-baseline gap-x-6 gap-y-1 rounded-lg border border-dashed border-line px-4 py-3 text-sm" data-testid="funnel-strip">
          <span className="text-xs font-medium text-ink-3">Later-phase signal, tracked not judged</span>
          <span className="text-ink-2"><b className="font-semibold text-ink">{d.funnel.clicks == null ? "—" : num(d.funnel.clicks)}</b> link clicks from this week&apos;s posts</span>
          <span className="text-ink-2">site visits and high-intent pages <span className="text-ink-3">(Pipeline &gt; Traffic)</span></span>
          <span className="text-ink-2"><b className="font-semibold text-ink">{d.funnel.warmDelta == null ? "—" : `${d.funnel.warmDelta > 0 ? "+" : ""}${d.funnel.warmDelta}`}</b> warm or hot contacts in the CRM{d.funnel.warmDelta == null ? <span className="text-ink-3"> (needs two CRM snapshots)</span> : ""}</span>
          <span className="ml-auto inline-flex items-center gap-1 text-ink-2 group-hover:text-ink">Pipeline <ArrowRight className="size-3.5" aria-hidden /></span>
        </Link>
      </Section>

      <Section title="Leaderboard" note={`posts at least 7 days old, ${short(addDays(week.from, -49))} to ${short(week.to)}`}>
        <Leaderboard rows={d.board.rows} sort={d.board.sort} q={q} cohort={d.board.cohort} rateAllowed={!!platform} />
        {!platform && <p className="mt-2 text-xs text-ink-3">Rates use different denominators per platform, so ranking by rate opens inside one platform.</p>}
      </Section>

      <Section title="Pillar by format" note="median of each pillar's own leading metric; hatched cells have fewer than 3 posts">
        <div className={platform ? "" : "grid gap-8 lg:grid-cols-3"}>
          {d.grids.map((g) => <PillarHeatmap key={g.platform} platform={g.platform} formats={g.formats} rows={g.rows} n={g.n} />)}
        </div>
      </Section>

      <Section title="Best time to post" note={label ?? "all platforms"}>
        <BestTimeHeatmap cells={d.best.cells} max={d.best.max} source={d.best.source} gap={d.best.gap} posts={d.best.posts} tz={d.tz} />
      </Section>

      {yt && (
        <Section title="YouTube" note={`${short(yt.from)} to ${short(yt.to)}, from ${yt.sources.join(" and ") === "api" ? "the YouTube API" : yt.sources.join(" and ")}`}>
          <p className="text-sm text-ink-2" data-testid="yt-summary">
            <b className="font-semibold text-ink">{num(yt.views)}</b> views{yt.watchHours != null ? <>, <b className="font-semibold text-ink">{yt.watchHours}</b> watch hours</> : null}
            {yt.impressions != null ? <>, <b className="font-semibold text-ink">{num(yt.impressions)}</b> thumbnail impressions{yt.ctr != null ? <> at <b className="font-semibold text-ink">{yt.ctr}%</b> click-through</> : null}</> : <span className="text-ink-3"> (impressions arrive with the API reach report)</span>}
            {yt.subs != null ? <>, <b className="font-semibold text-ink">{yt.subs}</b> subscribers gained</> : null}
          </p>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-sm" data-testid="yt-videos">
              <thead className="text-xs text-ink-3"><tr><th className="py-1 pr-4 font-medium">Video</th><th className="px-2 font-medium">Views</th><th className="px-2 font-medium">Impressions</th><th className="px-2 font-medium">CTR</th><th className="px-2 font-medium">Avg % viewed</th><th className="px-2 font-medium">Subs</th><th className="px-2 font-medium">Day 1 share</th></tr></thead>
              <tbody>
                {yt.videos.slice(0, 12).map((v) => (
                  <tr key={v.video_id} className="border-t border-line">
                    <td className="max-w-[22rem] truncate py-1.5 pr-4 text-ink">{v.title}{v.short ? <span className="ml-2 text-xs text-ink-3">Short</span> : null}</td>
                    <td className="px-2 tabular-nums">{num(v.views)}</td>
                    <td className="px-2 tabular-nums">{v.impressions == null ? "—" : num(v.impressions)}</td>
                    <td className="px-2 tabular-nums">{v.ctr == null ? "—" : `${v.ctr}%`}</td>
                    <td className="px-2 tabular-nums">{v.avgPctViewed == null ? "—" : `${v.avgPctViewed}%`}</td>
                    <td className="px-2 tabular-nums">{v.subs == null ? "—" : v.subs}</td>
                    <td className="px-2 tabular-nums">{v.viewsDay1Share == null ? "—" : `${v.viewsDay1Share}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {yt.traffic.length > 0 && <p className="mt-4 text-sm text-ink-2" data-testid="yt-traffic">Views by source: {yt.traffic.slice(0, 6).map((t) => `${t.key} ${t.share}%`).join(", ")}</p>}
          <p className="mt-2 text-xs text-ink-3">Rates are per video over the window; CTR is weighted by impressions. A dash means the source did not report it, not zero. Under about 100 impressions a rate is noise.</p>
        </Section>
      )}

      <Section title="Twelve weeks" note="posts published each week, in each platform's own units">
        <div className="space-y-8" data-testid="small-multiples">
          {d.multiples.map((m) => {
            const x = (iso: string) => short(iso);
            const sum = (k: "reach" | "engagements" | "followers") => {
              const vals = m.weeks.map((w) => w[k]).filter((v): v is number => v != null);
              return vals.length ? `${vals.length} weeks with data; latest ${num(vals.at(-1)!)}, highest ${num(Math.max(...vals))}.` : "No data in these twelve weeks.";
            };
            return (
              <div key={m.platform}>
                <h3 className="mb-3 flex items-center gap-1.5 text-sm font-medium text-ink"><SocialMark channel={m.platform} mono className="size-3.5 text-ink-2" />{PLATFORM_LABEL[m.platform]}</h3>
                <div className="grid gap-6 md:grid-cols-3">
                  <TrendChart compact height={120} title={`${UNIT_LABEL[m.unit][0].toUpperCase()}${UNIT_LABEL[m.unit].slice(1)}`} unit={UNIT_LABEL[m.unit]} xTitle="Week of" summary={`${PLATFORM_LABEL[m.platform]} ${UNIT_LABEL[m.unit]} per week: ${sum("reach")}`} data={m.weeks.map((w) => ({ x: x(w.from), value: w.reach }))} />
                  <TrendChart compact height={120} title="Engagements" unit="engagements" xTitle="Week of" summary={`${PLATFORM_LABEL[m.platform]} engagements per week: ${sum("engagements")}`} data={m.weeks.map((w) => ({ x: x(w.from), value: w.engagements }))} />
                  <TrendChart compact height={120} title="Followers at week end" unit="followers" xTitle="Week of" summary={`${PLATFORM_LABEL[m.platform]} followers at each week's end: ${sum("followers")}`} data={m.weeks.map((w) => ({ x: x(w.from), value: w.followers }))} />
                </div>
              </div>
            );
          })}
        </div>
      </Section>
    </Shell>
  );
}
