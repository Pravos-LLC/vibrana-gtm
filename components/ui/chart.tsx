"use client";

// shadcn/ui chart (ui.shadcn.com/docs/components/chart), trimmed for Recharts 3 and Prism-skinned:
// ChartContainer sets --color-<key> from the config and sizes a ResponsiveContainer; the tooltip leads with
// the value and keys each series with a short line, not a box. Used for line charts only (VIB-419).
import * as React from "react";
import * as Recharts from "recharts";
import { cn } from "@/lib/ui/cn";

export type ChartConfig = Record<string, { label: string; color: string; dashed?: boolean; unit?: string }>;

const ChartContext = React.createContext<{ config: ChartConfig } | null>(null);
function useChart() {
  const c = React.useContext(ChartContext);
  if (!c) throw new Error("useChart must be used inside <ChartContainer />");
  return c;
}

export function ChartContainer({ config, className, children, ...props }: React.ComponentProps<"div"> & { config: ChartConfig; children: React.ComponentProps<typeof Recharts.ResponsiveContainer>["children"] }) {
  const style = Object.fromEntries(Object.entries(config).map(([k, v]) => [`--color-${k}`, v.color])) as React.CSSProperties;
  return (
    <ChartContext.Provider value={{ config }}>
      <div
        data-chart
        style={style}
        className={cn(
          "w-full text-xs [&_.recharts-cartesian-axis-tick_text]:fill-[color:var(--text-tertiary)] [&_.recharts-cartesian-grid_line]:stroke-[color:var(--viz-grid)] [&_.recharts-surface]:outline-none [&_.recharts-wrapper]:outline-none",
          className,
        )}
        {...props}
      >
        <Recharts.ResponsiveContainer>{children}</Recharts.ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  );
}

export const ChartTooltip = Recharts.Tooltip;

type Payload = { dataKey?: string | number; name?: string | number; value?: unknown; color?: string; payload?: Record<string, unknown> };

export function ChartTooltipContent({ active, payload, label, labelFormatter, valueFormatter }: {
  active?: boolean; payload?: readonly Payload[]; label?: string | number;
  labelFormatter?: (label: string | number | undefined, row: Record<string, unknown> | undefined) => React.ReactNode;
  valueFormatter?: (value: number, key: string) => string;
}) {
  const { config } = useChart();
  if (!active || !payload?.length) return null;
  const rows = payload.filter((p) => p.value != null && config[String(p.dataKey)]);
  return (
    <div className="min-w-36 rounded-lg border border-line bg-[color:var(--surface-inset)] px-3 py-2 text-xs shadow-sm backdrop-blur-sm">
      <div className="mb-1 text-ink-3">{labelFormatter ? labelFormatter(label, payload[0]?.payload) : label}</div>
      {rows.map((p) => {
        const key = String(p.dataKey);
        const c = config[key];
        const v = Array.isArray(p.value) ? (p.value as number[]).join(" to ") : valueFormatter ? valueFormatter(Number(p.value), key) : Number(p.value).toLocaleString("en-US");
        return (
          <div key={key} className="flex items-center gap-2 py-0.5">
            <svg width="12" height="4" aria-hidden className="shrink-0"><line x1="0" y1="2" x2="12" y2="2" stroke={c.color} strokeWidth="2" strokeDasharray={c.dashed ? "3 2" : undefined} /></svg>
            <span className="font-semibold tabular-nums text-ink">{v}</span>
            <span className="text-ink-3">{c.label}</span>
          </div>
        );
      })}
    </div>
  );
}
