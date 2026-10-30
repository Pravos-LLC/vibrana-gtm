// Pure state for the Content review screen. This file is deliberately NOT a client module: the server page
// builds each part's initial state with it, and a server component cannot call a function that lives in a
// "use client" file.
//
// A piece is reviewed in parts (John, 2026-10-12): the text of each platform, each media file once for every platform
// that posts it, and, before the final, the stage the piece is at ("Approve rough cut"). Each part has one state.
import type { PartStatus } from "@/lib/season";
import type { AssetVersion, FeedbackItem } from "@/lib/season-review";

export type PartKind = "text" | "media" | "stage";

export type PartState = {
  status: PartStatus;
  /** Every note on the part, newest last. */
  notes: FeedbackItem[];
  /** The text asset's current revision, which moves when the owner saves an edit (text parts). */
  revision: number;
  /** Versions added by saving in this session (the database adds the same row). */
  addedVersions: AssetVersion[];
  /** True after the owner saved an edit: the database reset the text approval. */
  reset: boolean;
};

export type Op =
  | { type: "approve" }
  | { type: "unapprove" }
  | { type: "request"; note: FeedbackItem }
  /** "Approve with note": approved now, and the note stays open for the agent to apply before it schedules. */
  | { type: "approveWithNote"; note: FeedbackItem }
  | { type: "saved"; version: AssetVersion };

export const partKey = (kind: PartKind, storyId: string, id = "") => `${kind}|${storyId}|${id}`;

/** Pure: returns the same object when nothing changes, so memoised parts skip re-rendering. */
export function partReducer(state: PartState, op: Op): PartState {
  switch (op.type) {
    case "approve": return state.status === "approved" ? state : { ...state, status: "approved" };
    case "unapprove": return state.status === "pending" ? state : { ...state, status: "pending" };
    case "approveWithNote": return { ...state, status: "pending", notes: [...state.notes, op.note] };
    case "request": return { ...state, status: "rejected", notes: [...state.notes, op.note] };
    case "saved": return {
      ...state, revision: op.version.revision, addedVersions: [...state.addedVersions, op.version], reset: true,
      status: state.status === "none" ? "none" : "pending",
    };
  }
}

export function initialPartState(p: { status: PartStatus; notes: FeedbackItem[]; revision?: number }): PartState {
  return { status: p.status, notes: p.notes, revision: p.revision ?? 1, addedVersions: [], reset: false };
}

/** Runs one call per item in order, never stopping at a failure: a batch decision lists what failed and why. */
export async function runBatch<T>(items: T[], id: (t: T) => string, call: (t: T) => Promise<{ ok: true } | { ok: false; error: string }>) {
  const done: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  for (const item of items) {
    try {
      const r = await call(item);
      if (r.ok) done.push(id(item)); else failed.push({ id: id(item), error: r.error });
    } catch (e) {
      failed.push({ id: id(item), error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { done, failed };
}
