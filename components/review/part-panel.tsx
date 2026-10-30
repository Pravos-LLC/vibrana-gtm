"use client";

import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { labelForRevision, openNotes, type FeedbackItem, type PartUi, type PartVersion } from "@/lib/season-review";
import { NoteItem } from "./review-ui";

const area = "w-full resize-y rounded-md border border-[color:var(--border-default)] bg-[color:var(--surface-inset)] p-2.5 text-sm leading-relaxed text-ink placeholder:text-ink-3 focus-visible:border-violet focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20";

/**
 * The decision area for one part (Asset or Text) of one platform card.
 *
 * Two actions that cannot be mistaken for each other. "Request changes" belongs to the note: it is the
 * button under the textarea, amber, and it is the only one that needs words. "Approve" sits below a rule,
 * green, and steps back to a quiet button the moment the note has text. Unapprove is a link.
 *
 * With `onApproveWithNote`, a note turns Approve into "Approve with note" (John, 2026-10-13): the part is approved and the
 * note goes to the agent as a small fix to make before it schedules. It never comes back for another review.
 */
export function PartPanel({ label, verb, approveAttr, ui, versions, viewing, notes, blocked, consequence, approvedNote, error, textReset, onApprove, onUnapprove, onRequest, onApproveWithNote, onlyThisFormat = false, extra }: {
  /** What is decided: "Video", "YouTube text", "Rough cut". */
  label: string;
  /** The approve button, when it should say more than "Approve <label>": "Approve final for YouTube and Instagram". */
  verb?: string;
  /** data-approve on the approve button, for keyboard review ("stage"). */
  approveAttr?: string;
  ui: Exclude<PartUi, "none">; versions: PartVersion[]; viewing: number; notes: FeedbackItem[];
  /** Why approving is not possible right now (unsaved edits, a placeholder). */
  blocked?: string;
  /** What happens when John approves: shown beside the button. */
  consequence?: string;
  /** Shown once approved (what happens next). */
  approvedNote?: string;
  error?: string | null; textReset?: boolean;
  /** Null when an approval cannot be taken back (a stage decision is a log entry). */
  onApprove: () => void; onUnapprove: (() => void) | null;
  /** `only`: John ticked "Only this format"; otherwise the note covers every format of the video. */
  onRequest: (note: string, only?: boolean) => void;
  /** Approve and leave the note as a fix the agent makes before it schedules. Absent: a note cannot ride on an approval. */
  onApproveWithNote?: (note: string, only?: boolean) => void;
  /** The part is one format of a video that has others: a note covers them all unless "Only this format" is ticked. */
  onlyThisFormat?: boolean;
  /** Anything else under the decision (e.g. "Send back to rough cut"). */
  extra?: React.ReactNode;
}) {
  const [note, setNote] = useState("");
  const [composing, setComposing] = useState(false);
  const [only, setOnly] = useState(false);
  const latest = versions[versions.length - 1];
  const readOnly = !latest || viewing !== latest.revision;
  const open = openNotes(notes);
  const lower = /^(YouTube|LinkedIn|Instagram)/.test(label) ? label : label.charAt(0).toLowerCase() + label.slice(1);
  const hasNote = note.trim().length > 0;
  // The note clears at once (the request is optimistic). If the save fails, it comes back so nothing typed is lost.
  const sent = useRef("");
  useEffect(() => { if (error && sent.current) { setNote((n) => n || sent.current); setComposing(true); sent.current = ""; } }, [error]);
  const scoped = onlyThisFormat && only;
  const request = () => { if (!hasNote) return; sent.current = note.trim(); onRequest(note.trim(), scoped); setNote(""); setComposing(false); setOnly(false); };
  const approveWithNote = () => { if (!hasNote || !onApproveWithNote) return; sent.current = note.trim(); onApproveWithNote(note.trim(), scoped); setNote(""); setComposing(false); setOnly(false); };

  if (readOnly) {
    return (
      <div className="mt-3 rounded-lg border border-dashed border-line p-3 text-xs text-ink-2">
        Read only. This is {labelForRevision(versions, viewing) ?? "an older version"}; only the latest version ({latest?.label}) can be approved.
        {open.length > 0 && <ul className="mt-2 space-y-2">{open.filter((n) => n.revision === viewing).map((n) => <NoteItem key={n.id} note={n} versions={versions} />)}</ul>}
      </div>
    );
  }

  // Waiting for fix is the agent's turn: John already approved it with his note, so there is nothing to approve again.
  // The note stays on screen with who closes it; "Request changes" is still there if he wants a real review round.
  const settled = ui === "approved" || ui === "fixing";
  const showComposer = !settled || composing;
  // Minimal by design (John, 2026-10-13): his own open notes, one note box, Request changes and Approve. The approve
  // button reads "Approve"; its accessible name still says what it approves.
  const approveName = `${verb ?? `Approve ${lower}`}${ui === "changes" ? " anyway" : ""}`;
  return (
    <div className="mt-4 space-y-3">
      {ui === "fixing" && (
        <div className="space-y-1" data-testid="waiting-for-fix">
          <p className="text-sm font-medium text-amber-strong">Waiting for fix. You approved this with a note.</p>
          <p className="text-xs text-ink-3">
            The agent closes it: it applies your note, restages and verifies the result, then it schedules itself without coming back to you.
            {" "}Publishing stays blocked until then.
            {!composing && <> <button type="button" onClick={() => setComposing(true)} className="underline underline-offset-4 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Request changes instead</button></>}
          </p>
        </div>
      )}
      {ui === "changes" && <p className="text-sm font-medium text-amber-strong">Changes requested</p>}
      {textReset && ui === "pending" && <p className="text-sm font-medium text-amber-strong">Edited. Approve again.</p>}
      {ui === "approved" && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span className="inline-flex items-center gap-1.5 font-medium text-emerald-strong"><Check className="size-4" /> Approved {latest.label}</span>
          {onUnapprove && <button type="button" onClick={onUnapprove} className="text-xs text-ink-3 underline underline-offset-4 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Unapprove</button>}
          {!composing && <button type="button" onClick={() => setComposing(true)} className="text-xs text-ink-3 underline underline-offset-4 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Request changes</button>}
          {approvedNote && <span className="basis-full text-xs text-ink-3">{approvedNote}.</span>}
        </div>
      )}

      {open.length > 0 && <ul className="space-y-1.5" aria-label="Your open notes">{open.map((n) => <NoteItem key={n.id} note={n} versions={versions} />)}</ul>}

      {showComposer && (
        <textarea aria-label={`Note to the agent about the ${lower}`} value={note} rows={2} onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && hasNote) { e.preventDefault(); request(); } }}
          placeholder="What should change?" className={area} />
      )}
      {showComposer && onlyThisFormat && (
        <label className="flex w-fit items-center gap-1.5 text-xs text-ink-3">
          <input type="checkbox" checked={only} onChange={(e) => setOnly(e.target.checked)} className="size-3.5 accent-[color:var(--violet)]" />
          Only this format
        </label>
      )}
      {(showComposer || !settled) && (
        <div className="flex flex-wrap items-center gap-2">
          {!settled && (hasNote && onApproveWithNote
            ? <Button size="sm" onClick={approveWithNote} disabled={!!blocked} data-approve={approveAttr} aria-label={`${verb ?? `Approve ${lower}`} with note`}><Check /> Approve with note</Button>
            : hasNote || ui === "changes"
            ? <Button size="sm" variant="ghost" onClick={onApprove} disabled={!!blocked} data-approve={approveAttr} aria-label={approveName} className="text-emerald-strong hover:text-emerald-strong"><Check /> {ui === "changes" ? "Approve anyway" : "Approve"}</Button>
            : <Button size="sm" onClick={onApprove} disabled={!!blocked} data-approve={approveAttr} aria-label={approveName}><Check /> Approve</Button>)}
          {showComposer && (
            <Button size="sm" variant="secondary" onClick={request} disabled={!hasNote}
              className={hasNote ? "border-transparent bg-amber-strong text-white hover:border-transparent hover:bg-amber-strong/90 hover:text-white" : "border-[color:var(--amber)]/40 text-amber-strong"}>
              Request changes
            </Button>
          )}
          {!settled && blocked && <span className="text-xs text-ink-3">{blocked}</span>}
          {!settled && !blocked && hasNote && onApproveWithNote && <span className="basis-full text-xs text-ink-3">With note: the agent makes the fix and it schedules, without coming back to you.</span>}
          {!settled && !blocked && !(hasNote && onApproveWithNote) && consequence && <span className="text-xs text-ink-3">{consequence}.</span>}
        </div>
      )}
      {extra}
      {error && <p role="alert" className="text-xs text-red-strong">{error}</p>}
    </div>
  );
}
