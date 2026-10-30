"use client";

// Client state for the Content review screen. The server renders once; after that the browser is the
// source of truth for what the owner has just done, so a click never waits on a page re-render. The
// same pure reducer drives both the committed state here and each part's optimistic copy.
import { createContext, useCallback, useContext, useMemo, useReducer, type ReactNode } from "react";
import type { EditableField } from "@/lib/season";
import { combineStatus, summarize, type Overview, type SummaryCard, type SummaryStage } from "@/lib/season-review";
import {
  addSeriesNote, approveMediaWithNote, approveTextWithNote, approveTextWithNoteAll, decideStage, reopenStage, requestChanges, requestMediaChanges, requestTextChangesAll, saveSeasonCopy, setMediaApproval, setPartApproval, setStoryHold, setTextApprovalAll, killPiece, markPublished,
} from "@/app/stories/actions";
import { shareForReview } from "@/app/content/reviewer-actions";
import type { ShareForReviewAction } from "@/components/review/share-for-review";
import type { SetHold } from "./third-party-hold";
import { noteSent } from "@/components/ui/toaster";

export type Result = { ok: true } | { ok: false; error: string };
export type SaveResult = { ok: true; sha256: string; revision: number } | { ok: false; error: string; conflict?: { revision: number } };
export type Expected = { asset_id: string; sha256: string; revision: number };

/** The server calls the screen makes. The dev fixture swaps in fakes. */
export type ReviewActions = {
  /** `assetId` narrows a text decision to one copy file (a newsletter essay: a Story can carry two). */
  setPartApproval: (input: { storyId: string; channel: string; part: "text" | "asset"; approve: boolean; assetId?: string }) => Promise<Result>;
  setTextApprovalAll: (input: { storyId: string; channels: string[]; approve: boolean }) => Promise<Result>;
  requestChanges: (input: { storyId: string; channel: string; part: "text" | "asset"; note: string; assetId?: string }) => Promise<Result>;
  setMediaApproval: (input: { storyId: string; assetIds: string[]; channels: string[]; expected: Expected[]; approve: boolean }) => Promise<Result>;
  requestMediaChanges: (input: { storyId: string; assetIds: string[]; channels: string[]; expected: Expected[]; note: string }) => Promise<Result>;
  approveTextWithNote: (input: { storyId: string; channel: string; note: string; assetId?: string }) => Promise<Result>;
  requestTextChangesAll: (input: { storyId: string; channels: string[]; note: string }) => Promise<Result>;
  approveTextWithNoteAll: (input: { storyId: string; channels: string[]; note: string }) => Promise<Result>;
  approveMediaWithNote: (input: { storyId: string; assetIds: string[]; channels: string[]; expected: Expected[]; note: string }) => Promise<Result>;
  decideStage: (input: { storyId: string; stage: string; decision: "approved" | "changes"; note: string; expected: Expected[] }) => Promise<Result>;
  reopenStage: (input: { storyId: string; stage: string; note: string; expected: Expected[] }) => Promise<Result>;
  saveSeasonCopy: (input: { assetId: string; prose: string; fields: Partial<Record<EditableField, string>>; expectedRevision: number; overwrite?: boolean }) => Promise<SaveResult>;
  setStoryHold: SetHold;
  addSeriesNote: (input: { storyIds: string[]; note: string }) => Promise<{ ok: true; failed: Array<{ id: string; error: string }> } | { ok: false; error: string }>;
  shareForReview: ShareForReviewAction;
  /** Takes the whole piece off the calendar and /content (lib/kill-piece.ts). */
  killPiece: (input: { storyId: string }) => Promise<Result>;
  /** A Substack essay is live: records its URL and the card leaves /content (lib/mark-published.ts). */
  markPublished: (input: { storyId: string; assetId: string; url: string }) => Promise<Result>;
};
export const realActions: ReviewActions = { setPartApproval, setTextApprovalAll, requestChanges, requestTextChangesAll, approveTextWithNoteAll, setMediaApproval, requestMediaChanges, approveTextWithNote, approveMediaWithNote, decideStage, reopenStage, saveSeasonCopy, setStoryHold, addSeriesNote, shareForReview, killPiece, markPublished };

