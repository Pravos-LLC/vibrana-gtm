// The note dispatcher (ops/work-dispatch.sh, a LaunchAgent on John's Mac): every few minutes it asks `gtm work next`
// for one piece with John's notes that no job covers, and starts one headless Claude Code run on John's subscription to
// act on them. The run claims the piece with `gtm work add` first, so /work shows it In progress. This module picks the
// piece, finds the jobs a run left behind, and writes the run's instructions; it never runs anything itself.
import { IN_PROGRESS, type Board, type BoardRow, type WorkItem } from "./model";

type Waiting = Extract<BoardRow, { kind: "waiting" }>;

/** What the dispatcher remembers between runs, per waiting group and its exact notes: when it last tried, how often. */
export type DispatchState = Record<string, { attempts: number; last: string }>;

/** The agent label every dispatched run claims its job under (`gtm work add --agent dispatcher`). */
export const DISPATCH_AGENT = "dispatcher";
/** A run that never claimed its piece is retried after this long, at most this many times for the same notes. */
export const RETRY_AFTER_MINUTES = 30;
export const MAX_ATTEMPTS = 3;
/** A run is stopped after 45 minutes (ops/work-dispatch.sh); a dispatcher job silent for longer than this is left over. */
export const STALE_AFTER_MINUTES = 55;

/** The state key: the group plus its notes, so a new note on the same piece starts fresh. */
export const attemptKey = (g: Waiting) => `${g.key}|${g.notes.map((n) => n.note_id).sort().join(",")}`;

const pieceOf = (x: { source?: string; storyId?: string | null; storyboardId?: string | null }) => (x.source === "studio" ? x.storyboardId : x.storyId) ?? null;
const open = (i: WorkItem) => IN_PROGRESS.includes(i.status) && i.status !== "blocked";
const stale = (i: WorkItem, now: Date) => i.agent === DISPATCH_AGENT && now.getTime() - new Date(i.updated_at).getTime() > STALE_AFTER_MINUTES * 60_000;

/**
 * Only John's notes start an agent. The waiting list excludes agent and lint notes; anything else (a future reviewer
 * flow, an import) is left for John to decide on, never acted on unattended.
 */
export function johnsGroups(board: Board): Waiting[] {
  return board.waiting.flatMap((row) => {
    if (row.kind !== "waiting") return [];
    const notes = row.notes.filter((n) => n.author === "john");
    return notes.length ? [{ ...row, notes, since: notes.reduce((a, b) => (a.created_at <= b.created_at ? a : b)).created_at }] : [];
  });
}

/** Dispatcher jobs still marked as running past the run limit: their run is gone, so they are blocked, not busy. */
export const staleDispatcherJobs = (items: WorkItem[], now = new Date()) => items.filter((i) => open(i) && stale(i, now));

/** The dispatcher's jobs still open on a piece, after its run ended without finishing (a crash, a timeout). */
export const leftOpen = (items: WorkItem[], piece: string) => items.filter((i) => i.agent === DISPATCH_AGENT && open(i) && (i.story_id === piece || i.storyboard_id === piece));

/** Groups the dispatcher tried MAX_ATTEMPTS times without a claim: they go to /work as blocked, with the reason. */
export const exhausted = (board: Board, state: DispatchState) => johnsGroups(board).filter((g) => (state[attemptKey(g)]?.attempts ?? 0) >= MAX_ATTEMPTS);

/**
 * The oldest group of John's waiting notes to hand to an agent, or null. Skipped: a piece with a job still being
 * worked on (its agent picks up new notes itself; a blocked job or a dispatcher job left over from a dead run does not
 * count), a group tried in the last RETRY_AFTER_MINUTES, and one tried MAX_ATTEMPTS times.
 */
export function nextDispatch(board: Board, items: WorkItem[], state: DispatchState, now = new Date()): Waiting | null {
  const busy = new Set(items.filter((i) => open(i) && !stale(i, now)).flatMap((i) => [i.story_id, i.storyboard_id]).filter(Boolean));
  for (const row of johnsGroups(board)) {
    if (busy.has(pieceOf(row))) continue;
    const tried = state[attemptKey(row)];
    if (tried && (tried.attempts >= MAX_ATTEMPTS || now.getTime() - new Date(tried.last).getTime() < RETRY_AFTER_MINUTES * 60_000)) continue;
    return row;
  }
  return null;
}

/** Records a start, and drops entries for notes that are no longer waiting. */
export function markAttempt(state: DispatchState, row: Waiting, waitingKeys: string[], now = new Date()): DispatchState {
  const keep = Object.fromEntries(Object.entries(state).filter(([k]) => waitingKeys.includes(k)));
  const key = attemptKey(row);
  return { ...keep, [key]: { attempts: (keep[key]?.attempts ?? 0) + 1, last: now.toISOString() } };
}

/** The instructions for the headless run: one piece, claim first, fix, stage, resolve, report; never approve or publish. */
export function dispatchPrompt(row: Waiting): string {
  const id = pieceOf(row) ?? "";
  const ids = row.notes.map((n) => n.note_id).join(",");
  const target = `--story ${id}`;
  const notes = row.notes.map((n) => `- ${n.note_id} (${n.author}, ${n.created_at}${n.asset_id ? `, on ${n.asset_id}` : ""}):\n  ${n.body.replaceAll("\n", "\n  ")}`).join("\n");
  return `You are running unattended on John's Mac, started by the Vibrana note dispatcher (vibrana-gtm ops/work-dispatch.sh).
Act on John's open notes for ONE piece, then stop. Nobody is watching this session; the work board (/work) is how John
sees what you did.

Run the cockpit CLI as bare \`gtm ...\` (it is on PATH), even where a skill writes \`pnpm gtm ...\` or
\`pnpm -C vibrana-gtm gtm ...\`: \`pnpm gtm\`, \`pnpm run\`, \`pnpm -C\`, \`npx\` and \`node cli/gtm.ts\` are denied in this session.
Publishing, scheduling, releasing holds, sending and pushing are denied however they are spelled.

Piece: ${id} (a Story in /content)
Notes:
${notes}

1. Claim it before anything else: \`gtm work add --notes ${ids} ${target} --agent ${DISPATCH_AGENT} --eta 45m\`.
   Keep it current with \`gtm work update <id> --status working|rendering|checking --note "one plain line"\`.
2. Use the content-engine skill and follow its procedure for acting on John's notes. Read the notes in full with
   \`gtm story feedback ${id}\`. Follow the hub CLAUDE.md and RESOLVER.md rules: worktrees for any
   tracked-file change, the copy suite for copy, John's voice rules, never print secrets.
3. A note that says to kill, remove or drop the piece: run \`gtm piece kill ${id} --reason "<the note>"\` (its calendar rows
   go to skipped, its Zernio posts are deleted, its notes are resolved). If that fails, change nothing yourself:
   \`gtm work update <id> --status blocked --note "kill requested; gtm piece kill failed: <error>"\` and stop.
4. Otherwise make the change, then \`gtm story stage <manifest> --dry-run\` and the real stage,
   and answer every note: \`gtm story resolve <note-id> "<one line: what changed>"\`. Staging and
   resolving move the job forward on their own.
5. Never approve, schedule, publish, release a hold, send or merge anything; approval is John's. Never write a script
   that changes the database directly; only gtm commands change it. Never use an Anthropic API model in a pipeline.
6. If you cannot finish (a decision only John can make, a missing file, a credential), run
   \`gtm work update <id> --status blocked --note "<what you need>"\` and stop.`;
}
