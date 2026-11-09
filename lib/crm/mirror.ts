// The CRM people mirror (VIB-516): every Twenty person, ids, dates and status flags only, copied into
// gtm_crm_people so the cockpit works on the whole CRM without re-reading Twenty every hour.
//
// Production Twenty is one small Postgres that saturated under repeated people reads on 2026-10-01
// (vibrana-crm docs/operations.md), so this job is gentle:
// - it runs hourly at :05, under its own lease, and skips the run when Twenty's /healthz is not 200;
// - it reads through TwentyReader (one request at a time, 1.5 s apart, backoff on 429/5xx, a hard deadline);
// - it reads only what changed: people whose updatedAt is at or after its cursor, then people soft-deleted since the
//   last pass. Each pass starts OVERLAP_MS before the last change it saw, so a write that committed out of order (stamped
//   earlier than one already read, committed later) is still read; upserts by id make the re-read harmless. Each page is
//   written, then the resume point is saved, so a run that stops at its deadline carries on next hour from the next page.
//   The first run is the backfill (about 140 pages for 14k people, one or two runs).
// - erasures (a row destroyed, not soft-deleted) are invisible to both streams, so once the streams are caught up it
//   compares counts of people created before a cutoff (so writes in flight cannot disagree). The same nonzero difference
//   on two checks in a row starts a resync: the change stream again from the beginning plus an id sweep that marks rows
//   Twenty no longer returns as deleted. The sweep refuses to remove more than half of a page's range at once (a breaker,
//   never a mass delete) and then holds until an operator clears it.
//
// Twenty's cursor under an updatedAt sort is a stateless {updatedAt, id} key with millisecond precision, while Postgres
// keeps microseconds; it hands back the boundary row again on the next page (measured on production 2026-11-09). So 100 or
// more people stamped in the same millisecond (one bulk statement) would return the same page forever. When the cursor
// stops moving, the stream reads that millisecond's people by id instead (an exact cursor), then carries on after it.
import type { SupabaseClient } from "@supabase/supabase-js";
import { must } from "../db";
import type { TwentyReader } from "../twenty";

export const MIRROR_KEY = "crm.people.mirror";
export const MIRROR_LEASE = "crm.mirror";
const EPOCH = "1970-01-01T00:00:00.000Z";
const PAGE = 100;
/** Each pass re-reads this much before the last change it saw: writes that committed out of order. */
export const OVERLAP_MS = 10 * 60_000;
/** The count check compares people created before (run start - this), so creates in flight cannot disagree. */
export const COUNT_CUTOFF_MS = 10 * 60_000;
/** A sweep page may remove at most this share of the mirror rows in its id range. */
const SWEEP_BREAKER = 0.5;
/** People read "not measured" (and an incident opens) after this long without a healthy run. */
export const STALE_MS = 6 * 3_600_000;
/** ...or this long without both streams caught up (a resync or backfill that never ends). */
export const CATCHUP_MS = 24 * 3_600_000;

const FIELDS = "id createdAt updatedAt deletedAt createdBy { source name workspaceMemberId } emails { primaryEmail } revEmailVerification prospectNotSendable companyId lastContactedAt";

type Node = {
  id: string; createdAt: string; updatedAt: string; deletedAt: string | null;
  createdBy: { source: string | null; name: string | null; workspaceMemberId: string | null } | null;
  emails: { primaryEmail: string | null } | null; revEmailVerification: string | null; prospectNotSendable: string | null;
  companyId: string | null; lastContactedAt: string | null;
};
type Page<N = Node> = { pageInfo: { hasNextPage: boolean; endCursor: string | null }; edges: { node: N }[] };

/**
 * One stream's position. `since` is the last change a finished pass saw; a pass reads from `from` (since minus the
 * overlap, fixed when the pass starts so its cursor stays valid) and pages with `after`.
 */
