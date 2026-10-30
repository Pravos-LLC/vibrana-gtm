"use client";

// One line chart (VIB-419): a single series in --viz-1, an optional comparison in ink-3 (the prior period
// dashed, or a 25th to 75th percentile band with its median dashed). Recharts 3 through the shadcn chart
// component; its accessibility layer lets the keyboard walk the points. Every chart has a Table toggle and
// an aria summary, and animation is off under reduced motion.
import { useEffect, useId, useState } from "react";
import { Area, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { cn } from "@/lib/ui/cn";

export type TrendPoint = { x: string; value: number | null; prior?: number | null; band?: [number, number] | null; median?: number | null };

function useReducedMotion() {
  const [reduce, setReduce] = useState(true);
  useEffect(() => {
    const m = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduce(m.matches);
    const on = () => setReduce(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return reduce;
}

const fmt = (n: number) => (Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(Math.abs(n) >= 100_000 ? 0 : 1).replace(/\.0$/, "")}K` : n.toLocaleString("en-US"));

export function TrendChart({ title, unit, summary, data, valueLabel, priorLabel, bandLabel, xTitle, height = 160, compact, connectNulls, className }: {
  title: string; unit: string; summary: string; data: TrendPoint[];
  /** Draw across missing points (cumulative series with a skipped snapshot day); weekly counts keep their gaps. */
  connectNulls?: boolean;
  valueLabel?: string; priorLabel?: string; bandLabel?: string; xTitle?: string;
  height?: number; compact?: boolean; className?: string;
}) {
  const [table, setTable] = useState(false);
  const reduce = useReducedMotion();
  const id = useId();
  const hasPrior = data.some((d) => d.prior != null);
  const hasBand = data.some((d) => d.band != null);
  const config: ChartConfig = {
    value: { label: valueLabel ?? unit, color: "var(--viz-1)" },
    ...(hasPrior ? { prior: { label: priorLabel ?? "prior period", color: "var(--text-tertiary)", dashed: true } } : {}),
    ...(hasBand ? { band: { label: bandLabel ?? "middle half", color: "var(--text-tertiary)" }, median: { label: "median", color: "var(--text-tertiary)", dashed: true } } : {}),
  };
  const lastIdx = data.map((d) => d.value != null).lastIndexOf(true);
  const empty = lastIdx < 0;

  return (
    <figure className={cn("min-w-0", className)} aria-labelledby={`${id}-t`}>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <figcaption id={`${id}-t`} className={cn("text-ink", compact ? "text-xs text-ink-2" : "text-sm font-medium")}>{title}</figcaption>
        <button type="button" onClick={() => setTable((v) => !v)} aria-pressed={table} className="shrink-0 rounded px-1 text-[0.7rem] text-ink-3 underline-offset-2 hover:text-ink hover:underline">
          {table ? "Chart" : "Table"}
        </button>
      </div>
      <p className="sr-only">{summary}</p>
      {(hasPrior || hasBand) && !table && !compact && (
        <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-3" aria-hidden>
          <span className="inline-flex items-center gap-1.5"><svg width="14" height="4"><line x1="0" y1="2" x2="14" y2="2" stroke="var(--viz-1)" strokeWidth="2" /></svg>{config.value.label}</span>
          {hasPrior && <span className="inline-flex items-center gap-1.5"><svg width="14" height="4"><line x1="0" y1="2" x2="14" y2="2" stroke="var(--text-tertiary)" strokeWidth="2" strokeDasharray="3 2" /></svg>{config.prior.label}</span>}
          {hasBand && <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-3.5 rounded-sm bg-[color:var(--text-tertiary)] opacity-25" />{config.band.label}</span>}
        </div>
      )}
      {empty ? (
        <p className="flex items-center rounded-lg border border-dashed border-line px-3 text-xs italic text-ink-3" style={{ height }}>— no data in this range yet</p>
      ) : table ? (
        <div className="max-h-64 overflow-auto rounded-lg border border-line">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-surface-raised text-ink-3">
              <tr><th className="px-2 py-1.5 text-left font-medium">{xTitle ?? "When"}</th><th className="px-2 py-1.5 text-right font-medium">{config.value.label}</th>{hasPrior && <th className="px-2 py-1.5 text-right font-medium">{config.prior.label}</th>}{hasBand && <th className="px-2 py-1.5 text-right font-medium">{config.band.label}</th>}</tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.x} className="border-t border-line">
                  <td className="px-2 py-1 text-ink-2">{d.x}</td>
                  <td className="px-2 py-1 text-right tabular-nums text-ink">{d.value == null ? "—" : d.value.toLocaleString("en-US")}</td>
                  {hasPrior && <td className="px-2 py-1 text-right tabular-nums text-ink-2">{d.prior == null ? "—" : d.prior.toLocaleString("en-US")}</td>}
                  {hasBand && <td className="px-2 py-1 text-right tabular-nums text-ink-2">{d.band ? `${d.band[0].toLocaleString("en-US")} to ${d.band[1].toLocaleString("en-US")}` : "—"}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <ChartContainer config={config} style={{ height }}>
          <ComposedChart data={data} margin={{ top: 6, right: 10, bottom: 0, left: 0 }} accessibilityLayer>
            <CartesianGrid vertical={false} strokeWidth={1} />
            <XAxis dataKey="x" tickLine={false} axisLine={false} tickMargin={6} minTickGap={compact ? 24 : 16} interval="preserveStartEnd" />
            <YAxis tickLine={false} axisLine={false} width={compact ? 38 : 46} tickFormatter={fmt} allowDecimals={false} tickCount={compact ? 3 : 4} />
            <ChartTooltip cursor={{ stroke: "var(--border-strong)", strokeWidth: 1 }} content={<ChartTooltipContent valueFormatter={(v) => v.toLocaleString("en-US")} />} />
            {hasBand && <Area dataKey="band" type="monotone" stroke="none" fill="var(--text-tertiary)" fillOpacity={0.14} isAnimationActive={!reduce} connectNulls />}
            {hasBand && <Line dataKey="median" type="monotone" stroke="var(--text-tertiary)" strokeWidth={1.5} strokeDasharray="4 3" dot={false} isAnimationActive={!reduce} connectNulls />}
            {hasPrior && <Line dataKey="prior" type="monotone" stroke="var(--text-tertiary)" strokeWidth={1.5} strokeDasharray="4 3" dot={false} isAnimationActive={!reduce} connectNulls />}
            <Line
              dataKey="value" type="monotone" connectNulls={connectNulls} stroke="var(--viz-1)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" isAnimationActive={!reduce}
              dot={(p: { cx?: number; cy?: number; index?: number }) => p.cx == null || p.cy == null || p.index == null ? <g key={`d${p.index}`} />
                : p.index === lastIdx ? <circle key="end" cx={p.cx} cy={p.cy} r={4} fill="var(--viz-1)" stroke="var(--surface-base)" strokeWidth={2} />
                // A week between two empty weeks has no line to sit on: draw it as a small dot so it is not lost.
                : !connectNulls && data[p.index - 1]?.value == null && data[p.index + 1]?.value == null ? <circle key={`d${p.index}`} cx={p.cx} cy={p.cy} r={2.5} fill="var(--viz-1)" />
                : <g key={`d${p.index}`} />}
              activeDot={{ r: 5, fill: "var(--viz-1)", stroke: "var(--surface-base)", strokeWidth: 2 }}
            />
          </ComposedChart>
        </ChartContainer>
      )}
    </figure>
  );
}
