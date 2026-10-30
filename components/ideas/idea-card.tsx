"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { promoteIdeaAction, setIdeaStatus } from "@/app/ideas/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EFFORT_LABEL, IDEA_LENSES, IDEA_STATUSES, KIND_LABEL, NOT_PROMOTABLE, promoteBlocker, STATUS_LABEL, type Idea, type IdeaLens, type IdeaStatus } from "@/lib/ideas/model";

const LENS_LABEL: Record<IdeaLens, string> = { transformation: "Transformation", thought_leadership: "Thought leadership", regenerative: "Regenerative" };
const control = "h-8 rounded-md border border-input bg-[color:var(--surface-inset)] px-2 text-xs text-ink";
const weekLabel = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** One idea on the board: what it is, a status picker, and Promote for a content idea that is ready. */
export function IdeaCard({ idea: initial, defaultWeek, candidateWeek }: { idea: Idea; defaultWeek: string; candidateWeek: string | null }) {
  const [idea, setIdea] = useState(initial);
  const [promoted, setPromoted] = useState<string | null>(candidateWeek);
  const [mode, setMode] = useState<"view" | "promote">("view");
  const [week, setWeek] = useState(defaultWeek);
  const [lens, setLens] = useState<IdeaLens>("transformation");
  const [note, setNote] = useState<{ error?: string; warnings?: string[] }>({});
  const [pending, start] = useTransition();
  const blocker = promoteBlocker(idea);
  // Lead magnets and tools are built, not posted: they only move through the statuses.
  const promotable = !(NOT_PROMOTABLE as readonly string[]).includes(idea.kind);

  const move = (status: IdeaStatus) => start(async () => {
    const r = await setIdeaStatus(idea.id, status);
    if (r.ok) { setIdea({ ...idea, status: r.status as IdeaStatus }); setNote({}); } else setNote({ error: r.error });
  });
  const promote = () => start(async () => {
    const r = await promoteIdeaAction(idea.id, week, lens);
    if (!r.ok) return setNote({ error: r.error });
    setIdea({ ...idea, status: r.status as IdeaStatus, promoted_candidate_id: "promoted" });
    setPromoted(r.week_start ?? week);
    setMode("view");
    setNote({ warnings: r.warnings });
  });

  return (
    <Card glow={false} className="space-y-2 p-4" data-testid="idea-card" data-slug={idea.slug}>
      <div className="flex flex-wrap gap-1">
        <Badge variant="info">{KIND_LABEL[idea.kind]}</Badge>
        {idea.pillar && <Badge variant="outline">{idea.pillar}</Badge>}
        {idea.format && <Badge variant="outline">{idea.format}</Badge>}
        {idea.effort && <Badge variant="outline" title="Effort">{EFFORT_LABEL[idea.effort]}</Badge>}
        {idea.impact != null && <Badge variant="outline" title="Impact, 1 to 5">Impact {idea.impact}</Badge>}
      </div>
      <h3 className="font-display text-base font-semibold leading-snug text-ink">{idea.title}</h3>
      {idea.summary && (
        <details className="group text-sm text-ink-2">
          <summary className="cursor-pointer list-none"><span className="line-clamp-3 group-open:line-clamp-none">{idea.summary}</span></summary>
        </details>
      )}
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-3">
        {idea.owner && <span>Owner: {idea.owner}</span>}
        {idea.source_url && <a href={idea.source_url} target="_blank" rel="noreferrer" className="text-violet-strong hover:underline">Source</a>}
        {idea.tags.length > 0 && <span>{idea.tags.map((t) => `#${t}`).join(" ")}</span>}
      </div>
      {promoted && (
        <p className="text-xs text-ink-2" role="status">
          Promoted to <Link href={`/signals?view=candidates&week=${promoted}`} className="text-violet-strong hover:underline">candidates, week of {weekLabel(promoted)}</Link>
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <select value={idea.status} disabled={pending} onChange={(e) => move(e.target.value as IdeaStatus)} className={control} aria-label={`Status of ${idea.title}`}>
          {IDEA_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select>
        {!promoted && mode === "view" && promotable && (
          <Button size="sm" variant="outline" disabled={pending || !!blocker} title={blocker ?? "Put this idea in the Sunday candidates as a brief to write up"} onClick={() => setMode("promote")}>
            Promote to candidate
          </Button>
        )}
      </div>
      {mode === "promote" && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-line p-2" aria-label="Promote">
          <label className="text-xs text-ink-2">Week of <input type="date" value={week} step={7} onChange={(e) => setWeek(e.target.value)} className={control} /></label>
          <select value={lens} onChange={(e) => setLens(e.target.value as IdeaLens)} className={control} aria-label="Lens">
            {IDEA_LENSES.map((l) => <option key={l} value={l}>{LENS_LABEL[l]}</option>)}
          </select>
          <Button size="sm" disabled={pending} onClick={promote}>{pending ? "Promoting…" : "Promote"}</Button>
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => setMode("view")}>Cancel</Button>
          <p className="w-full text-xs text-ink-3">It lands in Signals, Candidates as a text brief with a [JOHN: ...] slot. Nothing is approved or scheduled.</p>
        </div>
      )}
      {!promoted && promotable && blocker && !idea.promoted_candidate_id && <p className="text-xs text-ink-3">To promote: {blocker}.</p>}
      {note.error && <p className="text-xs text-red-strong" role="alert">{note.error}</p>}
      {note.warnings?.map((w) => <p key={w} className="text-xs text-amber-strong">{w}</p>)}
    </Card>
  );
}