export type Stream = {
  since: string; from: string | null; after: string | null; maxSeen: string | null;
  /**
   * How far back the next pass must reach for late commits: OVERLAP_MS before the earliest page of this pass that was
   * reading near-real-time changes (its newest change within OVERLAP_MS of when it was read). Null when the pass only read
   * settled history; the next pass then starts just after `since` (review r2 R3, r3 N1 and N2).
   */
  passEndedAt: string | null;
  overlapFrom: string | null;
  /** A millisecond being read by id after the cursor stalled, and the id cursor's place: saved, so a deadline resumes it. */
  tie: { at: string; after: string | null } | null;
};
export type MirrorState = {
  changes: Stream;
  deletes: Stream;
  /** True once the change stream has read every person at least once. */
  backfillDone: boolean;
  /** When the mirror started (saved before its first read), so a mirror that never gets going is noticed. */
  startedAt: string;
  /** The last run that ended without an error (caught up, or stopped by its deadline while making progress). */
  lastOkAt: string | null;
  /** The last time both streams were caught up. */
  caughtUpAt: string | null;
  /** The last run's error, if it ended with one (cleared by a healthy run). */
  lastError: string | null;
  lastRunAt: string | null;
  /** The last count check: people created before `countCutoff`, in Twenty and live in the mirror. */
  twentyTotal: number | null;
  mirrorLive: number | null;
  countCutoff: string | null;
  countsCheckedAt: string | null;
  /** The signed difference (Twenty minus mirror) at the last check, and how many checks in a row have shown it. */
  diff: number;
  diffRuns: number;
  /** The last resync, and a difference that survived it: at most one resync a day, then an incident (review r2, R4). */
  lastResyncAt: string | null;
  unresolvedDiff: number | null;
  /** An id sweep in progress (after a resync starts), with its cursor and the last id it covered. */
  sweep: { after: string | null; lastId: string | null; removed: number } | null;
  /** Why the sweep stopped (its breaker). Raised as a health incident until an operator clears it (docs/deployment.md). */
  sweepError: string | null;
};

const stream0 = (since: string): Stream => ({ since, from: null, after: null, maxSeen: null, passEndedAt: null, overlapFrom: null, tie: null });
export const initialState = (now = new Date()): MirrorState => ({
  changes: stream0(EPOCH),
  // People soft-deleted before the mirror existed are never copied (the change stream reads live people only).
  deletes: stream0(now.toISOString()),
  backfillDone: false, startedAt: now.toISOString(), lastOkAt: null, caughtUpAt: null, lastError: null, lastRunAt: null,
  twentyTotal: null, mirrorLive: null, countCutoff: null, countsCheckedAt: null, diff: 0, diffRuns: 0, lastResyncAt: null, unresolvedDiff: null,
  sweep: null, sweepError: null,
});

export async function loadMirrorState(db: SupabaseClient): Promise<MirrorState | null> {
  const { data, error } = await db.from("gtm_sync_state").select("value").eq("key", MIRROR_KEY).maybeSingle();
  if (error) throw new Error(`mirror state: ${error.message}`);
  const v = data?.value as Partial<MirrorState> | undefined;
  // Fill fields a state written by an earlier version lacks.
  return v ? { ...initialState(new Date(v.startedAt ?? Date.now())), ...v, changes: { ...stream0(EPOCH), ...v.changes }, deletes: { ...stream0(new Date().toISOString()), ...v.deletes } } : null;
}

async function saveState(db: SupabaseClient, s: MirrorState) {
  const now = new Date().toISOString();
  must(await db.from("gtm_sync_state").upsert({ key: MIRROR_KEY, value: s, updated_at: now }, { onConflict: "key" }), "save mirror state");
}

const fresh = (iso: string | null, now: number, ms: number) => { const t = Date.parse(iso ?? ""); return Number.isFinite(t) && now - t <= ms; };

/** Whether the team page may count people from the mirror, and if not, why. */
export function mirrorReadiness(s: MirrorState | null, now = Date.now()): { ready: boolean; reason: string | null } {
  if (!s || !s.backfillDone) return { ready: false, reason: "the CRM mirror is still copying the CRM; people are counted once it finishes" };
  if (s.sweepError) return { ready: false, reason: "the CRM mirror's erasure check stopped at its safety limit; people are counted again once it is cleared" };
  if (!fresh(s.lastOkAt, now, STALE_MS)) return { ready: false, reason: "the CRM mirror has not synced in the last 6 hours" };
  if (!fresh(s.caughtUpAt, now, CATCHUP_MS)) return { ready: false, reason: "the CRM mirror has not caught up with the CRM in the last 24 hours" };
  return { ready: true, reason: null };
}

