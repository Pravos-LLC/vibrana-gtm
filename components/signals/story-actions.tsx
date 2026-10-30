"use client";

import { useState, useTransition } from "react";
import { actOnSignal } from "@/app/signals/actions";
import { Button } from "@/components/ui/button";
import type { SignalAction } from "@/lib/signals/actions";
import type { StoryFormat, StoryStatus } from "@/lib/signals/config";

const QUEUE: { format: StoryFormat; label: string; title: string }[] = [
  { format: "story", label: "Write story", title: "Queue for the writers-room as a longer piece" },
  { format: "repost", label: "Repost with my take", title: "Queue as a repost or quote with John's view" },
  { format: "video", label: "Video idea", title: "Queue as a video idea" },
];

export function StoryActions({ id, status, format }: { id: string; status: StoryStatus; format: StoryFormat | null }) {
  const [pending, start] = useTransition();
  const [state, setState] = useState<{ status: StoryStatus; format: StoryFormat | null; error?: string }>({ status, format });
  const act = (action: SignalAction, f?: StoryFormat) => start(async () => {
    const r = await actOnSignal(id, action, f);
    setState(r.ok ? { status: r.status as StoryStatus, format: action === "queue" ? f ?? null : action === "restore" ? null : state.format } : { ...state, error: r.error });
  });
  if (state.status === "dismissed") {
    return <div className="flex items-center gap-2"><span className="text-xs text-ink-3">Dismissed</span><Button size="sm" variant="ghost" disabled={pending} onClick={() => act("restore")}>Restore</Button></div>;
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {QUEUE.map((q) => (
          <Button key={q.format} size="sm" variant={state.status === "queued" && state.format === q.format ? "default" : "outline"} title={q.title} disabled={pending} onClick={() => act("queue", q.format)}>
            {q.label}
          </Button>
        ))}
        <Button size="sm" variant="secondary" disabled={pending || state.status === "saved"} onClick={() => act("save")}>{state.status === "saved" ? "Saved" : "Save"}</Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => act("dismiss")}>Not for us</Button>
      </div>
      {state.status === "queued" && <p className="text-xs text-ink-2" role="status">Queued as {state.format}. The writers-room drafts it; nothing posts without approval in Review.</p>}
      {state.status === "drafted" && <p className="text-xs text-ink-2" role="status">Drafted. Find it in Review.</p>}
      {state.error && <p className="text-xs text-red-strong" role="alert">{state.error}</p>}
    </div>
  );
}
