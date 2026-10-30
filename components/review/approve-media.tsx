"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { approveAllMedia } from "@/app/stories/actions";

export function ApproveMedia({ storyId, pending, consequence }: { storyId: string; pending: number; consequence?: string }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const router = useRouter();
  if (!pending) return null;
  return (
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <Button
        size="sm"
        disabled={busy}
        onClick={() => {
          setError(null);
          start(async () => {
            const result = await approveAllMedia(storyId);
            if (!result.ok) { setError(result.error); return; }
            router.refresh();
          });
        }}
      >
        Approve {pending} video{pending === 1 ? "" : "s"} and cover{pending === 1 ? "" : "s"}
      </Button>
      {consequence && <span className="text-xs text-ink-3">{consequence}.</span>}
      {error && <p className="text-sm text-red-strong">{error}</p>}
    </div>
  );
}
