"use client";
import { useState } from "react";
import type { Pillar, Voice } from "@/lib/guide/content";
import { PILLAR_TONE } from "@/lib/guide/presentation";
import { Dial, PillarTabs } from "@/components/guide/pillar-console";
import { cn } from "@/lib/ui/cn";

/** Before and after: one rewrite per pillar, flipped with a toggle so the difference is felt, not read. */
export function BeforeAfter({ items, pillars }: { items: Voice["before_after"]; pillars: Pillar[] }) {
  const [i, setI] = useState(0);
  const [after, setAfter] = useState(true);
  const item = items[i];
  const tone = PILLAR_TONE[item.pillar];
  const name = pillars.find((p) => p.slug === item.pillar)?.name ?? item.pillar;
  return (
    <div className="rounded-2xl border border-line bg-[color:var(--surface-frost)] p-5 md:p-7">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Example">
          {items.map((x, j) => (
            <button key={x.label} type="button" role="tab" aria-selected={j === i} onClick={() => { setI(j); setAfter(true); }}
              className="rounded-full border border-line px-3 py-1.5 text-xs text-ink-2 transition-colors aria-selected:border-[color:var(--border-strong)] aria-selected:text-ink">{x.label}</button>
          ))}
        </div>
        <div className="inline-flex rounded-full border border-line p-0.5 text-xs" role="group" aria-label="Version">
          {(["Before", "After"] as const).map((v) => (
            <button key={v} type="button" aria-pressed={(v === "After") === after} onClick={() => setAfter(v === "After")}
              className={cn("rounded-full px-3 py-1 transition-colors", (v === "After") === after ? "bg-ink text-[color:var(--surface-base)]" : "text-ink-2")}>{v}</button>
          ))}
        </div>
      </div>
      <p className="mt-6 text-xs font-medium" style={{ color: after ? tone : undefined }}>{name}, {after ? "in John's voice" : "site register pasted into a personal post"}</p>
      <p key={`${i}-${after}`} className={cn("guide-rise mt-2 max-w-[62ch] font-display text-pl-xl leading-snug", after ? "text-ink" : "text-ink-3")}>
        {after ? item.after.text : item.before}
      </p>
      <p className="mt-5 max-w-[62ch] text-sm text-ink-2"><span className="font-medium text-ink">Why: </span>{item.why}</p>
    </div>
  );
}

/** The per-pillar voice dial on its own, for the Voice chapter. */
export function DialByPillar({ pillars }: { pillars: Pillar[] }) {
  const [slug, setSlug] = useState(pillars[0].slug);
  const p = pillars.find((x) => x.slug === slug)!;
  return (
    <div className="space-y-6">
      <PillarTabs pillars={pillars} value={slug} onChange={setSlug} compact />
      <Dial pillar={p} />
      <p className="text-sm text-ink-2">Opens on {p.opening.charAt(0).toLowerCase() + p.opening.slice(1)}. Speaks as &ldquo;{p.speaks_as}&rdquo;.</p>
    </div>
  );
}