/**
 * The mirror's problems as health incidents (raised by the team run's email health check, emailed once, resolved when
 * gone): a sweep stopped by its breaker, no healthy run for 6 hours (including a mirror that never got going, with the
 * last error), or no catch-up for 24 hours.
 */
export function mirrorProblems(s: MirrorState | null, now = Date.now()): { key: string; summary: string }[] {
  if (!s) return [];
  if (s.sweepError) return [{ key: "health_check:crm_mirror:sweep", summary: `CRM mirror: ${s.sweepError}. Recovery: docs/deployment.md, CRM mirror` }];
  const why = s.lastError ? ` (last error: ${s.lastError.slice(0, 120)})` : "";
  if (!fresh(s.lastOkAt ?? s.startedAt, now, STALE_MS)) {
    return [{ key: "health_check:crm_mirror:stale", summary: s.lastOkAt
      ? `CRM mirror: no healthy sync for over 6 hours${why}; people are not measured`
      : `CRM mirror: no healthy sync since it started over 6 hours ago${why}; people are not measured` }];
  }
  if (!fresh(s.caughtUpAt ?? (s.backfillDone ? null : s.startedAt), now, CATCHUP_MS)) {
    return [{ key: "health_check:crm_mirror:stale", summary: "CRM mirror: has not caught up with the CRM for over 24 hours; people are not measured" }];
  }
  if (s.unresolvedDiff) {
    return [{ key: "health_check:crm_mirror:counts", summary: `CRM mirror: Twenty and the mirror still disagree by ${s.unresolvedDiff} people after a resync; it retries once a day (check for erasures or restores in Twenty)` }];
  }
  return [];
}

export const toRow = (n: Node, now: string) => ({
  id: n.id,
  created_at: n.createdAt,
  updated_at: n.updatedAt,
  deleted_at: n.deletedAt ?? null,
  created_by_source: n.createdBy?.source ?? null,
  created_by_name: n.createdBy?.name ?? null,
  created_by_member: n.createdBy?.workspaceMemberId ?? null,
  has_email: !!n.emails?.primaryEmail?.trim(),
  email_verification: n.revEmailVerification ?? null,
  // A TEXT reason code in Twenty: any nonempty reason blocks (the same rule as lib/team/crm.ts, VIB-510).
  not_sendable: !!String(n.prospectNotSendable ?? "").trim(),
  company_id: n.companyId ?? null,
  last_contacted_at: n.lastContactedAt ?? null,
  mirrored_at: now,
});

const later = (a: string | null, b: string | null) => (!a ? b : !b ? a : Date.parse(b) > Date.parse(a) ? b : a);
const plusMs = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();

export type MirrorRun = {
  skipped?: string;
  changes: { pages: number; rows: number; caughtUp: boolean; ties: number };
  deletes: { pages: number; rows: number; caughtUp: boolean; ties: number };
  counts?: { cutoff: string; twenty: number; mirror: number; match: boolean };
  sweep?: { pages: number; removed: number; done: boolean; error?: string };
  resync?: boolean;
  stopped?: string;
  /** True when the run ended on an error rather than finishing or reaching its deadline. */
  failed?: boolean;
};

async function upsertNodes(db: SupabaseClient, nodes: Node[], what: string) {
  if (!nodes.length) return 0;
  const now = new Date().toISOString();
  const rows = [...new Map(nodes.map((n) => [n.id, toRow(n, now)])).values()];
  must(await db.from("gtm_crm_people").upsert(rows, { onConflict: "id" }), what);
  return rows.length;
}

/**
 * Every person whose `field` falls in one millisecond, read by id with an exact cursor: what the stream does when its
 * own cursor stops moving because more people than a page share that millisecond.
 */
