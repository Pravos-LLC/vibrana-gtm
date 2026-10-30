"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { PencilLine } from "lucide-react";
import { saveManualMetrics } from "@/app/performance/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { ManualChannel } from "@/lib/analytics/manual";

/** "Add week's stats": the numbers no API gives us, typed in once a week. */
export function ManualEntry({ week, weekLabel, channels, initial }: { week: string; weekLabel: string; channels: (ManualChannel & { metrics: Record<string, number> | null })[]; initial?: string }) {
  const [open, setOpen] = useState(false);
  const [channel, setChannel] = useState(initial ?? channels[0]?.slug ?? "");
  const [values, setValues] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const ch = channels.find((c) => c.slug === channel);

  const pick = (slug: string) => {
    setChannel(slug);
    const prior = channels.find((c) => c.slug === slug)?.metrics ?? {};
    setValues(Object.fromEntries(Object.entries(prior).map(([k, v]) => [k, String(v)])));
    setError(null);
    setSaved(null);
  };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    start(async () => {
      const r = await saveManualMetrics({ week, channel, values, note });
      if (!r.ok) return setError(r.error);
      setSaved(`Saved ${ch?.label} for the week of ${weekLabel}.`);
      router.refresh();
    });
  };

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => { pick(channel); setOpen(true); }}>
        <PencilLine aria-hidden />Add week&apos;s stats
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetHeader>
          <SheetTitle>Add week&apos;s stats</SheetTitle>
          <p className="text-sm text-ink-2">Week of {weekLabel}. Numbers no API gives us; leave a field empty if you don&apos;t have it.</p>
        </SheetHeader>
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto" aria-label="Manual stats">
          <div className="grid gap-2">
            <Label htmlFor="manual-channel">Channel</Label>
            <select id="manual-channel" value={channel} onChange={(e) => pick(e.target.value)}
              className="h-10 rounded-md border border-[color:var(--border-default)] bg-[color:var(--surface-base)] px-3 text-sm text-ink">
              {channels.map((c) => <option key={c.slug} value={c.slug}>{c.label}</option>)}
            </select>
          </div>
          {ch?.fields.map((f) => (
            <div key={`${channel}-${f.key}`} className="grid gap-2">
              <Label htmlFor={`manual-${f.key}`}>{f.label}{ch.required.includes(f.key) ? "" : " (optional)"}</Label>
              <Input id={`manual-${f.key}`} inputMode="decimal" autoComplete="off" value={values[f.key] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} aria-describedby={f.hint ? `manual-${f.key}-hint` : undefined} />
              {f.hint && <p id={`manual-${f.key}-hint`} className="text-xs text-ink-3">{f.hint}</p>}
            </div>
          ))}
          <div className="grid gap-2">
            <Label htmlFor="manual-note">Note (optional)</Label>
            <Input id="manual-note" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          {error && <p role="alert" className="text-sm text-red-strong">{error}</p>}
          {saved && <p role="status" className="text-sm text-emerald-strong">{saved}</p>}
          <div className="mt-auto flex gap-2 pt-2">
            <Button type="submit" disabled={pending}>{pending ? "Saving" : "Save stats"}</Button>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Close</Button>
          </div>
        </form>
      </Sheet>
    </>
  );
}
