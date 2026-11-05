// Pieces the /pipeline tabs share: the goal bar, the reverse funnel, the action list and source notes.
import Link from "next/link";
import { AlertTriangle, CircleAlert, ExternalLink } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Table } from "@/components/shell";
import type { Action, FunnelStep } from "@/lib/sales/metrics";
import { cn } from "@/lib/ui/cn";
import { per, usd } from "./nav";

/** Progress to the monthly goal: collected (solid) then due this month (hatched), with the goal marked. */
export function GoalBar({ collected, due, goal }: { collected: number; due: number; goal: number }) {
  const max = Math.max(goal, collected + due) * 1.05;
  const w = (n: number) => `${Math.max(0, (n / max) * 100)}%`;
  return (
    <div className="mt-2" role="img" aria-label={`Take-home this month: ${usd(collected)} collected and ${usd(due)} due, against a goal of ${usd(goal)}`}>
      <div className="relative h-3 overflow-hidden rounded-full bg-surface-overlay">
        <div className="absolute inset-y-0 left-0 bg-viz-1" style={{ width: w(Math.max(0, collected)) }} />
        <div className="absolute inset-y-0 bg-viz-1/40" style={{ left: w(Math.max(0, collected)), width: w(Math.max(0, due)) }} />
        <div className="absolute inset-y-0 w-0.5 bg-ink" style={{ left: w(goal) }} />
      </div>
      <div className="mt-1.5 flex flex-wrap justify-between gap-2 text-xs text-ink-3">
        <span><span className="mr-1 inline-block size-2 rounded-full bg-viz-1" />collected {usd(collected)}<span className="ml-3 mr-1 inline-block size-2 rounded-full bg-viz-1/40" />due {usd(due)}</span>
        <span>goal {usd(goal)} a month</span>
      </div>
    </div>
  );
}

export function FunnelTable({ steps, windowLabel }: { steps: FunnelStep[]; windowLabel: string }) {
  return (
    <Table
      head={["Step", "Needed a month", `Actual a month (${windowLabel})`, "", "Rate behind the step"]}
      align={["l", "r", "r", "l", "l"]}
      rows={steps.map((s) => {
        const short = s.actualPerMonth != null && s.actualPerMonth < s.requiredPerMonth;
        return [
          s.label,
          per(s.requiredPerMonth),
          s.actualPerMonth == null ? <span className="text-ink-3">not measured</span> : <span className={short ? "text-amber-strong" : "text-emerald-strong"}>{per(s.actualPerMonth)}</span>,
          s.actualPerMonth == null ? "" : short ? <span className="text-xs text-amber-strong">short {per(s.requiredPerMonth - s.actualPerMonth)}</span> : <span className="text-xs text-emerald-strong">on pace</span>,
          s.rate ? <span className="text-xs text-ink-2">{Math.round(s.rate.value * 100)}% {s.rateLabel} · {s.rate.measured ? `measured on ${s.rate.n}` : `planning (${s.rate.n} measured so far)`}</span> : "",
        ];
      })}
    />
  );
}

export function ActionList({ actions, empty = "Nothing needs action." }: { actions: Action[]; empty?: string }) {
  if (!actions.length) return <p className="text-sm text-ink-3">{empty}</p>;
  return (
    <Card glow={false} className="divide-y divide-[color:var(--border-default)] px-4 py-1" data-testid="needs-action">
      {actions.map((a) => {
        const Icon = a.tone === "bad" ? CircleAlert : AlertTriangle;
        const body = (
          <div className="flex items-start gap-3 py-2.5">
            <Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", a.tone === "bad" ? "text-red-strong" : "text-amber-strong")} />
            <div className="min-w-0 flex-1">
              <div className="text-sm text-ink">{a.text}</div>
              {a.detail && <div className="text-xs text-ink-3">{a.detail}</div>}
            </div>
            {a.href && <ExternalLink aria-hidden className="mt-1 size-3.5 shrink-0 text-ink-3" />}
          </div>
        );
        return a.href
          ? a.href.startsWith("/") ? <Link key={a.key} href={a.href} className="block hover:bg-surface-card-hover">{body}</Link>
            : <a key={a.key} href={a.href} target="_blank" rel="noreferrer" className="block hover:bg-surface-card-hover">{body}</a>
          : <div key={a.key}>{body}</div>;
      })}
    </Card>
  );
}

/** A source that could not be read or is not set up yet: one line, never a silent zero. */
export function SourceNote({ children, tone = "info" }: { children: React.ReactNode; tone?: "info" | "bad" }) {
  return <p className={cn("mb-4 rounded-md border px-3 py-2 text-sm", tone === "bad" ? "border-red-strong/40 text-red-strong" : "border-line text-ink-2")}>{children}</p>;
}
