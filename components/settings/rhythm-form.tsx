"use client";
// The weekly rhythm, edited on screen (app/settings): each day's pillar, its fallbacks and channels, and the pillars a
// channel never takes. Saving applies it at once to the calendar, the lint and the scheduler.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/ui/cn";
import type { RhythmSetting } from "@/lib/rhythm-settings";
import type { Lane } from "@/lib/rhythm";

const LANES: Array<{ value: Lane; label: string }> = [
  { value: "perspective", label: "Perspective" }, { value: "proof", label: "Proof" }, { value: "build", label: "Build" },
  { value: "lists", label: "Lists" }, { value: "voices", label: "Voices (conversation clip)" }, { value: "reels", label: "Reels (footage)" },
];
const CHANNELS = [{ value: "linkedin", label: "LinkedIn" }, { value: "instagram", label: "Instagram" }, { value: "youtube", label: "YouTube" }];
const PILLARS = ["perspective", "proof", "build", "lists"];
const name = (p: string) => p.charAt(0).toUpperCase() + p.slice(1);

export function RhythmForm({ initial, source, save, reset }: {
  initial: RhythmSetting; source: "setting" | "guide";
  save: (v: RhythmSetting) => Promise<{ ok: true } | { ok: false; error: string }>;
  reset: () => Promise<{ ok: true } | { ok: false; error: string }>;
}) {
  const [v, setV] = useState<RhythmSetting>(initial);
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const router = useRouter();
  const day = (i: number, patch: Partial<RhythmSetting["days"][number]>) => setV({ ...v, days: v.days.map((d, j) => (j === i ? { ...d, ...patch } : d)) });
  const toggle = <T,>(xs: T[], x: T) => (xs.includes(x) ? xs.filter((y) => y !== x) : [...xs, x]);
  const blockedFor = (c: string) => v.blocked.find((b) => b.channel === c)?.pillars ?? [];
  const setBlocked = (c: string, pillars: string[]) => setV({ ...v, blocked: [...v.blocked.filter((b) => b.channel !== c), ...(pillars.length ? [{ channel: c, pillars }] : [])] });
  const run = (call: () => Promise<{ ok: true } | { ok: false; error: string }>, done: string) => start(async () => {
    setMsg(null);
    const r = await call();
    setMsg(r.ok ? done : r.error);
    if (r.ok) router.refresh();
  });
  return (
    <div className="space-y-8">
      <p className="text-sm text-ink-2">{source === "setting" ? "This is the rhythm you saved." : "This is the guide's rhythm. Saving it here makes it yours to change."}</p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[44rem] text-sm">
          <thead><tr className="text-left text-xs text-ink-3"><th className="py-2 pr-4">Day</th><th className="pr-4">Posts</th><th className="pr-4">When none is ready</th><th>Channels</th></tr></thead>
          <tbody>
            {v.days.map((d, i) => (
              <tr key={d.day} className="border-t border-line align-top">
                <td className="py-3 pr-4 font-medium text-ink">{d.day}</td>
                <td className="py-3 pr-4">
                  <select aria-label={`${d.day} pillar`} className="rounded-md border border-line bg-transparent px-2 py-1" value={d.primary ?? ""}
                    onChange={(e) => { const p = (e.target.value || null) as Lane | null; day(i, p ? { primary: p } : { primary: null, fallback: [], channels: [] }); }}>
                    <option value="">Off</option>
                    {LANES.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
                  </select>
                </td>
                <td className="py-3 pr-4">
                  <div className="flex flex-wrap gap-1.5">
                    {LANES.filter((l) => l.value !== d.primary).map((l) => (
                      <label key={l.value} className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs", d.fallback.includes(l.value) ? "border-violet/50 bg-violet/10 text-ink" : "border-line text-ink-3", !d.primary && "opacity-40")}>
                        <input type="checkbox" className="sr-only" disabled={!d.primary} checked={d.fallback.includes(l.value)} onChange={() => day(i, { fallback: toggle(d.fallback, l.value) })} />{l.label.split(" ")[0]}
                      </label>
                    ))}
                  </div>
                </td>
                <td className="py-3">
                  <div className="flex flex-wrap gap-1.5">
                    {CHANNELS.map((c) => (
                      <label key={c.value} className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs", d.channels.includes(c.value) ? "border-violet/50 bg-violet/10 text-ink" : "border-line text-ink-3", !d.primary && "opacity-40")}>
                        <input type="checkbox" className="sr-only" disabled={!d.primary} checked={d.channels.includes(c.value)} onChange={() => day(i, { channels: toggle(d.channels, c.value) })} />{c.label}
                      </label>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="space-y-2">
        <h2 className="text-sm font-medium text-ink">Pillars a channel never takes</h2>
        {CHANNELS.map((c) => (
          <div key={c.value} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="w-24 text-ink-2">{c.label}</span>
            {PILLARS.map((p) => {
              const on = blockedFor(c.value).includes(p);
              return (
                <label key={p} className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs", on ? "border-red-strong/50 bg-red-strong/10 text-ink" : "border-line text-ink-3")}>
                  <input type="checkbox" className="sr-only" checked={on} onChange={() => setBlocked(c.value, toggle(blockedFor(c.value), p))} />never {name(p)}
                </label>
              );
            })}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={busy} onClick={() => run(() => save(v), "Saved. The calendar, the lint and the scheduler use it now.")}>Save the rhythm</Button>
        {source === "setting" && <Button variant="outline" disabled={busy} onClick={() => run(reset, "Back to the guide's rhythm.")}>Use the guide's rhythm</Button>}
        {msg && <p className="text-sm text-ink-2" role="status">{msg}</p>}
      </div>
    </div>
  );
}
