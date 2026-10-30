import test from "node:test";
import assert from "node:assert/strict";
import { buildBoard, type WaitingNote, type WorkItem } from "../lib/work/model";
import { DISPATCH_AGENT, MAX_ATTEMPTS, STALE_AFTER_MINUTES, attemptKey, dispatchPrompt, exhausted, johnsGroups, leftOpen, markAttempt, nextDispatch, staleDispatcherJobs } from "../lib/work/dispatch";

const now = new Date("2026-10-17T10:00:00Z");
const note = (note_id: string, story_id: string, created_at: string, body = "fix slide 3", author = "john"): WaitingNote =>
  ({ source: "content", note_id, story_id, asset_id: `${story_id}-copy`, storyboard_id: null, author, body, created_at });
const item = (story_id: string, status: WorkItem["status"], agent = "a", updated_at = "2026-10-17T09:50:00Z"): WorkItem => ({
  id: `w-${story_id}`, created_at: "t", updated_at, story_id, asset_id: null, storyboard_id: null,
  source_note_ids: [], title: story_id, status, agent, eta_at: null, last_update: "", blocked_reason: "", staged_at: null, done_at: null,
});
const waiting = [note("n2", "s1-02-b", "2026-10-17T08:00:00Z"), note("n1", "s1-01-a", "2026-10-16T08:00:00Z"), note("n3", "s1-01-a", "2026-10-16T09:00:00Z")];

test("picks the oldest waiting piece, with all its notes", () => {
  const board = buildBoard([], waiting, now, "Europe/Berlin");
  const row = nextDispatch(board, [], {}, now);
  assert.equal(row?.storyId, "s1-01-a");
  assert.deepEqual(row?.notes.map((n) => n.note_id), ["n1", "n3"]);
});

test("skips a piece whose job is still in progress, and one tried recently or too often", () => {
  const items = [item("s1-01-a", "working")];
  const board = buildBoard(items, waiting, now, "Europe/Berlin");
  assert.equal(nextDispatch(board, items, {}, now)?.storyId, "s1-02-b");
  const free = buildBoard([], waiting, now, "Europe/Berlin");
  const first = free.waiting[0];
  if (first.kind !== "waiting") throw new Error("expected a waiting row");
  const keys = free.waiting.flatMap((g) => (g.kind === "waiting" ? [attemptKey(g)] : []));
  const tried = markAttempt({}, first, keys, new Date("2026-10-17T09:50:00Z"));
  assert.equal(nextDispatch(free, [], tried, now)?.storyId, "s1-02-b", "tried 10 minutes ago: wait");
  assert.equal(nextDispatch(free, [], tried, new Date("2026-10-17T10:30:00Z"))?.storyId, "s1-01-a", "half an hour later: retry");
  const spent = { [attemptKey(first)]: { attempts: MAX_ATTEMPTS, last: "2026-10-16T00:00:00Z" } };
  assert.equal(nextDispatch(free, [], spent, now)?.storyId, "s1-02-b", "three attempts: leave it");
});

test("a new note on the same piece starts its attempts fresh, and stale entries are dropped", () => {
  const board = buildBoard([], waiting, now, "Europe/Berlin");
  const first = board.waiting[0];
  if (first.kind !== "waiting") throw new Error("expected a waiting row");
  const spent = { [attemptKey(first)]: { attempts: MAX_ATTEMPTS, last: "2026-10-16T00:00:00Z" }, "gone|x": { attempts: 1, last: "2026-10-16T00:00:00Z" } };
  const more = buildBoard([], [...waiting, note("n4", "s1-01-a", "2026-10-17T09:30:00Z")], now, "Europe/Berlin");
  assert.equal(nextDispatch(more, [], spent, now)?.storyId, "s1-01-a");
  const next = more.waiting[0];
  if (next.kind !== "waiting") throw new Error("expected a waiting row");
  const marked = markAttempt(spent, next, more.waiting.flatMap((g) => (g.kind === "waiting" ? [attemptKey(g)] : [])), now);
  assert.deepEqual(Object.keys(marked), [attemptKey(next)]);
  assert.equal(marked[attemptKey(next)].attempts, 1);
});

