"use client";

// A report's line chart: up to six named series over shared x labels, in the cockpit's viz colors, with the
// same Table toggle and screen-reader summary as the Performance trend charts.
import { useId, useState } from "react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";

const COLORS = ["var(--viz-1)", "var(--viz-2)", "var(--viz-3)", "var(--viz-4)", "var(--text-secondary)", "var(--text-tertiary)"];
const short = (n: number) => (Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K` : n.toLocaleString("en-US"));

export function LineBlock({ title, unit, x, series }: { title: string; unit?: string; x: string[]; series: { name: string; values: (number | null)[]; dashed?: boolean }[] }) {
  const [table, setTable] = useState(false);
  const id = useId();
  const keys = series.map((_, i) => `s${i}`);
  const config: ChartConfig = Object.fromEntries(series.map((s, i) => [keys[i], { label: s.name, color: COLORS[i % COLORS.length], dashed: s.dashed, unit }]));
  const data = x.map((label, j) => Object.fromEntries([["x", label], ...series.map((s, i) => [keys[i], s.values[j]])]));
  const summary = series.map((s) => {
    const v = s.values.filter((n): n is number => n != null);
    return v.length ? `${s.name} from ${v[0].toLocaleString("en-US")} to ${v.at(-1)!.toLocaleString("en-US")}` : `${s.name}: no data`;
  }).join("; ");
  return (
    <figure aria-labelledby={`${id}-t`}>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <figcaption id={`${id}-t`} className="sr-only">{title}</figcaption>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-3" aria-hidden>
          {series.map((s, i) => (
            <span key={s.name} className="inline-flex items-center gap-1.5">
              <svg width="14" height="4"><line x1="0" y1="2" x2="14" y2="2" stroke={COLORS[i % COLORS.length]} strokeWidth="2" strokeDasharray={s.dashed ? "3 2" : undefined} /></svg>{s.name}
            </span>
          ))}
        </div>
        <button type="button" onClick={() => setTable((v) => !v)} aria-pressed={table} className="shrink-0 rounded px-1 text-[0.7rem] text-ink-3 underline-offset-2 hover:text-ink hover:underline">
          {table ? "Chart" : "Table"}
        </button>
      </div>
      <p className="sr-only">{summary}</p>
      {table ? (
        <div className="max-h-72 overflow-auto rounded-lg border border-line">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-surface-raised text-ink-3">
              <tr><th className="px-2 py-1.5 text-left font-medium">When</th>{series.map((s) => <th key={s.name} className="px-2 py-1.5 text-right font-medium">{s.name}</th>)}</tr>
            </thead>
            <tbody>
              {x.map((label, j) => (
                <tr key={label} className="border-t border-line">
                  <td className="px-2 py-1 text-ink-2">{label}</td>
                  {series.map((s) => <td key={s.name} className="px-2 py-1 text-right tabular-nums text-ink">{s.values[j] == null ? "—" : s.values[j]!.toLocaleString("en-US")}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <ChartContainer config={config} className="h-56">
          <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }} accessibilityLayer>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="x" tickLine={false} axisLine={false} tickMargin={8} minTickGap={16} />
            <YAxis tickLine={false} axisLine={false} width={44} tickFormatter={short} />
            <ChartTooltip cursor={{ stroke: "var(--viz-grid)" }} content={<ChartTooltipContent />} />
            {keys.map((k, i) => (
              <Line key={k} dataKey={k} type="monotone" stroke={`var(--color-${k})`} strokeWidth={2} strokeDasharray={series[i].dashed ? "4 3" : undefined} dot={{ r: 2.5 }} connectNulls isAnimationActive={false} />
            ))}
          </LineChart>
        </ChartContainer>
      )}
    </figure>
  );
}
