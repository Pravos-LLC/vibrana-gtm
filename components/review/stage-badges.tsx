import { Clapperboard, Hourglass } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { missingFeatures, waitingOn, type FinalParts, type PipelineView, type ThirdParty } from "@/lib/pipeline-state";

/**
 * One line under a piece's title: format, stage (with the pipeline's own version label), what is not in it yet, and who
 * it is waiting on. "Short · Rough cut · v4 · no B-roll · no Motion · Waiting on John". Violet needs John, amber waits on
 * someone else, green is approved. No hooks, so server and client pages both render it.
 * With `parts` (the live open parts at the final) the waiting badge names them: "Waiting on John: Substack essay".
 */
export function StageBadges({ view, label, thirdParty, storyId, parts }: { view: PipelineView; label?: string | null; thirdParty?: ThirdParty | null; storyId?: string; parts?: FinalParts | null }) {
  const c = view.current;
  const waiting = waitingOn(view, thirdParty, parts);
  const legacy = !view.pipeline.label;
  if (legacy && !waiting?.who.startsWith("third") && !waiting?.parts?.length) return null;
  const stageTone = !c ? "success" : waiting?.who === "john" ? "default" : "warning";
  return (
    <span className="flex flex-wrap items-center gap-1.5" aria-label="Pipeline stage">
      {!legacy && <Badge variant="outline">{view.pipeline.label}</Badge>}
      {c && !c.stage.final && (
        <Badge variant={stageTone} className="gap-1" title="Approving this stage never schedules; only the final does">
          <Clapperboard className="size-3" aria-hidden />
          {label ? `${c.stage.label} · ${label}` : c.stage.label}
          {c.status === "changes" ? " · changes requested" : ""}
        </Badge>
      )}
      {c && !c.stage.final && missingFeatures(view).map((f) => <Badge key={f} variant="outline" className="border-dashed">no {f}</Badge>)}
      {waiting && <WaitingBadge waiting={waiting} />}
    </span>
  );
}

/** "Waiting on John: Substack essay, Substack image": who the piece waits on, and on what when the page knows. */
export function WaitingBadge({ waiting }: { waiting: { who: string; label: string; where?: string; parts?: string[] } }) {
  return (
    <Badge variant={waiting.who === "john" ? "default" : "warning"} className="gap-1" data-testid="waiting-on">
      {waiting.who === "third_party" && <Hourglass className="size-3" aria-hidden />}
      Waiting on {waiting.label}{waiting.parts?.length ? `: ${waiting.parts.join(", ")}` : ""}
    </Badge>
  );
}
