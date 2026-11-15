// Whether a Google grant for an account is still in use before the cockpit revokes one, and the lock every grant change
// takes.
//
// One client serves three stored connections: team mailboxes (gtm_team_mailboxes), calendars (gtm_team_calendars,
// VIB-518) and the network desk's mailbox (gtm_network_mailbox, VIB-522). Deployment settings can hold more grants on the
// account: the HQ reader (OUTREACH_GMAIL_*) and the network mailbox override (NETWORK_GMAIL_*). Google revokes per
// account, not per token, and for every client in the same Cloud project, so revoking any token of an address can kill
// every grant made with that address. A grant is revoked only when nothing uses the address. A failed lookup counts as
// in use: when unsure, keep the grant rather than risk killing a live connection.
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";
import { revokeToken } from "./mailbox";
import { mailboxConfig, networkMailboxConfig } from "../outreach/mailbox";

export const GRANT_TABLES = ["gtm_team_mailboxes", "gtm_team_calendars", "gtm_network_mailbox"] as const;
export type GrantTable = (typeof GRANT_TABLES)[number];
type Env = Record<string, string | undefined>;

/**
 * True when a deployment setting holds a grant for the address: the HQ reader (OUTREACH_GMAIL_*) or the network override
 * (NETWORK_GMAIL_*). Whatever OAuth client it uses: Google's revocation invalidates the account's tokens for every client
 * registered in the same Google Cloud project, and nothing here can prove a setting's client lives in another project, so
 * the same account always counts as in use. A grant that names no account counts unless its client is in another project.
 */
export function envGrantInUse(address: string, env: Env = process.env): boolean {
  const a = address.trim().toLowerCase();
  let configs;
  try { configs = [mailboxConfig(env), networkMailboxConfig(env)]; } catch { return true; }
  if (configs.some((c) => !!c && c.email.trim().toLowerCase() === a)) return true;
  // The YouTube Analytics grant (YOUTUBE_*) names no account, so it may be this one. It is safe only when its OAuth client
  // is provably in another Cloud project than the client being revoked (TEAM_GMAIL_CLIENT_ID).
  if (env.YOUTUBE_REFRESH_TOKEN?.trim() && env.YOUTUBE_CLIENT_ID?.trim()) {
    const ours = cloudProject(env.TEAM_GMAIL_CLIENT_ID), theirs = cloudProject(env.YOUTUBE_CLIENT_ID);
    if (!ours || !theirs || ours === theirs) return true;
  }
  return false;
}

/** The Cloud project number a Google OAuth client id carries (`<project number>-<id>.apps.googleusercontent.com`), or null. */
export const cloudProject = (clientId: string | undefined) => /^(\d+)-[a-z0-9]+\.apps\.googleusercontent\.com$/.exec(clientId?.trim() ?? "")?.[1] ?? null;

/**
 * True when any connection uses the address, or a lookup failed (an aborted one included). `except` leaves out the
 * connection being removed: one member's rows in a member-keyed table, or the whole network mailbox table (it holds one row).
 */
export async function grantInUse(db: SupabaseClient, address: string, except?: { table: GrantTable; member?: string }, env: Env = process.env, signal?: AbortSignal): Promise<boolean> {
  const a = address.trim().toLowerCase();
  if (envGrantInUse(a, env)) return true;
  if (signal?.aborted) return true;
  const reads = GRANT_TABLES.filter((t) => !(except && except.table === t && (t === "gtm_network_mailbox" || !except.member))).map((t) => {
    let q = db.from(t).select("address").eq("address", a);
    if (except?.table === t && except.member) q = q.neq("member", except.member);
    q = q.limit(1);
    return signal ? q.abortSignal(signal) : q;
  });
  const results = await Promise.all(reads.map((r) => Promise.resolve(r).catch((e: unknown) => ({ data: null, error: e }))));
  return !!signal?.aborted || results.some((r) => !!r.error || !!r.data?.length);
}

/** The lease every grant change takes: a save (code exchange through the stored row) or a disconnect (read, revoke, delete). */
export const GRANT_LOCK = "google.grants";
export const GRANT_LEASE_SECONDS = 120;
/** How long the work inside the lock may run: half the lease, measured from before the lease is asked for, so every step
 *  that changes a grant starts well before another request could take an expired lease. */
export const GRANT_WORK_MS = 60_000;

/** The held lock: `signal` aborts the lock's database and Google requests when its time is up; `live()` says whether a step
 *  that changes something may still start. */
export type GrantLock = { signal: AbortSignal; live: () => boolean };

/**
 * Runs one grant change at a time across requests, so a revoke can never land between another request's code exchange and
 * its save (which would kill the grant just issued), and a disconnect never deletes a connection saved meanwhile. The work
 * is bounded: after GRANT_WORK_MS its requests are aborted and no further revoke, write or delete starts, so a slow request
 * can never act after its lease could have expired and passed to someone else. When the lock is held, or cannot be taken,
 * nothing runs and `busy` is returned: the person starts again.
 */
export async function withGrantLock<T>(db: SupabaseClient, busy: T, fn: (lock: GrantLock) => Promise<T>, workMs = GRANT_WORK_MS): Promise<T> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), workMs);
  const holder = `grant-${started}-${randomBytes(6).toString("hex")}`;
  try {
    const { data, error } = await db.rpc("gtm_take_lease", { p_job: GRANT_LOCK, p_holder: holder, p_seconds: GRANT_LEASE_SECONDS });
    if (error || data !== true) return busy;
    const lock: GrantLock = { signal: controller.signal, live: () => !controller.signal.aborted && Date.now() - started < workMs };
    try { return await fn(lock); } finally { await db.rpc("gtm_release_lease", { p_job: GRANT_LOCK, p_holder: holder }); }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/**
 * Revokes a token only when nothing uses its address and the lock is still live, checked after the lookup: a stale lookup
 * never leads to a revoke. Returns whether it revoked.
 */
export async function revokeIfUnused(db: SupabaseClient, lock: GrantLock, address: string, token: string, o: { except?: { table: GrantTable; member?: string }; fetcher?: typeof fetch } = {}): Promise<boolean> {
  if (await grantInUse(db, address, o.except, process.env, lock.signal)) return false;
  if (!lock.live()) return false;
  await revokeToken(token, o.fetcher, lock.signal);
  return true;
}
