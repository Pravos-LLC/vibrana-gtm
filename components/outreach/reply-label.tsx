"use client";
// John's call on a reply in the outreach inbox: positive replies are the conversations Pipeline counts. One click,
// and the same click again clears it.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/ui/cn";

type Sentiment = "positive" | "neutral" | "not_now" | "negative" | "unsubscribe";
const LABELS: { value: Sentiment; label: string }[] = [
  { value: "positive", label: "Positive" }, { value: "neutral", label: "Neutral" }, { value: "not_now", label: "Not now" },
  { value: "negative", label: "No" }, { value: "unsubscribe", label: "Unsubscribe" },
];

export function ReplyLabel({ draftId, current, label }: { draftId: string; current: Sentiment | null; label: (id: string, s: Sentiment | null) => Promise<{ ok: true } | { ok: false; error: string }> }) {
  const [value, setValue] = useState<Sentiment | null>(current);
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-4 pb-3" role="group" aria-label="Label this reply">
      {LABELS.map((l) => (
        <button key={l.value} type="button" disabled={busy} aria-pressed={value === l.value}
          className={cn("rounded-full border px-2.5 py-0.5 text-xs", value === l.value ? (l.value === "positive" ? "border-emerald-strong bg-[color:var(--emerald)]/15 text-emerald-strong" : "border-[color:var(--border-strong)] text-ink") : "border-line text-ink-3 hover:text-ink-2")}
          onClick={() => start(async () => {
            const next = value === l.value ? null : l.value;
            setError(null);
            const r = await label(draftId, next);
            if (r.ok) { setValue(next); router.refresh(); } else setError(r.error);
          })}>{l.label}</button>
      ))}
      {error && <span role="alert" className="text-xs text-red-strong">{error}</span>}
    </div>
  );
}