test("the prompt claims first, names every note and forbids approving or publishing", () => {
  const board = buildBoard([], [note("n1", "s1-35-aios-build-1", "2026-10-16T08:00:00Z", "Kill it, this sucks.")], now, "Europe/Berlin");
  const row = board.waiting[0];
  if (row.kind !== "waiting") throw new Error("expected a waiting row");
  const p = dispatchPrompt(row);
  assert.match(p, /gtm work add --notes n1 --story s1-35-aios-build-1 --agent dispatcher/);
  assert.match(p, /Kill it, this sucks\./);
  assert.match(p, /gtm piece kill s1-35-aios-build-1/);
  assert.match(p, /change nothing yourself/);
  assert.match(p, /bare `gtm \.\.\.`/, "the run is told to call gtm directly, not through pnpm");
  assert.match(p, /`pnpm gtm`, `pnpm run`, `pnpm -C`, `npx` and `node cli\/gtm\.ts` are denied/);
  assert.doesNotMatch(p, /adminDb|tsx script/, "an unattended run never hand-writes database changes");
  assert.match(p, /Never write a script\s+that changes the database directly/);
  assert.match(p, /Never approve, schedule, publish, release a hold, send or merge/);
  assert.ok(p.indexOf("gtm work add") < p.indexOf("content-engine"), "claim comes before the work");
});

test("a dispatcher run that died does not freeze its piece: stale jobs are not busy and are listed for blocking", () => {
  const old = new Date(now.getTime() - (STALE_AFTER_MINUTES + 5) * 60_000).toISOString();
  const dead = item("s1-01-a", "working", DISPATCH_AGENT, old);
  const board = buildBoard([dead], [...waiting, note("n9", "s1-01-a", "2026-10-17T09:55:00Z")], now, "Europe/Berlin");
  assert.equal(nextDispatch(board, [dead], {}, now)?.storyId, "s1-01-a", "a new note on the piece is picked up");
  assert.deepEqual(staleDispatcherJobs([dead, item("s1-02-b", "working", "someone-else", old)], now).map((w) => w.id), ["w-s1-01-a"]);
  const fresh = item("s1-01-a", "working", DISPATCH_AGENT);
  assert.equal(nextDispatch(buildBoard([fresh], waiting, now, "Europe/Berlin"), [fresh], {}, now)?.storyId, "s1-02-b", "a live run still holds its piece");
  assert.deepEqual(staleDispatcherJobs([fresh], now), []);
});

test("a blocked job does not hold its piece, so John's answer to it is picked up", () => {
  const blocked = item("s1-01-a", "blocked", DISPATCH_AGENT);
  assert.equal(nextDispatch(buildBoard([blocked], waiting, now, "Europe/Berlin"), [blocked], {}, now)?.storyId, "s1-01-a");
});

test("the jobs a run left open on its piece are the dispatcher's open ones only", () => {
  const items = [item("s1-01-a", "rendering", DISPATCH_AGENT), { ...item("s1-01-a", "working", "someone-else"), id: "other" }, { ...item("s1-01-a", "done", DISPATCH_AGENT), id: "finished" }, item("s1-02-b", "working", DISPATCH_AGENT)];
  assert.deepEqual(leftOpen(items, "s1-01-a").map((w) => w.id), ["w-s1-01-a"]);
});

test("only John's notes start a run", () => {
  const board = buildBoard([], [note("x1", "s1-03-c", "2026-10-15T08:00:00Z", "approve it", "reviewer"), ...waiting], now, "Europe/Berlin");
  assert.equal(nextDispatch(board, [], {}, now)?.storyId, "s1-01-a");
  const mixed = buildBoard([], [note("x1", "s1-01-a", "2026-10-15T08:00:00Z", "x", "import"), ...waiting], now, "Europe/Berlin");
  assert.deepEqual(johnsGroups(mixed)[0].notes.map((n) => n.note_id), ["n1", "n3"]);
});

test("notes tried three times are handed to /work as exhausted", () => {
  const board = buildBoard([], waiting, now, "Europe/Berlin");
  const first = johnsGroups(board)[0];
  assert.deepEqual(exhausted(board, { [attemptKey(first)]: { attempts: MAX_ATTEMPTS, last: "2026-10-16T00:00:00Z" } }).map((g) => g.storyId), ["s1-01-a"]);
  assert.deepEqual(exhausted(board, { [attemptKey(first)]: { attempts: 1, last: "2026-10-16T00:00:00Z" } }), []);
});
