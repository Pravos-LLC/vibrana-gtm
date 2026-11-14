import { InfoTip } from "@/components/info-tip";
import { cn } from "@/lib/ui/cn";

// Parts of Analytics > Team (/performance/team) that keep the tiles short: data-source status and rate progress.
const day = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

export type Health = "ok" | "warn" | "bad" | "off";

/** One data source in the status strip: a colored dot, one short line, the detail behind the "i". */
export function Source({ name, health, children, info }: { name: string; health: Health; children: React.ReactNode; info: React.ReactNode }) {
  return (
    <div className="relative flex min-w-0 items-start gap-2 hover:z-20 focus-within:z-20">
      <span aria-hidden className={cn("mt-1.5 size-2 shrink-0 rounded-full", { ok: "bg-emerald-strong", warn: "bg-amber-strong", bad: "bg-red-strong", off: "bg-surface-overlay ring-1 ring-[color:var(--border-strong)]" }[health])} />
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 font-medium text-ink">{name}<span className="sr-only">: {health === "ok" ? "healthy" : health === "off" ? "not connected" : "needs attention"}</span><InfoTip label={`About ${name}`}>{info}</InfoTip></p>
        <div className={cn("text-ink-2", health === "bad" && "text-red-strong")}>{children}</div>
      </div>
    </div>
  );
}

/** Progress toward the minimum sample a rate needs, with the earliest date it can show. */
export function Pending({ have, need, readyAt, hint }: { have: number; need: number; readyAt: number | null; hint?: string }) {
  return (
    <div className="space-y-1.5 not-italic">
      <p>{have} of {need} first touches old enough</p>
      <div className="h-1.5 rounded-full bg-surface-overlay" role="progressbar" aria-valuemin={0} aria-valuemax={need} aria-valuenow={Math.min(have, need)} aria-label="First touches old enough to count">
        <div className="h-1.5 rounded-full bg-viz-1" style={{ width: `${Math.min(100, (have / need) * 100)}%` }} />
      </div>
      <p>{readyAt ? `Shows about ${day(readyAt)}` : hint ?? "Needs more first touches"}</p>
    </div>
  );
}
