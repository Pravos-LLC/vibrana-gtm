"use client";

import type { ReactNode } from "react";
import { useOverview } from "./review-store";

function Stat({ value, label, tone }: { value: ReactNode; label: string; tone?: "warn" | "bad" }) {
  return (
    <div className="min-w-0">
      <div className={`font-display text-pl-lg font-semibold tabular-nums leading-none ${tone === "bad" ? "text-red-strong" : tone === "warn" ? "text-amber-strong" : "text-ink"}`}>{value}</div>
      <div className="mt-1 text-xs text-ink-3">{label}</div>
    </div>
  );
}

/** Season numbers at a glance. They follow the page live, so approving a part moves them at once. */
export function OverviewStrip({ range, analysis }: { range: string | null; analysis?: ReactNode }) {
  const o = useOverview();
  return (
    <section aria-label="Season overview" className="rounded-xl border border-line bg-[color:var(--surface-frost)] px-5 py-4">
      <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
        <Stat value={o.pieces} label="pieces" />
        <Stat value={o.cards} label="platform cards" />
        <Stat value={`${o.textApproved}/${o.textTotal}`} label="text approved" />
        <Stat value={`${o.assetApproved}/${o.assetTotal}`} label="final media approved" />
        {o.byStage.length > 0 && <Stat value={o.byStage.reduce((n, s) => n + s.n, 0)} label={`waiting on you: ${o.byStage.map((s) => `${s.n} ${s.label.toLowerCase()}${s.n === 1 ? "" : "s"}`).join(", ")}`} tone="warn" />}
        <Stat value={o.openNotes} label={o.openNotes === 1 ? "open note" : "open notes"} tone={o.openNotes ? "warn" : undefined} />
        <Stat value={o.needsChanges} label="need changes" tone={o.needsChanges ? "bad" : undefined} />
        {range && <div className="ml-auto text-right text-sm text-ink-2">{range}</div>}
      </div>
      <div className="mt-4 flex items-center gap-3">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-overlay" role="progressbar" aria-valuenow={o.percent} aria-valuemin={0} aria-valuemax={100} aria-label="Approved">
          <div className="h-full rounded-full transition-[width] duration-300" style={{ width: `${o.percent}%`, background: "var(--gradient-prism)" }} />
        </div>
        <span className="text-xs tabular-nums text-ink-2" title="Final approvals only: an earlier stage (a rough cut) never counts">{o.percent}% approved for publishing</span>
      </div>
      {/* Slot for the season analysis: pass `analysis` from the page and it renders here, full width. */}
      {analysis && <div className="mt-4 border-t border-line pt-4">{analysis}</div>}
    </section>
  );
}
