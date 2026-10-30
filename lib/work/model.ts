// The work board (/work, `gtm work`): what happens to John's notes between his comment and the restage (John,
// 2026-10-13: "I don't know when my comments trigger agent runs or not"). Pure: the CLI, the page, the nav badge and
// the tests read the same answers. The database half is lib/work/store.ts; the table is gtm_work_items (brand.example.com
// migration 20261013230000_gtm_work_items.sql).

export const WORK_STATUSES = ["queued", "working", "rendering", "checking", "staged", "done", "blocked"] as const;
export type WorkStatus = (typeof WORK_STATUSES)[number];
export const isWorkStatus = (s: unknown): s is WorkStatus => (WORK_STATUSES as readonly unknown[]).includes(s);

/** Still being worked (or stuck): the "In progress" group and the nav badge. */
export const IN_PROGRESS: readonly WorkStatus[] = ["queued", "working", "rendering", "checking", "blocked"];
export const STATUS_LABEL: Record<WorkStatus, string> = {
  queued: "Queued", working: "Working", rendering: "Rendering", checking: "Checking", staged: "Staged", done: "Done", blocked: "Blocked",
};

/** How long after John leaves a note it counts as not picked up (the note dispatcher, ops/work-dispatch.sh, polls every 3 minutes). */
export const WAITING_GRACE_MINUTES = 5;

export type WorkItem = {
  id: string; created_at: string; updated_at: string;
  story_id: string | null; asset_id: string | null; storyboard_id: string | null;
  source_note_ids: string[]; title: string; status: WorkStatus; agent: string;
  eta_at: string | null; last_update: string; blocked_reason: string;
  staged_at: string | null; done_at: string | null;
};

/** A John (or third-party) note no work item covers yet (gtm_work_waiting_notes). */
export type WaitingNote = {
  source: "content" | "studio"; note_id: string; story_id: string | null; asset_id: string | null; storyboard_id: string | null;
  author: string; body: string; created_at: string;
};

/**
 * `--eta 45m`, `2h`, `1h30m`, `90` (minutes) or an ISO timestamp, to an absolute time. Null for "" or "none" (clears it).
 * Anything else throws, so a typo never silently drops the ETA.
 */
export function parseEta(input: string, now = new Date()): Date | null {
  const s = input.trim().toLowerCase();
  if (!s || s === "none" || s === "-") return null;
  const rel = /^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m(?:in)?)?$/.exec(s);
  if (rel && (rel[1] || rel[2])) return new Date(now.getTime() + (Number(rel[1] ?? 0) * 60 + Number(rel[2] ?? 0)) * 60_000);
  if (/^\d+$/.test(s)) return new Date(now.getTime() + Number(s) * 60_000);
  if (/^\d{4}-\d{2}-\d{2}t/.test(s)) {
    const d = new Date(input.trim());
    if (!Number.isNaN(d.getTime())) return d;
  }
  throw new Error(`--eta "${input}": give minutes or hours (45m, 2h, 1h30m) or an ISO time`);
}

/** "about 30 min", "about 2 h", "any minute" (under 3 min or overdue by less than 15), "overdue", or "—". */
export function etaLabel(eta: string | null, status: WorkStatus, now = new Date()): string {
  if (!eta || status === "done" || status === "staged") return "—";
  const min = Math.round((new Date(eta).getTime() - now.getTime()) / 60_000);
  if (min < -15) return "overdue";
  if (min < 3) return "any minute";
  if (min < 60) return `about ${Math.max(5, Math.round(min / 5) * 5)} min`;
  const h = min / 60;
  return `about ${h < 10 ? Math.round(h * 2) / 2 : Math.round(h)} h`;
}

