// The work board's database half: gtm_work_items (written with the service role by the CLI) and
// gtm_work_waiting_notes() (John's notes no job covers yet). Pure rules live in lib/work/model.ts.
import type { SupabaseClient } from "@supabase/supabase-js";
import { must } from "../db";
import { parsePieceTitle } from "../season";
import { allHandled, answeredLine, defaultTitle, IN_PROGRESS, isWorkStatus, parseEta, WAITING_GRACE_MINUTES, type NoteState, type WaitingNote, type WorkItem, type WorkStatus } from "./model";

const COLUMNS = "id,created_at,updated_at,story_id,asset_id,storyboard_id,source_note_ids,title,status,agent,eta_at,last_update,blocked_reason,staged_at,done_at";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type NoteRef = NoteState & { story_id: string | null; asset_id: string | null; storyboard_id: string | null };

/** Where each note lives (a /content note), its piece, and whether an agent has answered it. */
export async function noteRefs(db: SupabaseClient, ids: string[]): Promise<NoteRef[]> {
  if (!ids.length) return [];
  const bad = ids.filter((id) => !UUID.test(id));
  if (bad.length) throw new Error(`not a note id: ${bad.join(", ")} (note ids are uuids: gtm story feedback lists them)`);
  const fb = await db.from("gtm_story_feedback").select("id,asset_id,resolved_at,gtm_story_assets(story_id)").in("id", ids);
  const content = (must(fb, "notes") ?? []) as unknown as Array<{ id: string; asset_id: string; resolved_at: string | null; gtm_story_assets: { story_id: string } | null }>;
  return content.map((r): NoteRef => ({ id: r.id, source: "content", story_id: r.gtm_story_assets?.story_id ?? null, asset_id: r.asset_id, storyboard_id: null, handled: !!r.resolved_at }));
}

const only = <T,>(xs: (T | null)[]): T | null => { const u = [...new Set(xs.filter((x): x is T => x != null))]; return u.length === 1 ? u[0] : null; };

/** The piece's name for a default title: the story's name after "W4 Tue Oct 27 | ". */
async function pieceName(db: SupabaseClient, storyId: string | null): Promise<string | null> {
  if (!storyId) return null;
  const s = must(await db.from("gtm_stories").select("title").eq("id", storyId).maybeSingle(), "story") as { title: string } | null;
  return s ? parsePieceTitle(s.title).name : null;
}

export type AddInput = { story?: string; notes?: string[]; title?: string; eta?: string; agent?: string; asset?: string; status?: string; note?: string };

/**
 * `gtm work add`: a job an agent (or the dispatcher) picked up. The piece comes from --story, else from the notes
 * (when they are all on one piece); every note id must exist. A note another open job already covers is reported, not
 * refused, so a second agent on the same note is visible rather than silent.
 */
export async function addWork(db: SupabaseClient, input: AddInput, now = new Date()) {
  const notes = [...new Set((input.notes ?? []).map((n) => n.trim()).filter(Boolean))];
  if (!notes.length && !input.story) throw new Error("give --notes <ids> (and/or --story <id>): a job is about a piece or John's notes");
  const refs = await noteRefs(db, notes);
  const missing = notes.filter((id) => !refs.some((r) => r.id === id));
  if (missing.length) throw new Error(`no such note: ${missing.join(", ")}`);
  const status = input.status ?? "queued";
  if (!isWorkStatus(status) || status === "done") throw new Error(`--status for a new job is one of queued, working, rendering, checking, staged, blocked`);
  if (status === "blocked" && !input.note?.trim()) throw new Error('a blocked job needs --note "why"');
  const storyId = input.story ?? only(refs.map((r) => r.story_id));
  if (input.story) must(await db.from("gtm_stories").select("id").eq("id", input.story).single(), `story ${input.story}`);
  const title = (input.title?.trim() || defaultTitle(await pieceName(db, storyId), notes.length)).slice(0, 200);
  const overlap = notes.length ? (must(await db.from("gtm_work_items").select("id,title").overlaps("source_note_ids", notes).neq("status", "done"), "overlap") as Array<{ id: string; title: string }>) : [];
  const eta = input.eta != null ? parseEta(input.eta, now) : null;
  const row = must(await db.from("gtm_work_items").insert({
    story_id: storyId, asset_id: input.asset ?? only(refs.map((r) => r.asset_id)), storyboard_id: null, source_note_ids: notes, title,
    status, agent: (input.agent?.trim() || process.env.GTM_AGENT || "agent").slice(0, 80), eta_at: eta?.toISOString() ?? null,
    last_update: (status === "blocked" ? "" : input.note?.trim() ?? "").slice(0, 300), blocked_reason: status === "blocked" ? input.note!.trim().slice(0, 1000) : "",
  }).select(COLUMNS).single(), "add work item") as WorkItem;
  return { item: row, alsoCoveredBy: overlap };
}

