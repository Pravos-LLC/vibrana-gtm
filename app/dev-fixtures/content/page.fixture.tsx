// Dev-only visual check for the Content review screen. It renders the real components against fixture data
// with fake server calls, because the real page sits behind owner login. Only compiled when
// CONTENT_FIXTURES=1 (see next.config.ts) and the proxy only lets it through outside production.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { notFound } from "next/navigation";
import { Shell } from "@/components/shell";
import { FixtureBoard } from "./fixture-board";
import { buildFixture } from "./fixture-data";
import { analyzeSeason, type PartState, type SeasonInput } from "@/lib/season-analysis";
import { analysisOptions } from "@/lib/seasons";
import { PILLARS } from "@/lib/guide/content";
import { CONTENT_REMEMBERED } from "@/lib/filter-memory";
import { restoreFilters } from "@/lib/filter-memory-server";

export const dynamic = "force-dynamic";

const uri = (file: string, mime: string) => `data:${mime};base64,${readFileSync(join(process.cwd(), "test/fixtures", file)).toString("base64")}`;

export default async function FixturePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (process.env.NODE_ENV === "production" || process.env.CONTENT_FIXTURES !== "1") notFound();
  const params = await searchParams;
  await restoreFilters("/dev-fixtures/content", params, CONTENT_REMEMBERED);
  const media = { image: uri("card.png", "image/png"), poster: uri("poster.jpg", "image/jpeg"), video: uri("clip.mp4", "video/mp4") };
  const fixture = buildFixture(media);
  // A real analysis of the fixture pieces, so the season panel renders exactly what the live page would.
  const state = (s: string): PartState => (s === "approved" ? "approved" : s === "rejected" ? "needs-changes" : "needs-approval");
  const input: SeasonInput = {
    season: { id: "season-1", title: "Season 1: four pillars, ten weeks", description: "John's content from 6 October to 11 December 2026, on his personal accounts and two Substacks.", starts_on: "2026-10-06", ends_on: "2026-12-11", pillars: ["build", "lists", "perspective", "proof"] },
    pieces: fixture.pieces.map((p) => ({
      id: p.storyId, title: p.name, slot: p.slot, date: p.date!, pillar: p.pillar, format: "video" as const, platforms: p.cards.map((c) => c.channel),
      cards: p.cards.map((c) => ({ platform: c.channel, date: p.date!, format: "video" as const, staged: true, text: state(c.textStatus), asset: state(c.assetStatus), versions: [], openNotes: 0, copy: c.copy.prose })),
    })),
  };
  const season = { record: input.season, analysis: analyzeSeason(input, analysisOptions("2026-10-08")), pillarOptions: PILLARS.map((p) => ({ slug: p.slug, name: p.name })) };
  return (
    <Shell title="Content review (fixture)" active="/content" wide>
      <FixtureBoard fixture={fixture} season={season} params={params} latency={Number(Array.isArray(params.latency) ? params.latency[0] : params.latency ?? 1500)} />
    </Shell>
  );
}
