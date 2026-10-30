"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { decideStoryAsset } from "@/app/stories/actions";
import type { StoryChannel } from "@/lib/story";

const tone = { pending: "warning", approved: "success", rejected: "destructive" } as const;

export function StoryAssetDecision({ assetId, sha256, revision, review }: { assetId: string; sha256: string; revision: number; review: StoryChannel }) {
  const [note, setNote] = useState(review.note ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const decide = (status: StoryChannel["status"]) => {
    setError(null);
    start(async () => {
      const result = await decideStoryAsset({ assetId, channel: review.channel, status, note, expectedSha256: sha256, expectedRevision: revision });
      if (!result.ok) { setError(result.error); return; }
      router.refresh();
    });
  };
  return (
    <div className="rounded-lg border border-line bg-[color:var(--surface-frost)] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium capitalize text-ink">{review.channel}</span>
        <Badge variant={tone[review.status]}>{review.status}</Badge>
      </div>
      <textarea
        aria-label={`Review note for ${review.channel}`}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        rows={2}
        placeholder="What needs to change?"
        className="mt-3 w-full resize-y rounded-md border border-[color:var(--border-default)] bg-[color:var(--surface-inset)] p-2 text-sm text-ink"
      />
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" onClick={() => decide("approved")} disabled={pending}>Approve for {review.channel}</Button>
        <Button size="sm" variant="destructive" onClick={() => decide("rejected")} disabled={pending}>Reject</Button>
        {review.status !== "pending" && <Button size="sm" variant="secondary" onClick={() => decide("pending")} disabled={pending}>Reset</Button>}
      </div>
      {error && <p className="mt-2 text-sm text-red-strong">{error}</p>}
    </div>
  );
}
