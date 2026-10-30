"use client";

import { useState, useTransition } from "react";
import { Check } from "lucide-react";
import { resolveRedFlag } from "@/app/engage/actions";
import { Button } from "@/components/ui/button";

/** "Resolve" on a red flag: John has handled it. The note is optional and teaches the model what this was. */
export function ResolveFlag({ postKey }: { postKey: string }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [state, setState] = useState<{ done?: string; error?: string }>({});
  const [pending, start] = useTransition();
  if (state.done) return <p className="text-xs text-ink-2" role="status"><Check className="mr-1 inline size-3.5" aria-hidden />{state.done}</p>;
  if (!open) return <button type="button" onClick={() => setOpen(true)} className="text-xs text-violet-strong hover:underline">Resolve</button>;
  const submit = () => start(async () => {
    const r = await resolveRedFlag(postKey, note);
    setState(r.ok ? { done: r.message } : { error: r.error });
  });
  return (
    <div className="space-y-2" data-testid="resolve-flag">
      <label className="block text-xs text-ink-2" htmlFor={`resolve-${postKey}`}>What happened? (optional, the model reads this, e.g. "the guest already answered these, fine")</label>
      <textarea id={`resolve-${postKey}`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={400} rows={2}
        className="w-full rounded-md border border-line bg-[color:var(--surface-inset)] p-2 text-sm text-ink" />
      {state.error && <p className="text-xs text-red-strong" role="alert">{state.error}</p>}
      <div className="flex gap-2">
        <Button size="sm" onClick={submit} disabled={pending}>{pending ? "Resolving…" : "Resolve"}</Button>
        <Button size="sm" variant="outline" onClick={() => setOpen(false)} disabled={pending}>Cancel</Button>
      </div>
    </div>
  );
}
