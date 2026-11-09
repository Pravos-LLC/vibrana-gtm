// The CRM people mirror (VIB-516): every Twenty person, ids, dates and status flags only, copied into
// gtm_crm_people so the cockpit works on the whole CRM without re-reading Twenty every hour.
//
// Production Twenty is one small Postgres that saturated under repeated people reads on 2026-10-01
// (vibrana-crm docs/operations.md), so this job is gentle:
// - it runs hourly at :05, under its own lease, and skips the run when Twenty's /healthz is not 200;
// - it reads through TwentyReader (one request at a time, 1.5 s apart, backoff on 429/5xx, a hard deadline);
// - it reads only what changed: people whose updatedAt is at or after its cursor, then people soft-deleted since the
//   last run. Each page is written, then the resume point is saved, so a run that stops at its deadline carries on next
//   hour from the next page. The first run is the backfill (about 140 pages for 14k people, one or two runs).
// - erasures (a row destroyed, not soft-deleted) are invisible to both streams, so once the streams are caught up it
//   compares Twenty's own people count with the mirror's. If they disagree twice in a row it starts a resync: the
//   change stream again from the beginning plus an id sweep that marks rows Twenty no longer returns as deleted. The
//   sweep refuses to remove more than half of a page's range at once (a breaker, never a mass delete).
//
// Twenty's cursor under an updatedAt sort is a stateless {updatedAt, id} key that stays valid across runs, and it hands
// back the boundary row again on the next page (measured on production 2026-11-09); rows are upserted by id, so a
// repeat is harmless.
import type { SupabaseClient } from "@supabase/supabase-js";
import { must } from "../db";
import type { TwentyReader } from "../twenty";

export const MIRROR_KEY = "crm.people.mirror";
export const MIRROR_LEASE = "crm.mirror";
const EPOCH = "1970-01-01T00:00:00.000Z";
const PAGE = 100;
/** A sweep page may remove at most this share of the mirror rows in its id range. */
const SWEEP_BREAKER = 0.5;
/** The team page treats the mirror as stale (people "not measured") after this long without a completed run. */
export const STALE_MS = 6 * 3_600_000;

const FIELDS = "id createdAt updatedAt deletedAt createdBy { source name workspaceMemberId } emails { primaryEmail } revEmailVerification prospectNotSendable companyId lastContactedAt";

type Node = {
  id: string; createdAt: string; updatedAt: string; deletedAt: string | null;
  createdBy: { source: string | null; name: string | null; workspaceMemberId: string | null } | null;
  emails: { primaryEmail: string | null } | null; revEmailVerification: string | null; prospectNotSendable: string | null;
  companyId: string | null; lastContactedAt: string | null;
};
type Page = { pageInfo: { hasNextPage: boolean; endCursor: string | null }; edges: { node: Node }[] };

export type Stream = { since: string; after: string | null; maxSeen: string | null };
export type MirrorState = {
  changes: Stream;
  deletes: Stream;
  /** True once the change stream has read every person at least once. */
  backfillDone: boolean;
  /** When a run last finished with both streams caught up. */
  lastOkAt: string | null;
  /** The last count check: Twenty's people total and the mirror's live rows at that moment. */
  twentyTotal: number | null;
  mirrorLive: number | null;
  countsCheckedAt: string | null;
  /** Consecutive count checks that disagreed. Two in a row start a resync. */
  mismatches: number;
  /** An id sweep in progress (after a resync starts), with its cursor and the last id it covered. */
  sweep: { after: string | null; lastId: string | null; removed: number } | null;
};

export const initialState = (): MirrorState => ({
  changes: { since: EPOCH, after: null, maxSeen: null },
  deletes: { since: new Date().toISOString(), after: null, maxSeen: null },
  backfillDone: false, lastOkAt: null, twentyTotal: null, mirrorLive: null, countsCheckedAt: null, mismatches: 0, sweep: null,
});