async function readTie(db: SupabaseClient, reader: TwentyReader, s: MirrorState, st: Stream, field: "updatedAt" | "deletedAt", out: { rows: number; ties: number; pages: number }) {
  const tie = st.tie!;
  const q = `query($f:PersonFilterInput,$a:String){ people(filter:$f, first:${PAGE}, after:$a, orderBy:[{id:AscNullsFirst}]) { pageInfo { hasNextPage endCursor } edges { node { ${FIELDS} } } } }`;
  // One top-level range on the field: inside an `and`, Twenty leaves most soft-deleted people out (measured 2026-11-09).
  const f = { [field]: { gte: tie.at, lt: plusMs(tie.at, 1) } };
  out.ties++;
  for (;;) {
    const d: { people: Page } = await reader.read<{ people: Page }>(q, { f, a: tie.after });
    out.rows += await upsertNodes(db, d.people.edges.map((e) => e.node), `mirror ${field} tie`);
    out.pages++;
    const more = d.people.pageInfo.hasNextPage && !!d.people.pageInfo.endCursor;
    if (more && d.people.pageInfo.endCursor === tie.after) throw new Error(`Twenty people (${field} ${tie.at}): the id cursor did not advance`);
    if (!more) {
      // The millisecond is done: the stream goes on from the next one.
      st.from = plusMs(tie.at, 1);
      st.after = null;
      st.tie = null;
      await saveState(db, s);
      return;
    }
    // Saved after every page, so a deadline mid-way resumes here next run (review r2, R1).
    tie.after = d.people.pageInfo.endCursor;
    await saveState(db, s);
  }
}

/** One stream, page by page, until it is caught up or the reader's deadline stops it. State is saved after every page. */
async function stream(db: SupabaseClient, reader: TwentyReader, s: MirrorState, which: "changes" | "deletes", out: MirrorRun["changes"]) {
  const st = s[which];
  const field = which === "changes" ? "updatedAt" : "deletedAt";
  const q = `query($f:PersonFilterInput,$a:String){ people(filter:$f, first:${PAGE}, after:$a, orderBy:[{${field}:AscNullsFirst},{id:AscNullsFirst}]) { pageInfo { hasNextPage endCursor } edges { node { ${FIELDS} } } } }`;
  if (st.from == null) {
    // A new pass. It reaches back OVERLAP_MS before the previous pass's last read (a write stamped then may have
    // committed after it), but never further than the last change seen: a quiet CRM re-reads almost nothing (R3).
    // Fixed for the whole pass so its cursor stays valid.
    // Just after the last change seen (every person at `since` was read: the pass ended with no next page), or further
    // back to cover writes that may have committed after a near-real-time page was read.
    const next = Date.parse(st.since) + 1, back = st.overlapFrom ? Date.parse(st.overlapFrom) : next;
    st.from = st.since === EPOCH ? EPOCH : new Date(Math.max(0, Math.min(next, back))).toISOString();
    st.overlapFrom = null;
    st.after = null;
    await saveState(db, s);
  }
  if (st.tie) await readTie(db, reader, s, st, field, out);
  let lastIds: Set<string> | null = null;
  for (;;) {
    const readAt = Date.now();
    const d = await reader.read<{ people: Page }>(q, { f: { [field]: { gte: st.from } }, a: st.after });
    const nodes = d.people.edges.map((e) => e.node);
    out.rows += await upsertNodes(db, nodes, `mirror ${which} page`);
    let pageMax: string | null = null;
    for (const n of nodes) pageMax = later(pageMax, which === "changes" ? n.updatedAt : n.deletedAt);
    st.maxSeen = later(st.maxSeen, pageMax);
    // A page reading changes from the last OVERLAP_MS may have missed a write stamped then but committed after this read.
    if (pageMax && Date.parse(pageMax) >= readAt - OVERLAP_MS) {
      const back = new Date(readAt - OVERLAP_MS).toISOString();
      if (!st.overlapFrom || back < st.overlapFrom) st.overlapFrom = back;
    }
    out.pages++;
    const more = d.people.pageInfo.hasNextPage && !!d.people.pageInfo.endCursor;
    const stuck = more && ((st.after && d.people.pageInfo.endCursor === st.after) || (!!lastIds && nodes.length > 0 && nodes.every((n) => lastIds!.has(n.id))));
    if (stuck) {
      // More people than a page share the boundary millisecond: read them by id, then go on from the next millisecond.
      const at = (which === "changes" ? nodes[nodes.length - 1]?.updatedAt : nodes[nodes.length - 1]?.deletedAt) ?? null;
      if (!at) throw new Error(`Twenty people (${which}): the cursor did not advance`);
      st.tie = { at: new Date(Math.floor(Date.parse(at))).toISOString(), after: null };
      await saveState(db, s);
      await readTie(db, reader, s, st, field, out);
      lastIds = null;
      continue;
    }
    lastIds = new Set(nodes.map((n) => n.id));
    if (more) st.after = d.people.pageInfo.endCursor;
    else {
      st.since = st.maxSeen ?? st.since;
      st.passEndedAt = new Date().toISOString();
      st.from = null;
      st.after = null;
      st.maxSeen = null;
      if (which === "changes") s.backfillDone = true;
    }
    await saveState(db, s);
    if (!more) { out.caughtUp = true; return; }
  }
}

