import { Clapperboard } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { stageBadge } from "@/lib/stage";

/**
 * What stage a piece's media is at, when it is short of final: "Rough cut · no B-roll · no Motion". Approving it means
 * "the edit is good"; it is never scheduled until the final cut. No hooks, so server and client pages both render it.
 */
export function StageBadge({ stage }: { stage: string | null | undefined }) {
  const text = stageBadge(stage);
  if (!text) return null;
  return (
    <Badge variant="default" className="gap-1" title="Approving a stage never schedules; only the final does">
      <Clapperboard className="size-3" aria-hidden />
      {text}
    </Badge>
  );
}