/** "just now", "4m ago", "2h ago", "3d ago". */
export function agoLabel(at: string, now = new Date()): string {
  const min = Math.floor((now.getTime() - new Date(at).getTime()) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  if (min < 60 * 24) return `${Math.floor(min / 60)}h ago`;
  return `${Math.floor(min / 60 / 24)}d ago`;
}

/** The calendar day of an instant in a timezone (YYYY-MM-DD). */
export function dayIn(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

export type BoardRow =
  | { kind: "item"; key: string; item: WorkItem }
  | { kind: "waiting"; key: string; storyId: string | null; storyboardId: string | null; source: "content" | "studio"; notes: WaitingNote[]; since: string };

export type Board = { waiting: BoardRow[]; inProgress: BoardRow[]; review: BoardRow[]; doneToday: BoardRow[] };

/**
 * The four groups. Waiting: John's notes no job covers, one row per piece (and surface). In progress: queued to
 * checking, and blocked. Ready for your review: a new version staged in the last 24 hours, whether or not every note
 * is answered yet (a staged job whose notes are all resolved is done, and still waits on John). Done today: finished
 * today in the calendar timezone and not in review. Everything else (older done work) is history and left out.
 */
export function buildBoard(items: WorkItem[], waiting: WaitingNote[], now: Date, timeZone: string): Board {
  const today = dayIn(now, timeZone);
  const dayAgo = now.getTime() - 24 * 60 * 60_000;
  const byUpdate = (a: BoardRow, b: BoardRow) => (rowTime(b) > rowTime(a) ? 1 : rowTime(b) < rowTime(a) ? -1 : 0);
  const board: Board = { waiting: [], inProgress: [], review: [], doneToday: [] };
  for (const item of items) {
    const row: BoardRow = { kind: "item", key: item.id, item };
    if (IN_PROGRESS.includes(item.status)) board.inProgress.push(row);
    else if (item.staged_at && new Date(item.staged_at).getTime() >= dayAgo) board.review.push(row);
    else if (item.status === "done" && item.done_at && dayIn(new Date(item.done_at), timeZone) === today) board.doneToday.push(row);
  }
  const groups = new Map<string, WaitingNote[]>();
  for (const n of waiting) {
    const key = `${n.source}:${n.source === "studio" ? n.storyboard_id : n.story_id}`;
    groups.set(key, [...(groups.get(key) ?? []), n]);
  }
  for (const [key, notes] of groups) {
    const first = notes.reduce((a, b) => (a.created_at <= b.created_at ? a : b));
    board.waiting.push({ kind: "waiting", key, storyId: first.story_id, storyboardId: first.storyboard_id, source: first.source, notes, since: first.created_at });
  }
  board.waiting.sort((a, b) => (rowTime(a) < rowTime(b) ? -1 : 1));
  board.inProgress.sort(byUpdate);
  board.review.sort(byUpdate);
  board.doneToday.sort(byUpdate);
  return board;
}
const rowTime = (r: BoardRow) => (r.kind === "item" ? r.item.updated_at : r.since);

/** The nav badge and the /content strip: "3 in progress · 1 waiting"; null when there is nothing to say. */
export function workSummary(inProgress: number, waiting: number): string | null {
  const parts = [inProgress ? `${inProgress} in progress` : "", waiting ? `${waiting} waiting` : ""].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/** "3 jobs in progress · 1 waiting" for the strip at the top of /content. */
export function contentStrip(inProgress: number, waiting: number): string {
  return `${inProgress} job${inProgress === 1 ? "" : "s"} in progress · ${waiting} waiting`;
}

/** Where the piece lives: its card in /content. */
export function pieceHref(r: { storyId: string | null; storyboardId: string | null }): string | null {
  if (r.storyId?.startsWith("packaging-")) return `/content?view=templates&story=${encodeURIComponent(r.storyId.slice("packaging-".length))}`;
  if (r.storyId) return `/content?piece=${encodeURIComponent(r.storyId)}`;
  return null;
}

/** A default title when the dispatcher gives none: "Meridian Short B: 5 notes". */
export function defaultTitle(pieceName: string | null, notes: number): string {
  const n = notes ? `${notes} note${notes === 1 ? "" : "s"}` : "work";
  return pieceName ? `${pieceName}: ${n}` : n.charAt(0).toUpperCase() + n.slice(1);
}

/** "your note answered", "all 3 notes answered", "1 of 2 notes answered": the line John reads on a job. */
export function answeredLine(h: { handled: number; total: number; all: boolean }): string {
  if (h.all) return h.total === 1 ? "your note answered" : `all ${h.total} notes answered`;
  return `${h.handled} of ${h.total} notes answered`;
}

/**
 * A note is handled once an agent has answered it: a /content note is resolved; a /studio note is addressed (it then
 * waits on John's approval), resolved, withdrawn or won't-fix. A note that no longer exists is handled too.
 */
export type NoteState = { id: string; source: "content" | "studio"; handled: boolean };
export function allHandled(noteIds: string[], states: NoteState[]): { handled: number; total: number; all: boolean } {
  const total = noteIds.length;
  const handled = noteIds.filter((id) => states.find((s) => s.id === id)?.handled ?? true).length;
  return { handled, total, all: total > 0 && handled === total };
}