/**
 * The id sweep: Twenty's ids in order, a page at a time; any live mirror row whose id falls inside the page's range but
 * is not on the page has been destroyed in Twenty and is marked deleted. Ordered by uuid on both sides.
 */
async function sweep(db: SupabaseClient, reader: TwentyReader, s: MirrorState, out: NonNullable<MirrorRun["sweep"]>) {
  const sw = s.sweep!;
  const q = `query($a:String){ people(first:${PAGE}, after:$a, orderBy:[{id:AscNullsFirst}]) { pageInfo { hasNextPage endCursor } edges { node { id } } } }`;
  for (;;) {
    const d = await reader.read<{ people: Page<{ id: string }> }>(q, { a: sw.after });
    const ids = d.people.edges.map((e) => e.node.id);
    const more = d.people.pageInfo.hasNextPage && !!d.people.pageInfo.endCursor;
    // An empty page that claims more would reset the range to everything: refuse it rather than judge on nothing.
    if (more && !ids.length) throw new Error("Twenty people (sweep): an empty page claimed more; the sweep resumes next run");
    const hi = more ? ids[ids.length - 1] : null;
    let range = db.from("gtm_crm_people").select("id").is("deleted_at", null);
    if (sw.lastId) range = range.gt("id", sw.lastId);
    if (hi) range = range.lte("id", hi);
    const inRange = (must(await range.order("id").limit(5000), "sweep range") as { id: string }[]).map((r) => r.id);
    const seen = new Set(ids);
    const gone = inRange.filter((id) => !seen.has(id));
    if (gone.length && gone.length > Math.max(5, inRange.length * SWEEP_BREAKER)) {
      out.error = `the sweep would remove ${gone.length} of ${inRange.length} people in one page; stopped (check Twenty before resyncing)`;
      // Kept in the state so the team run raises it as an incident, and the sweep does not retry on its own.
      s.sweepError = out.error;
      await saveState(db, s);
      return;
    }
    if (gone.length) {
      must(await db.from("gtm_crm_people").update({ deleted_at: new Date().toISOString() }).in("id", gone), "sweep mark deleted");
      sw.removed += gone.length; out.removed += gone.length;
    }
    out.pages++;
    if (more) { sw.after = d.people.pageInfo.endCursor; sw.lastId = hi; await saveState(db, s); continue; }
    s.sweep = null;
    s.sweepError = null;
    out.done = true;
    await saveState(db, s);
    return;
  }
}

async function mirrorLiveBefore(db: SupabaseClient, cutoff: string): Promise<number> {
  const r = await db.from("gtm_crm_people").select("id", { count: "exact", head: true }).is("deleted_at", null).lt("created_at", cutoff);
  if (r.error) throw new Error(`mirror count: ${r.error.message}`);
  return r.count ?? 0;
}

const isDeadline = (e: unknown) => /run deadline/.test((e as Error)?.message ?? "");