/** A job by its id or an unambiguous prefix of it (the CLI prints the first 8 characters). */
export async function findWork(db: SupabaseClient, ref: string): Promise<WorkItem> {
  const r = ref.trim().toLowerCase();
  if (UUID.test(r)) {
    const row = must(await db.from("gtm_work_items").select(COLUMNS).eq("id", r).maybeSingle(), "work item") as WorkItem | null;
    if (!row) throw new Error(`no work item ${ref}`);
    return row;
  }
  if (!/^[0-9a-f-]{4,}$/.test(r)) throw new Error(`"${ref}" is not a work item id (gtm work list shows them)`);
  const rows = must(await db.from("gtm_work_items").select(COLUMNS).order("updated_at", { ascending: false }).limit(1000), "work items") as WorkItem[];
  const hits = rows.filter((w) => w.id.startsWith(r));
  if (hits.length !== 1) throw new Error(hits.length ? `"${ref}" matches ${hits.length} work items; give more of the id` : `no work item ${ref}`);
  return hits[0];
}

export type UpdateInput = { status?: string; note?: string; eta?: string; title?: string; addNotes?: string[]; agent?: string };

/** `gtm work update`: status, the one-line progress note, the ETA, more notes. Blocked takes its reason from --note. */
export async function updateWork(db: SupabaseClient, ref: string, input: UpdateInput, now = new Date()) {
  const item = await findWork(db, ref);
  const patch: Record<string, unknown> = {};
  if (input.status !== undefined) {
    if (!isWorkStatus(input.status)) throw new Error(`--status is one of queued, working, rendering, checking, staged, done, blocked`);
    patch.status = input.status;
  }
  const status = (patch.status ?? item.status) as WorkStatus;
  if (status === "blocked" && patch.status) {
    if (!input.note?.trim()) throw new Error('a blocked job needs --note "why" (it is shown to John)');
    patch.blocked_reason = input.note.trim().slice(0, 1000);
  } else if (input.note !== undefined) patch.last_update = input.note.trim().slice(0, 300);
  if (input.eta !== undefined) patch.eta_at = parseEta(input.eta, now)?.toISOString() ?? null;
  if (input.title?.trim()) patch.title = input.title.trim().slice(0, 200);
  if (input.agent?.trim()) patch.agent = input.agent.trim().slice(0, 80);
  if (input.addNotes?.length) {
    const refs = await noteRefs(db, input.addNotes);
    const missing = input.addNotes.filter((id) => !refs.some((r) => r.id === id));
    if (missing.length) throw new Error(`no such note: ${missing.join(", ")}`);
    patch.source_note_ids = [...new Set([...item.source_note_ids, ...input.addNotes])];
  }
  if (!Object.keys(patch).length) throw new Error("nothing to change: give --status, --note, --eta, --title, --agent or --notes");
  return must(await db.from("gtm_work_items").update(patch).eq("id", item.id).select(COLUMNS).single(), "update work item") as WorkItem;
}

/** `gtm work done`: finished. Reports any of its notes still unanswered, since the board stops listing them as waiting. */
export async function doneWork(db: SupabaseClient, ref: string, note?: string) {
  const item = await findWork(db, ref);
  const states = await noteRefs(db, item.source_note_ids);
  const unanswered = item.source_note_ids.filter((id) => !(states.find((s) => s.id === id)?.handled ?? true));
  const row = must(await db.from("gtm_work_items").update({ status: "done", last_update: (note?.trim() || "Done").slice(0, 300) }).eq("id", item.id).select(COLUMNS).single(), "done") as WorkItem;
  return { item: row, unanswered };
}

/** `gtm work list`: open jobs (and staged or done in the last day unless --all is false), plus the notes nobody has. */
export async function listWork(db: SupabaseClient, opts: { all?: boolean; graceMinutes?: number } = {}) {
  let q = db.from("gtm_work_items").select(COLUMNS).order("updated_at", { ascending: false }).limit(opts.all ? 500 : 200);
  if (!opts.all) q = q.or(`status.in.(${IN_PROGRESS.join(",")}),updated_at.gte.${new Date(Date.now() - 24 * 60 * 60_000).toISOString()}`);
  const items = must(await q, "work items") as WorkItem[];
  const waiting = await waitingNotes(db, opts.graceMinutes);
  return { items, waiting };
}

export async function waitingNotes(db: SupabaseClient, graceMinutes = WAITING_GRACE_MINUTES): Promise<WaitingNote[]> {
  // The Studio is retired: comments left on old storyboards are not work for an agent.
  return ((must(await db.rpc("gtm_work_waiting_notes", { p_grace: `${graceMinutes} minutes` }), "waiting notes") ?? []) as WaitingNote[]).filter((n) => n.source !== "studio");
}

