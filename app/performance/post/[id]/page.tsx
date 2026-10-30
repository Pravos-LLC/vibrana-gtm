import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import { Section, Shell } from "@/components/shell";
import { SocialMark } from "@/components/guide/social-mark";
import { StatusChip, num } from "@/components/performance/parts";
import { TrendChart, type TrendPoint } from "@/components/performance/trend-chart";
import { CALENDAR } from "@/config/calendar";
import { curveBand, growthCurve, itemLookup, PLATFORM_LABEL, postDay, stageOf, UNIT_LABEL, youtubeId, type ItemLite, type Snap } from "@/lib/analytics/dashboard";
import { engagements, ageDays, nativeReach, ownRate, rateBasis, savesAndSends } from "@/lib/analytics/metrics";
import { PILLARS } from "@/lib/guide/content";
import { localDate } from "@/lib/reports/week";
import { sessionDb } from "@/lib/supabase/server";
import { addDays, mondayOf } from "@/lib/week";
import { isSkipped, orSkip, postTimeline, videoRetention } from "@/lib/zernio-analytics";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Item = ItemLite & { body?: string | null; channels?: string[]; published_at?: string | null };
const EXTRA_LABEL: Record<string, string> = {
  sends: "sends", follows: "follows", profile_views: "profile visits", watch_time: "watch time (min)", avg_view_duration: "avg view (s)",
  average_view_duration: "avg view (s)", estimated_minutes_watched: "minutes watched", skip_rate: "skip rate",
};
const zernioKey = () => !!(process.env.ZERNIO_API_KEY || process.env.LATE_API_KEY);

export const metadata = { title: "Post stats" };