export async function loadMirrorState(db: SupabaseClient): Promise<MirrorState | null> {
  const { data, error } = await db.from("gtm_sync_state").select("value").eq("key", MIRROR_KEY).maybeSingle();
  if (error) throw new Error(`mirror state: ${error.message}`);
  return (data?.value as MirrorState | undefined) ?? null;
}

async function saveState(db: SupabaseClient, s: MirrorState) {
  const now = new Date().toISOString();
  must(await db.from("gtm_sync_state").upsert({ key: MIRROR_KEY, value: s, updated_at: now }, { onConflict: "key" }), "save mirror state");
}

/** Whether the team page may count people from the mirror, and if not, why. */
export function mirrorReadiness(s: MirrorState | null, now = Date.now()): { ready: boolean; reason: string | null } {
  if (!s || !s.backfillDone) return { ready: false, reason: "the CRM mirror is still copying the CRM; people are counted once it finishes" };
  const ok = Date.parse(s.lastOkAt ?? "");
  if (!Number.isFinite(ok) || now - ok > STALE_MS) return { ready: false, reason: "the CRM mirror has not completed a sync in the last 6 hours" };
  return { ready: true, reason: null };
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

export type MirrorRun = {
  skipped?: string;
  changes: { pages: number; rows: number; caughtUp: boolean };
  deletes: { pages: number; rows: number; caughtUp: boolean };
  counts?: { twenty: number; mirror: number; match: boolean };
  sweep?: { pages: number; removed: number; done: boolean; error?: string };
  resync?: boolean;
  stopped?: string;
};

/** One stream, page by page, until it is caught up or the reader's deadline stops it. State is saved after every page. */
async function stream(db: SupabaseClient, reader: TwentyReader, s: MirrorState, which: "changes" | "deletes", out: MirrorRun["changes"]) {
  const st = s[which];
  const field = which === "changes" ? "updatedAt" : "deletedAt";
  const q = `query($f:PersonFilterInput,$a:String){ people(filter:$f, first:${PAGE}, after:$a, orderBy:[{${field}:AscNullsFirst},{id:AscNullsFirst}]) { pageInfo { hasNextPage endCursor } edges { node { ${FIELDS} } } } }`;
  const filter = { [field]: { gte: st.since } };
  for (;;) {
    const d = await reader.read<{ people: Page }>(q, { f: filter, a: st.after });
    const now = new Date().toISOString();
    const nodes = d.people.edges.map((e) => e.node);
    if (nodes.length) {
      // Deduplicate within the page (the boundary row can repeat across pages; upsert handles that).
      const rows = [...new Map(nodes.map((n) => [n.id, toRow(n, now)])).values()];
      must(await db.from("gtm_crm_people").upsert(rows, { onConflict: "id" }), `mirror ${which} page`);
      out.rows += rows.length;
      for (const n of nodes) st.maxSeen = later(st.maxSeen, which === "changes" ? n.updatedAt : n.deletedAt);
    }
    out.pages++;
    const more = d.people.pageInfo.hasNextPage && !!d.people.pageInfo.endCursor;
    if (more) st.after = d.people.pageInfo.endCursor;
    else {
      st.since = st.maxSeen ?? st.since;
      st.after = null;
      st.maxSeen = null;
      if (which === "changes") s.backfillDone = true;
    }
    await saveState(db, s);
    if (!more) { out.caughtUp = true; return; }
  }
}

async function mirrorLive(db: SupabaseClient): Promise<number> {
  const r = await db.from("gtm_crm_people").select("id", { count: "exact", head: true }).is("deleted_at", null);
  if (r.error) throw new Error(`mirror count: ${r.error.message}`);
  return r.count ?? 0;
}

/**
 * The id sweep: Twenty's ids in order, a page at a time; any live mirror row whose id falls inside the page's range but
 * is not on the page has been destroyed in Twenty and is marked deleted. Ordered by uuid on both sides.
 */
async function sweep(db: SupabaseClient, reader: TwentyReader, s: MirrorState, out: NonNullable<MirrorRun["sweep"]>) {
  const sw = s.sweep!;
  const q = `query($a:String){ people(first:${PAGE}, after:$a, orderBy:[{id:AscNullsFirst}]) { pageInfo { hasNextPage endCursor } edges { node { id } } } }`;
  for (;;) {
    const d = await reader.read<{ people: { pageInfo: Page["pageInfo"]; edges: { node: { id: string } }[] } }>(q, { a: sw.after });
    const ids = d.people.edges.map((e) => e.node.id);
    const more = d.people.pageInfo.hasNextPage && !!d.people.pageInfo.endCursor;
    const hi = more ? ids[ids.length - 1] ?? null : null;
    let range = db.from("gtm_crm_people").select("id").is("deleted_at", null);
    if (sw.lastId) range = range.gt("id", sw.lastId);
    if (hi) range = range.lte("id", hi);
    const inRange = (must(await range.limit(5000), "sweep range") as { id: string }[]).map((r) => r.id);
    const seen = new Set(ids);
    const gone = inRange.filter((id) => !seen.has(id));
    if (gone.length && gone.length > Math.max(5, inRange.length * SWEEP_BREAKER)) {
      out.error = `the sweep would remove ${gone.length} of ${inRange.length} people in one page; stopped (check Twenty before resyncing)`;
      return;
    }
    if (gone.length) {
      must(await db.from("gtm_crm_people").update({ deleted_at: new Date().toISOString() }).in("id", gone), "sweep mark deleted");
      sw.removed += gone.length; out.removed += gone.length;
    }
    out.pages++;
    if (more) { sw.after = d.people.pageInfo.endCursor; sw.lastId = hi; await saveState(db, s); continue; }
    s.sweep = null;
    out.done = true;
    await saveState(db, s);
    return;
  }
}

/** One mirror run. Never throws for a Twenty problem: the state is saved page by page and the next run continues. */
export async function runMirror(db: SupabaseClient, reader: TwentyReader, opts: { now?: Date; health?: () => Promise<boolean> } = {}): Promise<MirrorRun> {
  const out: MirrorRun = { changes: { pages: 0, rows: 0, caughtUp: false }, deletes: { pages: 0, rows: 0, caughtUp: false } };
  if (opts.health && !(await opts.health().catch(() => false))) return { ...out, skipped: "Twenty /healthz did not answer 200; nothing was read" };
  const s = (await loadMirrorState(db)) ?? initialState();
  try {
    await stream(db, reader, s, "changes", out.changes);
    await stream(db, reader, s, "deletes", out.deletes);
    if (s.sweep) {
      out.sweep = { pages: 0, removed: 0, done: false };
      await sweep(db, reader, s, out.sweep);
      if (!out.sweep.done) return out;
    }
    // Both streams are caught up: compare totals (Twenty's own count excludes soft-deleted people, as the mirror's does).
    const d = await reader.read<{ people: { totalCount: number } }>("query{ people(first:1) { totalCount } }");
    const twenty = d.people.totalCount, mirror = await mirrorLive(db);
    out.counts = { twenty, mirror, match: twenty === mirror };
    s.twentyTotal = twenty; s.mirrorLive = mirror; s.countsCheckedAt = new Date().toISOString();
    s.mismatches = out.counts.match ? 0 : s.mismatches + 1;
    s.lastOkAt = (opts.now ?? new Date()).toISOString();
    if (s.mismatches >= 2 && !s.sweep) {
      // A difference that survived a whole hour: re-read every person (upserts clear a stale deleted_at) and sweep ids.
      out.resync = true;
      s.mismatches = 0;
      s.changes = { since: EPOCH, after: null, maxSeen: null };
      s.sweep = { after: null, lastId: null, removed: 0 };
    }
    await saveState(db, s);
  } catch (e) {
    out.stopped = (e as Error).message.slice(0, 200);
  }
  return out;
}
