"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { scheduleStory } from "@/app/stories/actions";

export type ScheduleItem = { id: string; channel: string; title: string; date: string; time: string };

export function ScheduleStory({ storyId, items }: { storyId: string; items: ScheduleItem[] }) {
  const [slots, setSlots] = useState(() => Object.fromEntries(items.map((i) => [i.id, { date: i.date, time: i.time }])));
  const [message, setMessage] = useState<{ ok: boolean; lines: string[] } | null>(null);
  const [busy, start] = useTransition();
  const router = useRouter();
  if (!items.length) return null;
  return (
    <div className="mt-6 rounded-lg border border-line p-4">
      <h2 className="font-display text-pl-lg font-semibold text-ink">Everything is approved</h2>
      <p className="mt-1 text-sm text-ink-2">Pick when each network publishes. Suggestions follow when each audience is online; change them freely.</p>
      <div className="mt-4 grid gap-3">
        {items.map((item) => (
          <label key={item.id} className="flex flex-wrap items-center gap-3 text-sm text-ink">
            <span className="w-56 font-medium capitalize">{item.channel}: <span className="font-normal text-ink-2">{item.title}</span></span>
            <input type="date" value={slots[item.id].date} onChange={(e) => setSlots({ ...slots, [item.id]: { ...slots[item.id], date: e.target.value } })} className="rounded-md border border-line bg-transparent px-2 py-1" />
            <input type="time" value={slots[item.id].time} onChange={(e) => setSlots({ ...slots, [item.id]: { ...slots[item.id], time: e.target.value } })} className="rounded-md border border-line bg-transparent px-2 py-1" />
          </label>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button disabled={busy} onClick={() => {
          setMessage(null);
          start(async () => {
            const result = await scheduleStory(storyId, slots);
            setMessage({ ok: result.ok, lines: result.ok ? result.summary : [...result.summary, result.error] });
            if (result.ok) router.refresh();
          });
        }}>{busy ? "Scheduling…" : "Schedule for publishing"}</Button>
        {message && <ul className={`text-sm ${message.ok ? "text-ink-2" : "text-red-strong"}`}>{message.lines.map((l) => <li key={l}>{l}</li>)}</ul>}
      </div>
    </div>
  );
}
