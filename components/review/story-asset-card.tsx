"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { decideStoryChannels, saveStoryCopy } from "@/app/stories/actions";
import type { StoryChannel } from "@/lib/story";
import type { SubstackExport } from "@/lib/substack";
import { SubstackExportPanel, type ExportPanelImage } from "@/components/review/substack-export";
import { StageBadge } from "@/components/review/stage-badge";
import { NON_FINAL_APPROVAL, isFinalStage } from "@/lib/stage";
import { SignedVideo } from "@/components/media/signed-video";
import { WatchedImage } from "@/components/media/watched-media";

type Status = StoryChannel["status"];
type Figure = { file: string; url: string; alt: string };

export function StoryAssetCard({
  assetId, title, kind, source, sha256, revision, src, url, reviews, prose, frontmatter, html, figures, substack, stage,
}: {
  assetId: string; title: string; kind: "video" | "image" | "copy" | "link"; source: string;
  sha256: string; revision: number; src: string | null; url: string | null;
  reviews: StoryChannel[]; prose: string; frontmatter: string; html: string; figures: Figure[];
  substack?: { data: SubstackExport; images: ExportPanelImage[] };
  /** Pipeline stage of this asset; a non-final one (a rough cut) is approved as an edit and never scheduled. */
  stage?: string | null;
}) {
  const channels = reviews.map((review) => review.channel);
  const initial: Status = channels.length && reviews.every((review) => review.status === "approved")
    ? "approved"
    : reviews.some((review) => review.status === "rejected") ? "rejected" : "pending";
  const [status, setStatus] = useState<Status>(initial);
  const [draft, setDraft] = useState(prose);
  const [saved, setSaved] = useState(prose);
  const [digest, setDigest] = useState(sha256);
  const [rev, setRev] = useState(revision);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const dirty = draft !== saved;

  function decide(next: Status) {
    setError(null);
    setNotice(null);
    const previous = status;
    setStatus(next);
    start(async () => {
      const result = await decideStoryChannels({
        assetId, channels, status: next, note: "", expectedSha256: digest, expectedRevision: rev,
      });
      if (!result.ok) {
        setStatus(previous);
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  function save() {
    setError(null);
    setNotice(null);
    start(async () => {
      const result = await saveStoryCopy({ assetId, prose: draft, frontmatter, expectedRevision: rev });
      if (!result.ok) { setError(result.error); return; }
      setSaved(draft);
      setDigest(result.sha256);
      setRev(result.revision);
      setStatus("pending");
      setNotice("Saved. Approve it when the wording is ready.");
      router.refresh();
    });
  }

  const approved = status === "approved";
  return (
    <Card glow={false} className="overflow-hidden p-5">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="font-display text-pl-lg font-semibold text-ink">{title}</h2>
          <p className="mt-1 text-xs text-ink-3">{kind}{channels.length ? ` · ${channels.join(", ")}` : ""} · {source}</p>
        </div>
        {kind !== "link" && channels.length > 0 && (
          <span className="flex flex-wrap items-center gap-2">
            <StageBadge stage={stage} />
            <Badge variant={approved ? "success" : status === "rejected" ? "destructive" : "warning"}>
              {approved ? (isFinalStage(stage) ? "Approved" : "Edit approved") : status === "rejected" ? "Needs a change" : "Needs approval"}
            </Badge>
          </span>
        )}
        {kind !== "link" && channels.length === 0 && <Badge variant="info">Reference</Badge>}
      </div>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0">
          {kind === "video" && src && <SignedVideo src={src} controls playsInline preload="metadata" className="max-h-[78vh] w-full rounded-lg bg-black object-contain" />}
          {kind === "image" && src && <WatchedImage src={src} alt={title} className="max-h-[78vh] w-auto max-w-full rounded-lg object-contain" />}
          {(kind === "video" || kind === "image") && !src && <p className="text-sm text-red-strong">Could not load private media.</p>}
          {kind === "copy" && (
            <div>
              <div
                className="max-w-none text-sm leading-relaxed text-ink [&_a]:text-violet-strong [&_h1]:mb-3 [&_h1]:font-display [&_h1]:text-2xl [&_h2]:mb-2 [&_h2]:mt-6 [&_h2]:font-display [&_h2]:text-xl [&_img]:my-4 [&_img]:max-h-80 [&_img]:rounded-lg [&_p]:my-3"
                dangerouslySetInnerHTML={{ __html: html }}
              />
              {figures.length > 0 && !substack && (
                <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {figures.map((figure) => (
                    <a key={figure.file} href={figure.url} download={figure.file} className="block">
                      <WatchedImage
                        src={figure.url}
                        alt={figure.alt || figure.file}
                        draggable
                        onDragStart={(event) => {
                          event.dataTransfer.setData("text/uri-list", figure.url);
                          event.dataTransfer.setData("text/plain", figure.url);
                          event.dataTransfer.setData("DownloadURL", `image/jpeg:${figure.file}:${figure.url}`);
                          event.dataTransfer.effectAllowed = "copy";
                        }}
                        className="h-28 w-full cursor-grab rounded-md object-cover"
                      />
                      <span className="mt-1 block text-xs text-ink-3">{figure.file}</span>
                    </a>
                  ))}
                </div>
              )}
            </div>
          )}
          {kind === "copy" && substack && <SubstackExportPanel data={substack.data} images={substack.images} disabled={pending || dirty} />}
          {kind === "link" && <a href={url ?? "#"} target="_blank" rel="noreferrer" className="text-violet-strong hover:underline">{url}</a>}
        </div>
        {kind !== "link" && channels.length > 0 && (
          <div className="space-y-3">
            {kind === "copy" && (
              <>
                <textarea
                  aria-label={`Edit ${title}`}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  rows={channels.includes("newsletter") || channels.includes("website") ? 16 : 8}
                  className="w-full resize-y rounded-md border border-[color:var(--border-default)] bg-[color:var(--surface-inset)] p-3 text-sm leading-relaxed text-ink"
                />
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={save} disabled={pending || !dirty}>Save caption</Button>
                </div>
              </>
            )}
            <div className="rounded-lg border border-line bg-[color:var(--surface-frost)] p-3">
              {approved ? (
                <Button size="sm" variant="outline" onClick={() => decide("pending")} disabled={pending || dirty}>Unapprove</Button>
              ) : (
                <Button size="sm" onClick={() => decide("approved")} disabled={pending || dirty}>Approve</Button>
              )}
              {dirty && <p className="mt-2 text-xs text-ink-3">Save the caption before approving it.</p>}
              {!isFinalStage(stage) && <p className="mt-2 text-xs text-ink-3">{NON_FINAL_APPROVAL}.</p>}
            </div>
            {notice && <p className="text-sm text-ink-2">{notice}</p>}
            {error && <p className="text-sm text-red-strong">{error}</p>}
          </div>
        )}
      </div>
    </Card>
  );
}