/** One mirror run. Never throws for a Twenty problem: the state is saved page by page and the next run continues. */
export async function runMirror(db: SupabaseClient, reader: TwentyReader, opts: { now?: Date; health?: () => Promise<boolean> } = {}): Promise<MirrorRun> {
  const started = opts.now ?? new Date();
  const out: MirrorRun = { changes: { pages: 0, rows: 0, caughtUp: false, ties: 0 }, deletes: { pages: 0, rows: 0, caughtUp: false, ties: 0 } };
  // Saved before any read: a mirror whose every run fails still has a start time and an error to raise (review of #36, M4).
  const s = (await loadMirrorState(db)) ?? initialState(started);
  s.lastRunAt = started.toISOString();
  if (opts.health && !(await opts.health().catch(() => false))) {
    s.lastError = "Twenty /healthz did not answer 200; nothing was read";
    await saveState(db, s);
    return { ...out, skipped: s.lastError, failed: true };
  }
  await saveState(db, s);
  // Progress is pages read and written this run: each one moves a saved place (stream, tie or sweep cursor).
  const pagesRead = () => out.changes.pages + out.deletes.pages + (out.sweep?.pages ?? 0);
  try {
    await stream(db, reader, s, "changes", out.changes);
    await stream(db, reader, s, "deletes", out.deletes);
    s.caughtUpAt = new Date().toISOString();
    if (s.sweep && s.sweepError) {
      // Held by the breaker until an operator checks Twenty and clears it; the streams above still run.
      out.sweep = { pages: 0, removed: 0, done: false, error: s.sweepError };
    } else {
      if (s.sweep) {
        out.sweep = { pages: 0, removed: 0, done: false };
        await sweep(db, reader, s, out.sweep);
      }
      if (!s.sweep) {
        // Both streams are caught up: compare people created before a cutoff, so a create in flight cannot disagree.
        const cutoff = new Date(started.getTime() - COUNT_CUTOFF_MS).toISOString();
        const d = await reader.read<{ people: { totalCount: number } }>("query($f:PersonFilterInput){ people(filter:$f, first:1) { totalCount } }", { f: { createdAt: { lt: cutoff } } });
        const twenty = d.people.totalCount, mirror = await mirrorLiveBefore(db, cutoff);
        out.counts = { cutoff, twenty, mirror, match: twenty === mirror };
        s.twentyTotal = twenty; s.mirrorLive = mirror; s.countCutoff = cutoff; s.countsCheckedAt = new Date().toISOString();
        // Only the same difference on consecutive checks counts: a delete in flight shows once, then the deletes stream heals it.
        const diff = twenty - mirror;
        s.diffRuns = diff === 0 ? 0 : diff === s.diff ? s.diffRuns + 1 : 1;
        s.diff = diff;
        if (diff === 0) s.unresolvedDiff = null;
        if (s.diffRuns >= 2) {
          if (fresh(s.lastResyncAt, Date.now(), 24 * 3_600_000)) {
            // The difference survived a resync: another one would not fix it. Say so, retry at most once a day.
            s.unresolvedDiff = diff;
          } else {
            // A difference that persisted: re-read every person (upserts clear a stale deleted_at) and sweep ids.
            out.resync = true;
            s.diff = 0; s.diffRuns = 0;
            s.lastResyncAt = new Date().toISOString();
            s.changes = { ...stream0(EPOCH), passEndedAt: null };
            s.sweep = { after: null, lastId: null, removed: 0 };
          }
        }
      }
    }
    s.lastOkAt = new Date().toISOString();
    s.lastError = null;
    await saveState(db, s);
  } catch (e) {
    out.stopped = (e as Error).message.slice(0, 200);
    if (isDeadline(e) && pagesRead() > 0) {
      // Stopped by its own deadline after moving its saved place: progress, not a failure (the next run carries on).
      s.lastOkAt = new Date().toISOString();
      s.lastError = null;
    } else if (isDeadline(e)) {
      // A whole run without moving its saved place is no progress (review r2, R1): count it as a failure.
      out.failed = true;
      s.lastError = "a whole run ended at its deadline without moving the mirror's saved place";
    } else {
      out.failed = true;
      s.lastError = out.stopped;
    }
    await saveState(db, s).catch(() => undefined);
  }
  return out;
}