/** One post on one platform: its numbers, its growth against its pillar, retention, and the copy as published. */
export default async function PostDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ platform?: string }> }) {
  const { id: raw } = await params;
  const { platform: wanted } = await searchParams;
  const id = decodeURIComponent(raw);
  const db = await sessionDb();
  const now = new Date();

  const { data: history } = await db.from("gtm_post_metrics").select("*").eq("zernio_post_id", id).order("captured_at");
  const all = (history ?? []) as Snap[];
  if (!all.length) notFound();
  const platforms = [...new Set(all.map((s) => s.platform))];
  const platform = wanted && platforms.includes(wanted) ? wanted : platforms[0];
  const snaps = all.filter((s) => s.platform === platform);
  const m = snaps.at(-1)!;

  const { data: itemRows } = await db.from("gtm_content_items").select("id,title,pillar,format,urls,body,channels,published_at");
  const items = (itemRows ?? []) as Item[];
  const item = itemLookup(items)(m) as Item | undefined;
  const pillar = item ? PILLARS.find((p) => p.slug === item.pillar) : undefined;
  const reach = nativeReach(m);
  const unit = UNIT_LABEL[reach.unit];
  const rate = ownRate(m);
  const stage = stageOf(m, now);
  const age = ageDays(m.published_at, now);
  const day = postDay(m);

  // Growth: our daily snapshots, else Zernio's post timeline (cumulative per day).
  let points = snaps.map((s) => ({ at: s.captured_at, value: nativeReach(s).value }));
  let source = "the cockpit's daily snapshots";
  if (points.length < 2 && m.published_at && zernioKey()) {
    try {
      const tl = await orSkip(() => postTimeline(id, {}, { timeoutMs: 4000 }));
      if (!isSkipped(tl)) {
        const key = rateBasis(platform).key;
        const rows = tl.timeline.filter((r) => r.platform === platform).filter((r) => typeof r[key] === "number").map((r) => ({ at: `${r.date}T23:59:00Z`, value: r[key] as number }));
        if (rows.length >= 2) { points = rows; source = "Zernio's post timeline"; }
      }
    } catch { /* keep our snapshots */ }
  }
  // A curve of zeros is a platform that never reported reach for this post: unknown, so no curve.
  const curve = m.published_at && points.some((p) => p.value > 0) ? growthCurve(points, m.published_at) : [];

  // The pillar's band: other settled posts of the same pillar on the same platform, last 12 weeks.
  let band: ReturnType<typeof curveBand> = [];
  let bandN = 0;
  if (item && m.published_at) {
    const since = addDays(localDate(now), -84);
    const { data: peers } = await db.from("gtm_post_metrics_latest").select("zernio_post_id,platform,content_item_id,platform_post_url,published_at").eq("platform", platform).gte("published_at", `${since}T00:00:00Z`);
    const lookup = itemLookup(items);
    const same = ((peers ?? []) as Snap[]).filter((p) => p.zernio_post_id !== id && lookup(p)?.pillar === item.pillar && stageOf(p, now) === "final").slice(0, 40);
    if (same.length) {
      const { data: hist } = await db.from("gtm_post_metrics").select("zernio_post_id,captured_at,impressions,reach,views,platform").eq("platform", platform).in("zernio_post_id", same.map((p) => p.zernio_post_id)).order("captured_at");
      const by = new Map<string, { at: string; value: number }[]>();
      for (const h of (hist ?? []) as Snap[]) by.set(h.zernio_post_id, [...(by.get(h.zernio_post_id) ?? []), { at: h.captured_at, value: nativeReach(h).value }]);
      const curves = same.map((p) => growthCurve(by.get(p.zernio_post_id) ?? [], p.published_at!)).filter((c) => c.length);
      band = curveBand(curves, 3);
      bandN = Math.max(0, ...band.map((b) => b.n));
    }
  }
  const maxDay = Math.max(-1, ...curve.map((c) => c.day), ...band.map((b) => b.day));
  const growth: TrendPoint[] = Array.from({ length: maxDay + 1 }, (_, d) => {
    const c = curve.find((p) => p.day === d);
    const b = band.find((p) => p.day === d);
    return { x: `Day ${d}`, value: c?.value ?? null, band: b ? [b.p25, b.p75] : null, median: b?.p50 ?? null };
  });

  // Retention: YouTube's lifetime curve; Instagram does not report one through Zernio.
  const isVideo = item?.format === "video" || platform === "youtube";
  let retention: TrendPoint[] | null = null;
  let retentionGap: string | null = null;
  if (platform === "youtube") {
    const vid = youtubeId(m.platform_post_url);
    if (!vid) retentionGap = "no YouTube video id on this post";
    else if (!zernioKey()) retentionGap = "no Zernio key on this deployment";
    else {
      try {
        const r = await orSkip(() => videoRetention(vid, CALENDAR.accounts.youtube, {}, { timeoutMs: 4000 }));
        if (isSkipped(r)) retentionGap = r.skipped;
        else if (!r.retentionCurve?.length) retentionGap = r.note ?? "YouTube has no retention data for this video yet";
        else retention = r.retentionCurve.map((p) => ({ x: `${Math.round(p.elapsedVideoTimeRatio * 100)}%`, value: Math.round(p.audienceWatchRatio * 1000) / 10 }));
      } catch (e) {
        retentionGap = `Zernio did not answer (${(e as Error).message.slice(0, 60)})`;
      }
    }
  } else if (platform === "instagram" && isVideo) retentionGap = "Instagram does not report Reel retention through Zernio";

  const extras = Object.entries(m.extras ?? {}).filter(([k, v]) => typeof v === "number" && k !== "sends");
  const figures: { label: string; value: string | null; note?: string }[] = [
    { label: unit[0].toUpperCase() + unit.slice(1), value: reach.value ? num(reach.value) : null, note: reach.value ? undefined : "not reported by the platform" },
    { label: "Comments", value: num(m.comments) },
    { label: "Saves + sends", value: num(savesAndSends(m)), note: m.extras?.sends != null ? `${num(m.saves)} ${m.saves === 1 ? "save" : "saves"}, ${num(m.extras.sends)} ${m.extras.sends === 1 ? "send" : "sends"}` : "sends not reported" },
    { label: "Engagements", value: num(engagements(m)), note: `${num(m.likes)} likes, ${num(m.shares)} shares` },
    { label: "Rate", value: rate ? `${rate.value}%` : null, note: rate ? `engagements per ${rate.per}` : `no ${rateBasis(platform).key} reported` },
    { label: "Link clicks", value: m.clicks ? num(m.clicks) : null, note: m.clicks ? undefined : "none reported" },
  ];
  const title = item?.title ?? ((m.content_preview ?? "").replace(/\s+/g, " ").slice(0, 80) || "Untitled post");
  const copy = item?.body || m.content_preview;

  return (
    <Shell title="Post" active="/performance" updated={m.captured_at}>
      <Link href={`/performance?week=${day ? mondayOf(day) : ""}${platform ? `&platform=${platform}` : ""}`} className="inline-flex items-center gap-1 text-sm text-ink-2 hover:text-ink"><ArrowLeft className="size-3.5" aria-hidden />Week of {day ? mondayOf(day) : "unknown"}</Link>
      <header className="mt-4 max-w-[62ch]">
        <p className="flex flex-wrap items-center gap-2 text-sm text-ink-2">
          <SocialMark channel={platform} mono className="size-4" />{PLATFORM_LABEL[platform] ?? platform}
          <span className="text-ink-3">{day ?? "date unknown"}{age != null ? `, ${age} days old` : ""}</span>
          {stage === "maturing" && <StatusChip kind="maturing">Maturing</StatusChip>}
          {stage === "settling" && <StatusChip kind="pending">Settling until day 7</StatusChip>}
          {m.is_external && platform === "linkedin" && <StatusChip kind="partial">Partial: sent outside Zernio</StatusChip>}
        </p>
        <h2 className="mt-2 font-display text-pl-2xl font-semibold leading-tight tracking-tight text-ink" data-testid="post-title">{title}</h2>
        <p className="mt-2 text-sm text-ink-3">
          {pillar ? `${pillar.name}, judged on ${pillar.leading_metric.label.charAt(0).toLowerCase()}${pillar.leading_metric.label.slice(1)}` : "Not linked to a calendar item"}{item?.format ? `. Format: ${item.format}` : ""}.
          {platforms.length > 1 && <> Also on {platforms.filter((p) => p !== platform).map((p, i) => <span key={p}>{i ? ", " : " "}<Link className="text-blue-strong hover:underline" href={`/performance/post/${encodeURIComponent(id)}?platform=${p}`}>{PLATFORM_LABEL[p] ?? p}</Link></span>)}.</>}
          {m.platform_post_url && <> <a href={m.platform_post_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-blue-strong hover:underline">Open the post<ArrowUpRight className="size-3.5" aria-hidden /></a></>}
        </p>
      </header>

      <dl className="mb-12 mt-8 grid grid-cols-2 gap-x-6 gap-y-6 border-y border-line py-6 sm:grid-cols-3 lg:grid-cols-6" data-testid="post-figures">
        {figures.map((f) => (
          <div key={f.label}>
            <dt className="text-sm text-ink-2">{f.label}</dt>
            <dd className={f.value == null ? "mt-1 text-pl-xl font-semibold text-ink-3" : "mt-1 text-pl-xl font-semibold text-ink"}>{f.value ?? "—"}</dd>
            {f.note && <dd className="mt-0.5 text-xs text-ink-3">{f.note}</dd>}
          </div>
        ))}
        {extras.map(([k, v]) => (
          <div key={k}><dt className="text-sm text-ink-2">{EXTRA_LABEL[k] ?? k.replace(/_/g, " ")}</dt><dd className="mt-1 text-pl-xl font-semibold text-ink">{/rate$/.test(k) && (v as number) <= 1 ? `${Math.round((v as number) * 1000) / 10}%` : num(Math.round((v as number) * 10) / 10)}</dd></div>
        ))}
      </dl>

      <div className="grid gap-12 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-12">
          <Section title="Growth" note={`${unit} by day since publishing, from ${source}`}>
            <TrendChart title={`${unit[0].toUpperCase()}${unit.slice(1)}, cumulative`} unit={unit} valueLabel="this post" bandLabel={bandN ? `middle half of ${bandN} ${pillar?.name ?? ""} posts` : undefined} xTitle="Day"
              summary={curve.length ? `${num(curve.at(-1)!.value)} ${unit} by day ${curve.at(-1)!.day}.${band.length ? ` Pillar median at that day: ${band.find((b) => b.day === curve.at(-1)!.day)?.p50 ?? "not enough posts"}.` : ""}` : "No snapshots yet."}
              data={growth} height={240} connectNulls />
            {!band.length && <p className="mt-2 text-xs text-ink-3">— no pillar band yet: it needs at least 3 settled {pillar?.name ?? "same-pillar"} posts on {PLATFORM_LABEL[platform] ?? platform} with snapshots on the same day of age.</p>}
          </Section>
          {(retention || retentionGap) && (
            <Section title="Retention" note="share of viewers still watching">
              {retention ? <TrendChart title="Audience watching (%)" unit="% watching" xTitle="Point in the video" summary={`Starts at ${retention[0].value}% and ends at ${retention.at(-1)!.value}%.`} data={retention} height={200} />
                : <p className="text-sm text-ink-3">— {retentionGap}.</p>}
            </Section>
          )}
          <Section title="From post to site" note="utm_content tags each link with the calendar item">
            <ol className="flex flex-wrap items-center gap-3 text-sm">
              <li className="rounded-lg border border-line px-3 py-2"><b className="font-semibold text-ink">{m.clicks ? num(m.clicks) : "—"}</b> <span className="text-ink-2">link clicks</span></li>
              <ArrowUpRight className="size-4 rotate-45 text-ink-3" aria-hidden />
              <li className="rounded-lg border border-line px-3 py-2"><b className="font-semibold text-ink">—</b> <span className="text-ink-2">site visits with utm_content={item?.id ?? "?"}</span></li>
              <ArrowUpRight className="size-4 rotate-45 text-ink-3" aria-hidden />
              <li className="rounded-lg border border-line px-3 py-2"><b className="font-semibold text-ink">—</b> <span className="text-ink-2">assessments started</span></li>
            </ol>
            <p className="mt-2 text-xs text-ink-3">Site visits and assessments are recorded on brand.example.com; they are not read into the cockpit yet, so they show as unknown, not zero.</p>
          </Section>
        </div>
        <Section title="As published">
          {copy ? <div className="max-w-[62ch] whitespace-pre-wrap rounded-xl border border-line p-5 text-sm leading-relaxed text-ink-2" data-testid="post-copy">{copy}</div>
            : <p className="text-sm text-ink-3">— the copy was not captured for this post.</p>}
        </Section>
      </div>
    </Shell>
  );
}
