import { publicationOf } from "@/lib/substack";
import { publicationConfig } from "@/lib/publications-server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Shell } from "@/components/shell";
import { StoryAssetCard } from "@/components/review/story-asset-card";
import { ApproveMedia } from "@/components/review/approve-media";
import { ScheduleStory, type ScheduleItem } from "@/components/review/schedule-story";
import { ThirdPartyHold } from "@/components/review/third-party-hold";
import { StageBadge } from "@/components/review/stage-badge";
import { StageBadges } from "@/components/review/stage-badges";
import { PipelineStepper } from "@/components/review/pipeline-stepper";
import { PIPELINES, isFormat } from "@/lib/pipelines";
import { holdFor } from "@/lib/auto-schedule";
import { finalState, pipelineView, stagedStages, type StageRow } from "@/lib/pipeline-state";
import { NON_FINAL_APPROVAL, nonFinal, pieceStage } from "@/lib/stage";
import { setStoryHold } from "@/app/stories/actions";
import { activeCalendar } from "@/lib/calendar-db";
import { suggestSlot } from "@/lib/slots";
import { sessionDb } from "@/lib/supabase/server";
import { BUCKET } from "@/lib/review";
import { renderProse, splitFrontmatter } from "@/lib/render-copy";
import { frontmatterMeta } from "@/lib/frontmatter";
import { publicUrlOf } from "@/lib/public-media";
import { newsletterExport, withoutAlternatives } from "@/lib/newsletter-card";
import type { StoryAsset, StoryChannel } from "@/lib/story";
import { signedUrls } from "@/lib/sign-urls";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ storyId: string }> }) {
  const { storyId } = await params;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(storyId)) return { title: "Story" };
  const { data } = await (await sessionDb()).from("gtm_stories").select("title").eq("id", storyId).maybeSingle();
  return { title: data?.title ? `Piece: ${data.title}` : "Story" };
}

