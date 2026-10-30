"use client";

import { useEffect, useState } from "react";
import { Check, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Stage information is driven by the request, never inferred from elapsed time. */
export function DraftProgress({ phase, onStop }: { phase: "saving" | "drafting"; onStop: () => void }) {
  const [started] = useState(() => Date.now());
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [started]);
  const slow = elapsed >= 25;
  return <section aria-label="Drafting progress" className="space-y-3 rounded-lg border border-line bg-[color:var(--surface-inset)] p-4" data-testid="desk-draft-progress">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p role="status" className="flex items-center gap-2 text-sm font-medium text-ink">
        <LoaderCircle aria-hidden="true" className="size-4 motion-safe:animate-spin" />
        {phase === "saving" ? "Saving your current text" : slow ? "Still waiting for the drafting service" : "Drafting three openings"}
      </p>
      <span className="font-mono text-xs tabular-nums text-ink-3" aria-label={`${elapsed} seconds elapsed`}>{elapsed}s / 60s limit</span>
    </div>
    <ol className="grid gap-2 text-xs text-ink-2 sm:grid-cols-3" aria-label="Drafting stages">
      <li aria-current={phase === "saving" ? "step" : undefined} className="flex items-center gap-1.5">{phase === "drafting" ? <Check aria-hidden="true" className="size-3.5" /> : <span>1.</span>} Save current text</li>
      <li aria-current={phase === "drafting" ? "step" : undefined}>2. Draft and check three angles</li>
      <li className="text-ink-3">3. Ready to review</li>
    </ol>
    <p className="text-sm leading-relaxed text-ink-2">{phase === "saving" ? "Waiting for your draft to save before requesting angles." : slow ? "No drafts have arrived yet. You can keep writing or stop waiting. This request stops waiting after 60 seconds." : "The service is using the dossier and your profile. Results appear together after the response is checked. You can keep writing; newer edits stay yours."}</p>
    <Button size="sm" variant="ghost" onClick={onStop}>Stop waiting</Button>
  </section>;
}