/**
 * Every call that hands John's words to an agent (a note, changes, approve with note, a series note) says so when it
 * lands: "Sent. An agent will pick this up; track it in /work." Nothing in the web app runs an agent itself.
 */
export function withNoteToast(a: ReviewActions): ReviewActions {
  const after = <T extends { ok: boolean }>(p: Promise<T>, sent: boolean) => p.then((r) => { if (r.ok && sent) noteSent(); return r; });
  return {
    ...a,
    requestChanges: (i) => after(a.requestChanges(i), true),
    requestMediaChanges: (i) => after(a.requestMediaChanges(i), true),
    approveTextWithNote: (i) => after(a.approveTextWithNote(i), true),
    requestTextChangesAll: (i) => after(a.requestTextChangesAll(i), true),
    approveTextWithNoteAll: (i) => after(a.approveTextWithNoteAll(i), true),
    approveMediaWithNote: (i) => after(a.approveMediaWithNote(i), true),
    decideStage: (i) => after(a.decideStage(i), !!i.note.trim()),
    reopenStage: (i) => after(a.reopenStage(i), !!i.note.trim()),
    addSeriesNote: (i) => after(a.addSeriesNote(i), true),
  };
}

export { partReducer, initialPartState, partKey, type PartState, type Op } from "@/lib/review-state";
import { partReducer, type PartState, type Op } from "@/lib/review-state";

// Three contexts, so a part that only needs the stable handlers is not woken by every state change.
const ActionsCtx = createContext<{ commit: (key: string, op: Op) => void; actions: ReviewActions } | null>(null);
const StatesCtx = createContext<Record<string, PartState> | null>(null);
const OverviewCtx = createContext<Overview | null>(null);

function need<T>(v: T | null): T {
  if (!v) throw new Error("used outside ReviewProvider");
  return v;
}
export const useReviewActions = () => need(useContext(ActionsCtx));
export const usePartStates = () => need(useContext(StatesCtx));
export const useOverview = () => need(useContext(OverviewCtx));

type Action = { key: string; op: Op };

/**
 * `summary` and `stages` cover every card and stage review in the season, filtered out or not, so the overview strip
 * always describes the whole season. Parts on screen override their rows with live state.
 */
export function ReviewProvider({ initial, summary, stages = [], actions = realActions, children }: {
  initial: Record<string, PartState>; summary: SummaryCard[]; stages?: SummaryStage[]; actions?: ReviewActions; children: ReactNode;
}) {
  const [states, dispatch] = useReducer((s: Record<string, PartState>, a: Action) => {
    const prev = s[a.key];
    if (!prev) return s;
    const next = partReducer(prev, a.op);
    return next === prev ? s : { ...s, [a.key]: next };
  }, initial);
  const commit = useCallback((key: string, op: Op) => dispatch({ key, op }), []);
  const overview = useMemo(() => summarize(summary.map((c) => {
    const text = c.textKey ? states[c.textKey] : undefined;
    const media = (c.mediaKeys ?? []).map((k) => states[k]).filter((p): p is PartState => !!p);
    const open = (parts: PartState[]) => parts.reduce((n, p) => n + p.notes.filter((x) => !x.resolved_at).length, 0);
    return {
      ...c,
      textStatus: text?.status ?? c.textStatus,
      assetStatus: media.length ? combineStatus(media.map((m) => m.status)) : c.assetStatus,
      openNotes: text || media.length ? open([...(text ? [text] : []), ...media]) : c.openNotes,
    };
  }), stages.map((st) => ({ ...st, status: states[st.key]?.status ?? st.status }))), [summary, stages, states]);
  const stable = useMemo(() => ({ commit, actions: withNoteToast(actions) }), [commit, actions]);
  return (
    <ActionsCtx.Provider value={stable}>
      <OverviewCtx.Provider value={overview}>
        <StatesCtx.Provider value={states}>{children}</StatesCtx.Provider>
      </OverviewCtx.Provider>
    </ActionsCtx.Provider>
  );
}