export default async function StoryPage({ params }: { params: Promise<{ storyId: string }> }) {
  const { storyId } = await params;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(storyId)) notFound();
  const db = await sessionDb();
  const { data: story } = await db.from("gtm_stories").select("*").eq("id", storyId).maybeSingle();
  if (!story) notFound();
  const [{ data: assetRows }, { data: itemRows }] = await Promise.all([
    db.from("gtm_story_assets").select("*").eq("story_id", storyId).order("title"),
    db.from("gtm_content_items").select("id,channels,status,date").eq("story_id", storyId).order("id"),
  ]);
  const assets = (assetRows ?? []) as StoryAsset[];
  const ids = assets.map((a) => a.id);
  const { data: reviewRows } = ids.length
    ? await db.from("gtm_story_asset_channels").select("*").in("asset_id", ids).order("channel")
    : { data: [] };
  const reviews = (reviewRows ?? []) as StoryChannel[];
  const [{ data: stageRows }, { data: decisionRows }] = await Promise.all([
    db.from("gtm_story_stages").select("stage,status,note,actor,updated_at").eq("story_id", storyId),
    db.from("gtm_story_stage_decisions").select("id,stage,party,who,decision,note,decided_at").eq("story_id", storyId).order("decided_at"),
  ]);
  const staged = assets.map((a) => ({ ...a, stage: a.stage ?? null }));
  const format: string | null = story.pipeline ?? null;
  const view = isFormat(format) ? pipelineView(PIPELINES[format], (stageRows ?? []) as StageRow[], { stagedStages: stagedStages(staged), final: finalState(staged, reviews) }) : null;
  // A manual hold, or a third party who has not approved the final at its current bytes (lib/third-party.ts).
  const found = await holdFor(db, storyId);
  const thirdParty = story.third_party_who ? { who: story.third_party_who as string, open: found?.kind === "third_party" } : null;
  const decisions = (decisionRows ?? []) as Array<{ id: string; stage: string; party: string; who: string | null; decision: string; note: string; decided_at: string }>;
  const paths = assets.map((a) => a.storage_path).filter((p): p is string => !!p);
  const { data: signed } = await signedUrls(db, paths, 60 * 60, BUCKET);
  const media = new Map((signed ?? []).map((s) => [s.path ?? "", s.signedUrl]));
  const images = assets.filter((asset) => asset.kind === "image" && asset.storage_path).map((asset) => ({
    file: asset.source.split("/").pop() ?? asset.source,
    url: media.get(asset.storage_path!) ?? "",
    alt: asset.title,
    publicUrl: publicUrlOf(asset),
  })).filter((image) => image.url);
  // Pasted newsletters must point at permanent public URLs; signed URLs are a flagged fallback only (lib/newsletter-card.ts).
  const exportSources = assets.filter((asset) => asset.kind === "image" && asset.storage_path)
    .map((asset) => ({ source: asset.source, signedUrl: media.get(asset.storage_path!) ?? null, publicUrl: publicUrlOf(asset), alt: asset.title }));
  const graph = await openGraph(story.link_url);
  // A rough cut can be approved ("the edit is good") but never scheduled, so it counts toward nothing here.
  const stage = pieceStage(assets, story.pipeline ?? null);
  const deciding = withoutAlternatives(assets, reviews); // a published Substack essay and unused header options have nothing left to approve
  const allApproved = !stage && deciding.length > 0 && deciding.every((review) => review.status === "approved");
  const hold = found ? { who: found.who, note: found.note, heldAt: found.heldAt, kind: found.kind, finalStaged: found.finalStaged } : null;
  let scheduleItems: ScheduleItem[] = [];
  // A piece pending third-party approval is never scheduled, so it offers no scheduler until it is released.
  if (allApproved && !hold) {
    try {
      const cal = await activeCalendar(db);
      scheduleItems = cal.items.filter((i) => i.story_id === storyId && (i.status === "drafted" || i.status === "approved")).map((i) => {
        const slot = suggestSlot(i.channels[0], new Date(), cal.timezone);
        return { id: i.id, channel: i.channels[0], title: i.format === "ig_story" ? "Story" : i.format, ...slot };
      });
    } catch { /* legacy file mode: the calendar file lives on the owner's machine, so hosted builds show no scheduler */ }
  }
  const order = { link: 0, video: 1, image: 2, copy: 3 };
  const shown = [...assets].sort((a, b) => order[a.kind] - order[b.kind] || a.title.localeCompare(b.title));
  return (
    <Shell title={story.title} active="/content">
      <Link href="/content" className="mb-5 inline-flex items-center gap-1 text-sm text-ink-2 hover:text-ink"><ArrowLeft className="size-4" /> Content review</Link>
      <Card glow={false} className="mb-7 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
        <a href={story.link_url} target="_blank" rel="noreferrer" className="flex min-w-0 flex-1 gap-4">
          {graph.image && <img src={graph.image} alt="" className="h-20 w-36 shrink-0 rounded-md object-cover" />}
          <span className="min-w-0">
            <span className="text-xs uppercase tracking-wide text-ink-3">Published case study</span>
            <span className="mt-1 block font-medium text-ink">{graph.title || story.link_url}</span>
            {graph.description && <span className="mt-1 block text-sm text-ink-2">{graph.description}</span>}
          </span>
        </a>
          <span className="flex flex-wrap items-center gap-2">
            {view ? <StageBadges view={view} thirdParty={thirdParty} storyId={storyId} /> : <StageBadge stage={stage} />}
            <Badge variant="info">{assets.length} assets</Badge>
          </span>
        </div>
        {view && (
          <section aria-label="Pipeline" className="mt-4 rounded-lg border border-line p-3">
            <PipelineStepper view={view} thirdParty={thirdParty} expanded scheduled={(itemRows ?? []).some((i) => i.status === "scheduled" || i.status === "published")} />
            {decisions.length > 0 && (
              <ul className="mt-3 space-y-1 border-t border-line pt-3 text-xs text-ink-2" aria-label="Decisions">
                {decisions.map((d) => (
                  <li key={d.id}>
                    <span className="tabular-nums text-ink-3">{d.decided_at.slice(0, 16).replace("T", " ")}</span>{" "}
                    <span className="font-medium text-ink">{d.party === "john" ? "John" : d.who ?? "Third party"}</span> {d.decision === "approved" ? "approved" : d.decision === "changes" ? "asked for changes to" : "sent back to"}{" "}
                    {PIPELINES[story.pipeline as keyof typeof PIPELINES]?.stages.find((x) => x.key === d.stage)?.label.toLowerCase() ?? d.stage}{d.note ? `: ${d.note}` : ""}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          {(itemRows ?? []).map((item) => <Badge key={item.id} variant={item.status === "drafted" ? "warning" : "info"}>{item.channels.join(", ")}: {item.status}</Badge>)}
        </div>
        <div className="mt-4"><ThirdPartyHold storyId={storyId} initial={hold} onSet={setStoryHold} refresh final={!stage} /></div>
        <ApproveMedia storyId={storyId} consequence={stage ? NON_FINAL_APPROVAL : undefined} pending={assets.filter((asset) => (asset.kind === "video" || asset.kind === "image") && !nonFinal([asset]).length && reviews.some((review) => review.asset_id === asset.id && review.status !== "approved")).length} />
      </Card>
      <ScheduleStory storyId={storyId} items={scheduleItems} />
      <div className="mt-6 grid gap-6">
        {shown.filter((asset) => asset.kind !== "link").map((asset) => {
          const text = splitFrontmatter(asset.body ?? "");
          const used = images.filter((image) => text.prose.includes(image.file));
          const reviewChannels = reviews.filter((review) => review.asset_id === asset.id).map((review) => review.channel);
          const newsletter = asset.kind === "copy" && (reviewChannels.includes("newsletter") || isNewsletterMeta(frontmatterMeta(text.frontmatter)));
          const exported = newsletter ? newsletterExport(asset.body ?? "", exportSources, publicationConfig()) : null;
          return (
            <StoryAssetCard
              key={asset.id}
              assetId={asset.id}
              title={asset.title}
              kind={asset.kind}
              source={asset.source}
              sha256={asset.sha256}
              revision={asset.revision}
              src={asset.storage_path ? media.get(asset.storage_path) ?? null : null}
              url={asset.url}
              reviews={reviews.filter((review) => review.asset_id === asset.id)}
              prose={text.prose}
              frontmatter={text.frontmatter}
              html={asset.kind === "copy" ? renderProse(text.prose, images) : ""}
              figures={used}
              stage={asset.stage ?? null}
              substack={exported ?? undefined}
            />
          );
        })}
      </div>
    </Shell>
  );
}

async function openGraph(pageUrl: string): Promise<{ title?: string; description?: string; image?: string }> {
  try {
    const response = await fetch(pageUrl, { headers: { "user-agent": "gtm-cockpit" }, signal: AbortSignal.timeout(5000) });
    const html = await response.text();
    const meta = (property: string) => html.match(new RegExp(`property=["']${property}["'][^>]*content=["']([^"']+)["']`, "i"))?.[1]
      ?? html.match(new RegExp(`content=["']([^"']+)["'][^>]*property=["']${property}["']`, "i"))?.[1];
    return { title: decode(meta("og:title")), description: decode(meta("og:description")), image: meta("og:image") };
  } catch {
    return {};
  }
}

function decode(value?: string) {
  return value?.replaceAll("&amp;", "&").replaceAll("&#39;", "'").replaceAll("&quot;", "\"");
}

const isNewsletterMeta = (meta: Record<string, string>) =>
  publicationOf(meta, publicationConfig()) !== null || [meta.channel].some((v) => v !== undefined && /^[a-z]+-substack/.test(String(v)));
