import Link from "next/link";
import { useId } from "react";
import { AlertTriangle, ArrowDownRight, ArrowUpRight, CircleAlert, Minus } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/ui/cn";

export type TileDelta = {
  /** Current minus the baseline, in the tile's unit. */
  value: number;
  /** What it is compared with, e.g. "vs last week". */
  label: string;
  /** Which direction is good news; "neutral" never colors the delta. */
  goodWhen: "up" | "down" | "neutral";
  format?: (n: number) => string;
};

/** Sparkline: server SVG, de-emphasized ink line with the current point in the accent. Nulls break the line; a point with no neighbor shows as a dot. */
export function Sparkline({ points, className, label }: { points: (number | null)[]; className?: string; label?: string }) {
  const W = 96, H = 28, P = 3;
  const vals = points.filter((v): v is number => v != null);
  if (vals.length < 2) return null;
  const min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
  const x = (i: number) => P + (i / (points.length - 1)) * (W - 2 * P);
  const y = (v: number) => H - P - ((v - min) / span) * (H - 2 * P);
  let d = "";
  points.forEach((v, i) => { if (v == null) return; d += `${i && points[i - 1] != null ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`; });
  const last = points.length - 1;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className={cn("overflow-visible", className)} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <path d={d} fill="none" stroke="var(--text-tertiary)" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      {points.map((v, i) => v != null && i !== last && points[i - 1] == null && points[i + 1] == null ? <circle key={i} cx={x(i)} cy={y(v)} r="1.5" fill="var(--text-tertiary)" /> : null)}
      {points[last] != null && <circle cx={x(last)} cy={y(points[last]!)} r="3" fill="var(--viz-1)" stroke="var(--surface-base)" strokeWidth="2" />}
    </svg>
  );
}

/**
 * The one stat tile (VIB-419; replaces Kpi and Today's Action tile): label, value, a named
 * delta that knows which way is good, an 8-week sparkline, and the whole tile as a link when `href` is set.
 * A missing value shows "—" with the reason, never 0. Tone (warn/bad) always carries an icon too.
 */
export function StatTile({ label, value, missing, note, delta, spark, href, tone, className }: {
  label: string; value: string | null; missing?: string; note?: React.ReactNode; delta?: TileDelta | null;
  spark?: (number | null)[]; href?: string; tone?: "warn" | "bad"; className?: string;
}) {
  const id = useId();
  const fmt = delta?.format ?? ((n: number) => (n > 0 ? `+${n.toLocaleString("en-US")}` : n.toLocaleString("en-US")));
  const dir = !delta || delta.value === 0 ? "flat" : delta.value > 0 ? "up" : "down";
  const good = delta && delta.goodWhen !== "neutral" && dir !== "flat" ? dir === delta.goodWhen : null;
  const DeltaIcon = dir === "up" ? ArrowUpRight : dir === "down" ? ArrowDownRight : Minus;
  const ToneIcon = tone === "bad" ? CircleAlert : AlertTriangle;
  const vals = (spark ?? []).filter((v): v is number => v != null);
  const body = (
    <Card glow={false} className={cn("flex h-full flex-col p-5", href && "transition-colors group-hover:border-[color:var(--border-strong)]", className)}>
      <p id={`${id}-label`} className="text-sm text-ink-2">{label}</p>
      <div className="mt-2 flex items-end justify-between gap-3" aria-labelledby={`${id}-label`}>
        <span className="inline-flex min-w-0 items-center gap-2">
          {tone && value != null && <ToneIcon aria-hidden className={cn("size-5 shrink-0", tone === "bad" ? "text-red-strong" : "text-amber-strong")} />}
          <span className={cn("text-pl-2xl font-semibold leading-none tracking-tight", value == null ? "text-ink-3" : tone === "bad" ? "text-red-strong" : tone === "warn" ? "text-amber-strong" : "text-ink")}>
            {value ?? "—"}
          </span>
        </span>
        {spark && vals.length > 1 && (
          <Sparkline points={spark} className="mb-0.5 hidden shrink-0 sm:block" label={`${label}, last ${spark.length} weeks: ${vals[0].toLocaleString("en-US")} to ${vals.at(-1)!.toLocaleString("en-US")}`} />
        )}
      </div>
      <div className="mt-auto space-y-0.5 pt-3 text-xs leading-snug text-ink-3">
        {value == null && missing ? <p className="italic">{missing}</p> : null}
        {value != null && delta && (
          <p className={cn("flex flex-wrap items-center gap-x-1 font-medium", good === true ? "text-emerald-strong" : good === false ? "text-red-strong" : "text-ink-2")}>
            <DeltaIcon aria-hidden className="size-3.5" />
            {fmt(delta.value)}
            <span className="sr-only">{good === true ? ", better" : good === false ? ", worse" : ""}</span>
            <span className="font-normal text-ink-3">{delta.label}</span>
          </p>
        )}
        {note ? <p>{note}</p> : null}
      </div>
    </Card>
  );
  return href ? <Link href={href} className="group block h-full rounded-xl">{body}</Link> : body;
}
