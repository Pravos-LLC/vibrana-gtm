import { CalendarCheck, Check, Coins, Hourglass, Minus, User, X } from "lucide-react";
import { cn } from "@/lib/ui/cn";
import { stepNodes, type PipelineView, type StageView, type StepNode, type ThirdParty } from "@/lib/pipeline-state";

const STATUS_WORD: Record<StepNode["status"], string> = { done: "done", current: "current", upcoming: "to do", skipped: "skipped", changes: "changes requested", waiting: "waiting on John" };

export function Glyph({ status }: { status: StepNode["status"] }) {
  const base = "flex size-4 shrink-0 items-center justify-center rounded-full";
  if (status === "done") return <span className={cn(base, "bg-[color:var(--emerald)] text-white")}><Check className="size-3" aria-hidden /></span>;
  if (status === "changes") return <span className={cn(base, "bg-amber-strong text-white")}><X className="size-3" aria-hidden /></span>;
  if (status === "skipped") return <span className={cn(base, "border border-line text-ink-3")}><Minus className="size-3" aria-hidden /></span>;
  if (status === "waiting") return <span className={cn(base, "border-2 border-violet/60")} />;
  if (status === "current") return <span className={cn(base, "border-2 border-violet")}><span className="size-1.5 rounded-full bg-violet" /></span>;
  return <span className={cn(base, "border border-[color:var(--border-default)]")} />;
}

function describe(node: StepNode, thirdParty: ThirdParty | null | undefined): string {
  const lines = node.stages.map((s: StageView) => {
    const who = s.stage.gate === "john" ? ` John's gate (in /content).` : "";
    const progress = s.note ? ` ${s.note}${s.actor ? ` (${s.actor})` : ""}` : "";
    return `${s.stage.label}: ${s.status}.${who} ${s.stage.does}${progress}`.trim();
  });
  if (node.spends) lines.push(`Approving this authorizes ${node.spends}.`);
  if (node.final && thirdParty) lines.push(`Publishing is blocked until ${thirdParty.who} approves the final.`);
  if (node.final) lines.push("Only the final schedules.");
  return lines.join("\n");
}

/**
 * The pipeline as one row of nodes: done, current, to do, skipped, changes requested. A person marks John's gates, an
 * hourglass a third party's sign-off on the final, a coin a gate that authorizes spend. The row ends at "Scheduled",
 * so it reads on screen that nothing before the final schedules. No hooks: server and client pages both render it.
 */
export function PipelineStepper({ view, thirdParty, scheduled = false, expanded = false }: {
  view: PipelineView; thirdParty?: ThirdParty | null; scheduled?: boolean; expanded?: boolean;
}) {
  const nodes = stepNodes(view);
  return (
    <ol aria-label={`${view.pipeline.label} pipeline`} className={cn("flex flex-wrap items-start gap-y-2 text-xs", expanded && "gap-y-3")}>
      {nodes.map((node, i) => (
        <li key={node.key} className="flex items-start">
          {i > 0 && <span aria-hidden className={cn("mx-1.5 mt-2 h-px w-4 sm:w-6", node.status === "upcoming" ? "bg-line" : "bg-[color:var(--emerald)]/50")} />}
          <span tabIndex={0} title={describe(node, thirdParty)} aria-label={`${node.label}: ${STATUS_WORD[node.status]}`}
            className="flex flex-col gap-0.5 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <span className="flex items-center gap-1.5">
              <Glyph status={node.status} />
              <span className={cn(node.status === "current" ? "font-semibold text-ink" : node.status === "upcoming" ? "text-ink-3" : "text-ink-2")}>{node.label}</span>
              {node.spends && <Coins className="size-3 text-amber-strong" aria-label="authorizes spend" />}
            </span>
            {(node.gate || (node.final && thirdParty)) && (
              <span className="flex items-center gap-1 pl-5 text-[11px] text-ink-3">
                {node.gate && <span className={cn("inline-flex items-center gap-0.5", node.status === "done" && "text-emerald-strong")}><User className="size-3" aria-hidden />John</span>}
                {node.final && thirdParty && <span className={cn("inline-flex items-center gap-0.5", !thirdParty.open && "text-emerald-strong")}><Hourglass className="size-3" aria-hidden />{thirdParty.who}</span>}
              </span>
            )}
            {expanded && node.stages.some((s) => s.note) && (
              <span className="max-w-56 pl-5 text-[11px] text-ink-3">{node.stages.filter((s) => s.note).map((s) => s.note).join(" · ")}</span>
            )}
          </span>
        </li>
      ))}
      <li className="flex items-start">
        <span aria-hidden className={cn("mx-1.5 mt-2 h-px w-4 sm:w-6", scheduled ? "bg-[color:var(--emerald)]/50" : "bg-line")} />
        <span className={cn("flex items-center gap-1.5", scheduled ? "text-emerald-strong" : "text-ink-3")} aria-label={`Scheduled: ${scheduled ? "done" : "to do"}`}>
          <CalendarCheck className="size-4" aria-hidden /> Scheduled
        </span>
      </li>
    </ol>
  );
}