export type Advanced = { id: string; title: string; from: WorkStatus; to: WorkStatus; note: string };

/** Moves each job forward on a restage: staged, or done (still listed for review) when every note is already answered. */
async function advanceStaged(db: SupabaseClient, items: WorkItem[], what: string): Promise<Advanced[]> {
  const out: Advanced[] = [];
  const states = await noteRefs(db, [...new Set(items.flatMap((i) => i.source_note_ids))]);
  for (const item of items) {
    const h = allHandled(item.source_note_ids, states);
    const to: WorkStatus = h.all ? "done" : "staged";
    const note = h.total ? `${what}; ${answeredLine(h)}` : what;
    must(await db.from("gtm_work_items").update({ status: to, last_update: note, staged_at: new Date().toISOString() }).eq("id", item.id), "advance work item");
    out.push({ id: item.id, title: item.title, from: item.status, to, note });
  }
  return out;
}

/** After `gtm story stage`: the piece's open /content jobs move to staged. */
export async function advanceOnStage(db: SupabaseClient, storyId: string): Promise<Advanced[]> {
  const items = must(await db.from("gtm_work_items").select(COLUMNS).eq("story_id", storyId).in("status", [...IN_PROGRESS]), "work items") as WorkItem[];
  return advanceStaged(db, items, "New version staged in /content");
}

/**
 * After a note is answered (`gtm story resolve`): each open job covering it is done once all
 * of its notes are answered; otherwise its line says how many are.
 */
export async function advanceOnResolve(db: SupabaseClient, noteIds: string[]): Promise<Advanced[]> {
  if (!noteIds.length) return [];
  const items = must(await db.from("gtm_work_items").select(COLUMNS).overlaps("source_note_ids", noteIds).neq("status", "done"), "work items") as WorkItem[];
  const states = await noteRefs(db, [...new Set(items.flatMap((i) => i.source_note_ids))]);
  const out: Advanced[] = [];
  for (const item of items) {
    const h = allHandled(item.source_note_ids, states);
    const to: WorkStatus = h.all ? "done" : item.status;
    const line = answeredLine(h);
    const note = line.charAt(0).toUpperCase() + line.slice(1);
    must(await db.from("gtm_work_items").update({ status: to, last_update: note }).eq("id", item.id), "advance work item");
    out.push({ id: item.id, title: item.title, from: item.status, to, note });
  }
  return out;
}

/** The nav badge and the /content strip. Never throws: a count that cannot load is just not shown. */
export async function workCounts(db: SupabaseClient): Promise<{ inProgress: number; waiting: number } | null> {
  try {
    const [items, waiting] = await Promise.all([
      db.from("gtm_work_items").select("id", { count: "exact", head: true }).in("status", [...IN_PROGRESS]),
      db.rpc("gtm_work_waiting_notes", { p_grace: `${WAITING_GRACE_MINUTES} minutes` }),
    ]);
    if (items.error || waiting.error) return null;
    const pieces = new Set(((waiting.data ?? []) as WaitingNote[]).filter((n) => n.source !== "studio").map((n) => n.story_id));
    return { inProgress: items.count ?? 0, waiting: pieces.size };
  } catch {
    return null;
  }
}

export type PieceInfo = { name: string; thumbPath: string | null };

/** Names and a preview still for the board's pieces: a piece's poster or image. */
export async function pieceInfo(db: SupabaseClient, storyIds: string[], assetIds: string[]) {
  const [stories, assets] = await Promise.all([
    storyIds.length ? db.from("gtm_stories").select("id,title").in("id", storyIds) : Promise.resolve({ data: [], error: null }),
    storyIds.length ? db.from("gtm_story_assets").select("id,story_id,kind,storage_path,stage,metadata").in("story_id", storyIds) : Promise.resolve({ data: [], error: null }),
  ]);
  type A = { id: string; story_id: string; kind: string; storage_path: string | null; stage: string | null; metadata: Record<string, unknown> | null };
  const assetRows = (assets.data ?? []) as A[];
  const still = (a: A) => (a.kind === "video" ? (typeof a.metadata?.poster_path === "string" ? a.metadata.poster_path : null) : a.kind === "image" ? a.storage_path : null);
  const story = new Map<string, PieceInfo>();
  for (const s of (stories.data ?? []) as Array<{ id: string; title: string }>) {
    const own = assetRows.filter((a) => a.story_id === s.id && still(a));
    // The asset the job is about first, then a final, then whatever has a still.
    const pick = own.find((a) => assetIds.includes(a.id)) ?? own.find((a) => (a.stage ?? "final") === "final" && a.kind === "video") ?? own.sort((x, y) => x.id.localeCompare(y.id))[0];
    story.set(s.id, { name: parsePieceTitle(s.title).name, thumbPath: pick ? still(pick) : null });
  }
  return { story };
}
