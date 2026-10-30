"use client";

import { useMemo, useState, useTransition } from "react";
import { ShareForReview } from "@/components/review/share-for-review";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, Layers, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { pieceView, reviewMode, type PieceData } from "@/lib/season-review";
import { stepNodes } from "@/lib/pipeline-state";
import { runBatch } from "@/lib/review-state";
import { Glyph } from "./pipeline-stepper";
import { seriesLabel } from "@/lib/series";
import { partKey, usePartStates, useReviewActions } from "./review-store";

const plural = (label: string, n: number) => `${n} ${label.toLowerCase()}${n === 1 ? "" : "s"}`;

/**
 * A series at a glance (rows: pieces, columns: stages) and its batch actions: review the waiting stage one piece at a
 * time, approve that stage on every remaining piece (each decision bound to its own bytes; nothing is scheduled),
 * record the third party's sign-off on the finals, and leave one note for the whole series.
 */
export function SeriesReview({ series, pieces, path }: { series: string; pieces: PieceData[]; path: string }) {
  const states = usePartStates();
  const { actions, commit } = useReviewActions();
  // The series' third party, when every piece names the same one: one "Share for review" for all of them.
  const parties = [...new Set(pieces.map((p) => p.pipeline?.thirdParty?.who).filter((x): x is string => !!x))];
  const party = parties.length === 1 ? parties[0] : null;
  const router = useRouter();
  const [busy, start] = useTransition();
  const [panel, setPanel] = useState<"approve" | "third" | "note" | null>(null);
  const [note, setNote] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [result, setResult] = useState<{ text: string; failed: Array<{ id: string; error: string }> } | null>(null);
  const rows = useMemo(() => pieces.map((p) => ({ p, view: pieceView(p) })).filter((r) => r.view), [pieces]);
  const columns = rows[0] ? stepNodes(rows[0].view!).map((n) => n.label) : [];
  // The stage waiting on John in /content, and the pieces still to decide there.
  const waiting = rows.flatMap(({ p, view }) => {
    const mode = reviewMode(view, p.stageAssets);
    if (mode.kind !== "stage") return [];
    const key = partKey("stage", p.storyId, mode.stage.key);
    return states[key]?.status === "approved" ? [] : [{ p, stage: mode.stage, key }];
  });
  const stage = waiting[0]?.stage;
  const sameStage = waiting.filter((w) => w.stage.key === stage?.key);
  const third = pieces.filter((p) => p.hold?.kind === "third_party" && p.hold.finalStaged);
  const who = third[0]?.hold?.who ?? pieces.find((p) => p.pipeline?.thirdParty)?.pipeline?.thirdParty?.who;
  const name = (id: string) => pieces.find((p) => p.storyId === id)?.name ?? id;

  const approveAll = () => start(async () => {
    const r = await runBatch(sameStage, (w) => w.p.storyId, (w) => actions.decideStage({
      storyId: w.p.storyId, stage: w.stage.key, decision: "approved", note: "",
      expected: (w.p.stageAssets ?? []).map((a) => ({ asset_id: a.id, sha256: a.sha256 ?? "", revision: a.revision })),
    }));
    for (const id of r.done) commit(partKey("stage", id, stage!.key), { type: "approve" });
    setResult({ text: `${stage!.label} approved on ${r.done.length} of ${sameStage.length}. Nothing was scheduled.`, failed: r.failed });
    setPanel(null);
  });
  const releaseThird = () => start(async () => {
    const r = await runBatch(picked, (id) => id, async (id) => {
      const out = await actions.setStoryHold({ storyId: id, held: false });
      return out.ok ? { ok: true as const } : out;
    });
    setResult({ text: `${who ?? "Third party"} approval recorded on ${r.done.length} of ${picked.length}.`, failed: r.failed });
    setPanel(null); setPicked([]);
    router.refresh();
  });
  const noteAll = () => start(async () => {
    const r = await actions.addSeriesNote({ storyIds: pieces.map((p) => p.storyId), note });
    if (!r.ok) { setResult({ text: `Not saved. ${r.error}`, failed: [] }); return; }
    setResult({ text: `Note left on ${pieces.length - r.failed.length} of ${pieces.length}. The agent fixes it once for the series.`, failed: r.failed });
    setPanel(null); setNote("");
  });

  return (
    <section aria-label={`Series ${seriesLabel(series)}`} className="rounded-xl border border-line bg-[color:var(--surface-frost)] p-4">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="flex items-center gap-2 font-display text-base font-semibold text-ink"><Layers className="size-4" aria-hidden />{seriesLabel(series)}</h2>
        <span className="text-xs text-ink-3">{pieces.length} pieces{rows[0] ? ` · ${rows[0].view!.pipeline.label} pipeline` : ""}</span>
        {party && <span className="ml-auto self-center"><ShareForReview party={party} pieces={pieces.filter((p) => p.pipeline?.final.staged).map((p) => p.name)} series={series} share={actions.shareForReview} /></span>}
      </div>
      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-ink-3">
                <th className="py-1 pr-3 font-medium">Piece</th>
                {columns.map((c) => <th key={c} className="px-2 py-1 font-medium">{c}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map(({ p, view }) => (
                <tr key={p.storyId} className="border-t border-line">
                  <td className="py-1.5 pr-3"><a href={`#${p.storyId}`} className="text-ink hover:underline">{p.name}</a></td>
                  {stepNodes(view!).map((n) => {
                    const live = n.status === "current" && reviewMode(view, p.stageAssets).kind === "stage" && states[partKey("stage", p.storyId, n.key)]?.status === "approved" ? "done" : n.status;
                    return <td key={n.key} className="px-2 py-1.5" title={`${n.label}: ${live}`}><span className="inline-flex"><Glyph status={live} /></span></td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {stage && (
          <Link href={`${path}?series=${series}&stage=${stage.key}&focus=1`} className="inline-flex h-8 items-center rounded-md bg-violet px-3 text-sm font-medium text-white hover:bg-violet/90">
            Review {plural(stage.label, sameStage.length)}
          </Link>
        )}
        {stage && sameStage.length > 1 && <Button size="sm" variant="outline" onClick={() => setPanel(panel === "approve" ? null : "approve")}><Check /> Approve {stage.label.toLowerCase()} on all remaining</Button>}
        {third.length > 0 && <Button size="sm" variant="outline" onClick={() => { setPicked(third.map((p) => p.storyId)); setPanel(panel === "third" ? null : "third"); }}>{who} approved: select clips…</Button>}
        <Button size="sm" variant="secondary" onClick={() => setPanel(panel === "note" ? null : "note")}><MessageSquare /> Note for all {pieces.length}</Button>
      </div>

      {panel === "approve" && stage && (
        <div className="mt-3 rounded-lg border border-line p-3 text-sm" role="dialog" aria-label={`Approve ${stage.label.toLowerCase()} on all remaining`}>
          <p className="font-medium text-ink">Approve the {stage.label.toLowerCase()} on these {sameStage.length}?</p>
          <ul className="mt-2 space-y-1 text-ink-2">
            {sameStage.map((w) => <li key={w.p.storyId}>{w.p.name} <span className="text-ink-3">{w.p.stageAssets?.[0]?.versions.at(-1)?.label}{w.p.stageAssets?.[0]?.label ? ` · ${w.p.stageAssets[0].label}` : ""}</span></li>)}
          </ul>
          <p className="mt-2 text-xs text-ink-3">Each decision is bound to the version you see. Nothing will be scheduled; next: the {waitingNext(sameStage[0])}.</p>
          <span className="mt-3 flex gap-2">
            <Button size="sm" disabled={busy} onClick={approveAll}><Check /> Approve {sameStage.length}</Button>
            <Button size="sm" variant="ghost" onClick={() => setPanel(null)}>Cancel</Button>
          </span>
        </div>
      )}
      {panel === "third" && (
        <div className="mt-3 rounded-lg border border-line p-3 text-sm" role="dialog" aria-label={`${who} approved`}>
          <p className="font-medium text-ink">Which finals did {who} approve?</p>
          <ul className="mt-2 space-y-1">
            {third.map((p) => (
              <li key={p.storyId}>
                <label className="inline-flex items-center gap-2 text-ink-2">
                  <input type="checkbox" checked={picked.includes(p.storyId)} onChange={(e) => setPicked((x) => (e.target.checked ? [...x, p.storyId] : x.filter((y) => y !== p.storyId)))} />
                  {p.name}
                </label>
              </li>
            ))}
          </ul>
          <span className="mt-3 flex gap-2">
            <Button size="sm" disabled={busy || !picked.length} onClick={releaseThird}>Record {who}&apos;s approval ({picked.length})</Button>
            <Button size="sm" variant="ghost" onClick={() => setPanel(null)}>Cancel</Button>
          </span>
        </div>
      )}
      {panel === "note" && (
        <div className="mt-3 grid gap-2" role="dialog" aria-label={`Note for all ${pieces.length}`}>
          <textarea aria-label="Note for the whole series" value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="One note for every piece, e.g. the end card sub-line is too small"
            className="w-full rounded-md border border-[color:var(--border-default)] bg-[color:var(--surface-inset)] p-2.5 text-sm" />
          <span className="flex gap-2">
            <Button size="sm" disabled={busy || !note.trim()} onClick={noteAll}>Leave the note on all {pieces.length}</Button>
            <Button size="sm" variant="ghost" onClick={() => setPanel(null)}>Cancel</Button>
          </span>
        </div>
      )}
      {result && (
        <div role="status" className="mt-3 text-sm text-ink-2">
          {result.text}
          {result.failed.length > 0 && <ul className="mt-1 text-xs text-red-strong">{result.failed.map((f) => <li key={f.id}>{name(f.id)}: {f.error}</li>)}</ul>}
        </div>
      )}
    </section>
  );
}

function waitingNext(w: { p: PieceData; stage: { key: string } } | undefined): string {
  const view = w ? pieceView(w.p) : null;
  if (!view) return "next stage";
  const i = view.pipeline.stages.findIndex((s) => s.key === w!.stage.key);
  return view.pipeline.stages[i + 1]?.label ?? "final";
}
