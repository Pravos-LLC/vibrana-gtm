"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Hourglass } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { StoryHold } from "@/lib/season-review";
import { holdHeadline } from "@/lib/stage";

export type HoldResult = { ok: true; hold: StoryHold | null } | { ok: false; error: string };
export type SetHold = (input: { storyId: string; held: boolean; who?: string; note?: string }) => Promise<HoldResult>;

/** The badge a held piece wears wherever it is listed. */
export function HoldBadge({ hold }: { hold: StoryHold }) {
  return (
    <Badge variant="warning" className="gap-1">
      <Hourglass className="size-3" aria-hidden />
      {holdHeadline(hold.who)}
    </Badge>
  );
}

/**
 * Pending third-party approval. Holding a piece keeps approval from scheduling it, even when every platform is
 * approved; "Third party approved" clears the hold, and anything already approved is scheduled into its best open
 * slot straight away. `refresh` re-renders server data afterwards (the Story page); /content keeps it in the browser.
 */
export function ThirdPartyHold({ storyId, initial, onSet, refresh = false, final = true, defaultWho = "" }: {
  storyId: string; initial: StoryHold | null; onSet: SetHold; refresh?: boolean;
  /** The piece's named third party: prefilled so their own approval from a review link releases this hold. */
  defaultWho?: string;
  /** False while the piece's media is short of its final stage (a rough cut): releasing it then schedules nothing. */
  final?: boolean;
}) {
  const [hold, setHold] = useState(initial);
  const [open, setOpen] = useState(false);
  const [who, setWho] = useState(defaultWho);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const router = useRouter();
  const ids = useId();

  const submit = (held: boolean) => {
    setError(null);
    start(async () => {
      const result = await onSet({ storyId, held, who, note });
      if (!result.ok) { setError(`Not saved. ${result.error}`); return; }
      setHold(result.hold);
      setOpen(false);
      setWho(defaultWho); setNote("");
      if (refresh) router.refresh();
    });
  };

  // A third party's sign-off is on the final only: no button until the final is staged (the database refuses it too).
  const canRelease = !!hold && final && (hold.kind !== "third_party" || hold.finalStaged !== false);
  if (hold) {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-[color:var(--amber)]/40 bg-[color:var(--amber)]/5 px-4 py-3" role="status" aria-label="Third-party hold">
        <HoldBadge hold={hold} />
        <span className="min-w-0 flex-1 text-sm">
          {hold.note && <span className="block text-ink">{hold.note}</span>}
          <span className="block text-xs text-ink-3">{canRelease
            ? "Your approval does not publish this piece until they approve the final."
            : `${hold.who || "The third party"} sees the final only, never a rough cut. Once the final is staged, mark their approval here.`}</span>
        </span>
        {canRelease && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => submit(false)}>
            <Check /> {busy ? "Saving…" : `${hold.who || "Third party"} approved the final`}
          </Button>
        )}
        {error && <p role="alert" className="basis-full text-sm text-red-strong">{error}</p>}
      </div>
    );
  }

  if (!open) {
    return (
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        <Hourglass /> Pending third-party approval
      </Button>
    );
  }

  return (
    <form className="grid gap-3 rounded-lg border border-line p-4 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto] sm:items-end"
      onSubmit={(e) => { e.preventDefault(); submit(true); }}>
      <label className="block" htmlFor={`${ids}-who`}>
        <span className="mb-1 block text-xs font-medium text-ink-2">Who (optional)</span>
        <Input id={`${ids}-who`} value={who} maxLength={200} placeholder="example_approver / Example Series" onChange={(e) => setWho(e.target.value)} />
      </label>
      <label className="block" htmlFor={`${ids}-note`}>
        <span className="mb-1 block text-xs font-medium text-ink-2">Note (optional)</span>
        <Input id={`${ids}-note`} value={note} maxLength={2000} placeholder="They only ever see the final" onChange={(e) => setNote(e.target.value)} />
      </label>
      <span className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy}>{busy ? "Holding…" : "Hold for approval"}</Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => { setOpen(false); setError(null); }}>Cancel</Button>
      </span>
      <p className="text-xs text-ink-3 sm:col-span-3">Publishing is blocked until you mark the final approved by them. They only ever see the final.</p>
      {error && <p role="alert" className="text-sm text-red-strong sm:col-span-3">{error}</p>}
    </form>
  );
}
