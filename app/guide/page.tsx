import { notFound } from "next/navigation";
import { Shell } from "@/components/shell";
import { ChapterChips, ChapterRail, type Chapter } from "@/components/guide/chapter-rail";
import { AssetsChapter, ChannelsChapter, InspirationChapter, PillarsChapter, PipelineChapter, PlanChapter, StoriesChapter, SubstackChapter, VoiceChapter, WhyHero } from "@/components/guide/sections";
import { ASSETS, INSPIRATION, PERSONAL, PILLARS, REGENERA, STORIES, VOICE, WHY } from "@/lib/guide/content";
import { mergeBoard } from "@/lib/guide/inspiration";
import type { Inspiration } from "@/lib/inspiration";
import { BUCKET } from "@/lib/review";
import { MEDIA, mediaKeys, signMedia } from "@/lib/guide/media";
import { groupWeeks, planWindow, type PlanItem } from "@/lib/guide/plan";
import { sessionDb } from "@/lib/supabase/server";
import { CALENDAR } from "@/config/calendar";
import { signedUrls } from "@/lib/sign-urls";

export const dynamic = "force-dynamic";

const CHAPTERS: Chapter[] = [
  { id: "why", title: "The why" },
  { id: "pillars", title: "Four pillars" },
  { id: "stories", title: "Stories we tell" },
  { id: "voice", title: "Voice" },
  { id: "regenera", title: "Regenera" },
  { id: "personal", title: "Sample Author Substack" },
  { id: "assets", title: "Asset library" },
  { id: "channels", title: "Channels" },
  { id: "inspiration", title: "Inspiration" },
  { id: "pipeline", title: "Pipeline" },
  { id: "plan", title: "Ten weeks" },
];

/** Carousels in the asset library, built from the slide keys in media.json (carousel-<slug>-slide-NN). */
function carouselDecks() {
  const decks = new Map<string, string[]>();
  for (const k of mediaKeys("carousel-")) {
    const slug = k.replace(/^carousel-/, "").replace(/-slide-\d+$/, "");
    decks.set(slug, [...(decks.get(slug) ?? []), k]);
  }
  return [...decks].map(([slug, keys]) => ({ slug, title: slug.replace(/-dark$/, " (dark)").replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase()), keys }));
}

export const metadata = { title: "Guide" };

export default async function GuidePage() {
  const db = await sessionDb();
  const { data: identity, error: identityError } = await db.auth.getClaims();
  if (identityError || (identity?.claims?.app_metadata as { gtm_owner?: boolean } | undefined)?.gtm_owner !== true) notFound();
  const today = new Date().toLocaleDateString("en-CA", { timeZone: CALENDAR.timezone });
  const { from, to } = planWindow(today);
  const decks = carouselDecks();
  const keys = [
    ...WHY.wall.map((w) => w.media),
    ...VOICE.voices.map((v) => v.media ?? ""),
    ...PILLARS.flatMap((p) => [p.hero_media, ...p.examples.map((e) => e.media ?? "")]),
    ...STORIES.map((s) => s.real_example?.media ?? ""),
    ...ASSETS.flatMap((a) => a.media),
    ...decks.flatMap((d) => d.keys),
    ...INSPIRATION.map((s) => s.media ?? ""),
  ].filter((k) => k && MEDIA[k]);
  const [cal, insp, m] = await Promise.all([
    db.from("gtm_content_items").select("id, date, time, pillar, format, channels, status, title, media").gte("date", from).lte("date", to).not("status", "in", "(skipped,failed)"),
    db.from("gtm_inspiration").select("*").order("created_at", { ascending: false }),
    signMedia(keys),
  ]);
  const carousels = decks.map((d) => ({ slug: d.slug, title: d.title, slides: d.keys.map((k) => m[k]).filter(Boolean) })).filter((d) => d.slides.length);

  // Saved thumbnails are either external URLs or content-review paths; sign the paths.
  const rows = (insp.data ?? []) as Inspiration[];
  const thumbPaths = rows.map((r) => r.thumbnail_path).filter((p): p is string => !!p && !/^https?:\/\//.test(p));
  const { data: thumbs } = await signedUrls(db, thumbPaths, 60 * 60 * 6, BUCKET);
  const thumbUrl = new Map((thumbs ?? []).map((t) => [t.path ?? "", t.signedUrl as string]));
  const board = mergeBoard(INSPIRATION, rows.map((r) => ({ ...r, thumbnail_path: r.thumbnail_path && (thumbUrl.get(r.thumbnail_path) ?? r.thumbnail_path) })));

  // A still per calendar piece for the ten-week view, signed in one call (missing posters just drop out).
  const weeks = groupWeeks((cal.data ?? []) as PlanItem[], today);
  const thumbPathsPlan = [...new Set(weeks.flatMap((w) => w.days.flatMap((d) => d.entries.flatMap((e) => e.thumbs.slice(0, 4)))))];
  const { data: planSigned } = await signedUrls(db, thumbPathsPlan, 60 * 60 * 6, BUCKET);
  const planThumbs: Record<string, string> = Object.fromEntries((planSigned ?? []).filter((t) => !t.error && t.signedUrl).map((t) => [t.path ?? "", t.signedUrl as string]));

  return (
    <Shell title="Content Guide" active="/guide" wide>
      <ChapterChips chapters={CHAPTERS} />
      <div className="mx-auto grid max-w-[1360px] grid-cols-[minmax(0,1fr)] gap-12 pt-6 lg:grid-cols-[11rem_minmax(0,1fr)]">
        <ChapterRail chapters={CHAPTERS} />
        <article className="min-w-0">
          <WhyHero m={m} />
          <PillarsChapter m={m} />
          <StoriesChapter m={m} />
          <VoiceChapter m={m} />
          <SubstackChapter s={REGENERA} />
          <SubstackChapter s={PERSONAL} />
          <AssetsChapter m={m} carousels={carousels} />
          <ChannelsChapter />
          <InspirationChapter board={board} m={m} />
          <PipelineChapter />
          <PlanChapter weeks={weeks} thumbs={planThumbs} error={cal.error?.message} />
          <p className="pb-10 text-xs text-ink-3">
            Agents: read this guide with <code className="font-mono">gtm guide --json</code> or the files in <code className="font-mono">content/guide/</code>. Strategy prose lives in the hub&apos;s <code className="font-mono">gtm/content/STRATEGY.md</code>.
          </p>
        </article>
      </div>
    </Shell>
  );
}
