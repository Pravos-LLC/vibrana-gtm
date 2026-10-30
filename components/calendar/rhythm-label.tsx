// The pillar a weekday carries in the weekly rhythm (lib/rhythm.ts), shown under the day in the calendar header:
// the primary pillar as a chip and the fallback beside it, muted. Sunday reads "Off".

import { cn } from "@/lib/ui/cn";

export function RhythmLabel({ day, labels, className }: { day: string; labels: Record<string, { primary: string; fallback: string[] }>; className?: string }) {
  const { primary, fallback } = labels[day] ?? labels[["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(`${day}T12:00:00Z`).getUTCDay()]] ?? { primary: "Off", fallback: [] };
  const off = primary === "Off";
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1 text-[11px] font-normal leading-none", className)}
      title={off ? "Sunday is off" : `${primary}${fallback.length ? `; when none is ready, ${fallback.join(", then ")}` : ""}`}>
      <span className={cn("rounded-full px-1.5 py-0.5", off ? "text-ink-3" : "bg-violet/10 text-violet-strong")}>{primary}</span>
      {fallback.length > 0 && <span className="truncate text-ink-3">fb {fallback.join(", ")}</span>}
    </span>
  );
}
