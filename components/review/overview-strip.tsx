"use client";

import type { ReactNode } from "react";
import { useOverview } from "./review-store";
import { ContentDetails } from "./content-details";

function Stat({ value, label, tone, title }: { value: ReactNode; label: string; tone?: "warn" | "bad"; title?: string }) {
  return (
    <span title={title} className={`inline-flex flex-wrap items-baseline gap-x-1.5 text-sm ${tone === "bad" ? "text-red-strong" : tone === "warn" ? "text-amber-strong" : "text-ink-2"}`}>
      <strong className="font-semibold tabular-nums">{value}</strong><span>{label}</span>
    </span>
  );
}

/** Season numbers at a glance. They follow the page live, so approving a part moves them at once. */
export function OverviewStrip({ range, analysis, externalReview }: { range: string | null; analysis?: ReactNode; externalReview?: ReactNode }) {
  const o = useOverview();
  return (
    <section aria-label="Season overview" className="rounded-xl border border-line bg-[color:var(--surface-frost)] px-5 py-4">
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-2">
        <Stat value={o.pieces} label="pieces" />
        <Stat value={o.cards} label="platform cards" />
        <Stat value={`${o.textApproved}/${o.textTotal}`} label="text approved" />
        <Stat value={`${o.assetApproved}/${o.assetTotal}`} label="final media approved" />
        {o.byStage.length > 0 && <Stat value={o.byStage.reduce((n, s) => n + s.n, 0)} label="waiting on you" title={o.byStage.map((s) => `${s.n} ${s.label.toLowerCase()}${s.n === 1 ? "" : "s"}`).join(", ")} tone="warn" />}
        <Stat value={o.openNotes} label={o.openNotes === 1 ? "open note" : "open notes"} tone={o.openNotes ? "warn" : undefined} />
        <Stat value={o.needsChanges} label="changes requested" tone={o.needsChanges ? "bad" : undefined} />
        {range && <div className="ml-auto text-right text-sm text-ink-2">{range}</div>}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <div className="h-1.5 min-w-24 flex-1 overflow-hidden rounded-full bg-surface-overlay" role="progressbar" aria-valuenow={o.percent} aria-valuemin={0} aria-valuemax={100} aria-label="Approved">
          <div className="h-full rounded-full transition-[width] duration-300" style={{ width: `${o.percent}%`, background: "var(--gradient-prism)" }} />
        </div>
        <span className="text-xs tabular-nums text-ink-2" title="Final approvals only: an earlier stage (a rough cut) never counts">{o.percent}% approved for publishing</span>
      </div>
      {(analysis || externalReview) && (
        <div className="mt-3 border-t border-line pt-2">
          <ContentDetails>{analysis}{externalReview}</ContentDetails>
        </div>
      )}
    </section>
  );
}
