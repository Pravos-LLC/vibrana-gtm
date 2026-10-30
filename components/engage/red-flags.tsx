import Link from "next/link";
import { Flame, HelpCircle, MessagesSquare } from "lucide-react";
import { PLATFORM } from "@/components/brand-icons";
import { ResolveFlag } from "@/components/engage/resolve-flag";
import { Card } from "@/components/ui/card";
import { FLAG_LABEL, actionLabel, type FlagType, type RedFlag } from "@/lib/engage/redflags";

// Status is an icon plus a word, never colour alone.
const LOOK: Record<FlagType, { Icon: typeof Flame; tone: string; note: string }> = {
  backlash: { Icon: Flame, tone: "text-red-strong", note: "hostile volume, a fast pile-on, or pushback from someone in the CRM" },
  not_landing: { Icon: HelpCircle, tone: "text-amber-strong", note: "people read it as something it does not say" },
  healthy_debate: { Icon: MessagesSquare, tone: "text-blue-strong", note: "reasoned disagreement and questions: good for awareness" },
};

/** The "Red flags" strip at the top of /engage (VIB-424): one row per flagged post, most severe first. */
export function RedFlags({ flags, active }: { flags: RedFlag[]; active?: string }) {
  if (!flags.length) return null;
  return (
    <section aria-labelledby="red-flags-title" className="space-y-2" data-testid="red-flags">
      <h2 id="red-flags-title" className="text-xs font-medium uppercase tracking-wide text-ink-3">Red flags, last 7 days</h2>
      {flags.map((f) => {
        const look = LOOK[f.flag];
        const p = PLATFORM[f.platform as keyof typeof PLATFORM];
        const counts = [
          f.counts.negative && `${f.counts.negative} hostile or bad faith`,
          f.counts.constructive_dissent && `${f.counts.constructive_dissent} reasoned dissent`,
          f.counts.misread && `${f.counts.misread} misread`,
          f.counts.question && `${f.counts.question} questions`,
          f.counts.supportive && `${f.counts.supportive} supportive`,
        ].filter(Boolean).join(" · ");
        return (
          <Card key={f.post_key} glow={false} className={`space-y-1.5 p-4 text-sm ${active === f.post_key ? "border-violet" : ""}`} data-testid="red-flag">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className={`inline-flex items-center gap-1 font-semibold ${look.tone}`} title={look.note}><look.Icon className="size-4" aria-hidden />{FLAG_LABEL[f.flag]}</span>
              {p ? <p.Icon className="size-4" title={p.label} /> : <span className="text-xs text-ink-3">{f.platform}</span>}
              <span className="min-w-0 flex-1 truncate text-ink">{f.title}</span>
            </div>
            <p className="text-xs text-ink-2">{counts}</p>
            {f.objection && <p className="text-ink-2"><span className="font-medium text-ink">Core objection:</span> {f.objection}</p>}
            {f.who.notable.length > 0 && (
              <p className="text-xs text-ink-2"><span className="font-medium text-ink">Who:</span> {f.who.notable.map((n) => `${n.name}${n.tags.length ? ` (${n.tags.join(", ")})` : ""}`).join("; ")}</p>
            )}
            <p className="text-ink-2"><span className="font-medium text-ink">Recommended:</span> {actionLabel(f.action)}{f.also.length ? <span className="text-ink-3"> · also {f.also.map((a) => actionLabel(a).toLowerCase()).join("; ")}</span> : null}</p>
            <div className="flex flex-wrap gap-3 text-xs">
              <Link href={`/engage?post=${encodeURIComponent(f.post_key)}`} className="text-violet-strong hover:underline">See the {f.comment_ids.length} comments</Link>
              {f.url && <a href={f.url} target="_blank" rel="noreferrer" className="text-violet-strong hover:underline">Open the post</a>}
              <ResolveFlag postKey={f.post_key} />
            </div>
          </Card>
        );
      })}
    </section>
  );
}
