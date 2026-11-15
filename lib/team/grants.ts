// Whether a Google grant on the shared OAuth client (TEAM_GMAIL_CLIENT_ID) is still in use, and the lock every grant
// change takes.
//
// One client serves three stored connections: team mailboxes (gtm_team_mailboxes), calendars (gtm_team_calendars,
// VIB-518) and the network desk's mailbox (gtm_network_mailbox, VIB-522). Deployment settings can hold more grants on the
// same client: the HQ reader (OUTREACH_GMAIL_*) and the network mailbox override (NETWORK_GMAIL_*). Google revokes per
// account and client, not per token, so revoking any token of an address kills every grant made with that address on that
// client. A grant is revoked only when nothing uses the address. A failed lookup counts as in use: when unsure, keep the
// grant rather than risk killing a live connection.
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";
import { gmailConfig } from "./mailbox";
import { mailboxConfig, networkMailboxConfig } from "../outreach/mailbox";

export const GRANT_TABLES = ["gtm_team_mailboxes", "gtm_team_calendars", "gtm_network_mailbox"] as const;
export type GrantTable = (typeof GRANT_TABLES)[number];
type Env = Record<string, string | undefined>;

/**
 * True when a deployment setting holds a grant for the address on the client being revoked (TEAM_GMAIL_CLIENT_ID). A
 * setting on another OAuth client is another grant, which a revoke on this client cannot touch.
 */
export function envGrantInUse(address: string, env: Env = process.env): boolean {
  const a = address.trim().toLowerCase();
  const client = gmailConfig(env)?.clientId;
  let configs;
  try { configs = [mailboxConfig(env), networkMailboxConfig(env)]; } catch { return true; }
  return configs.some((c) => !!c && c.email.trim().toLowerCase() === a && (!client || c.clientId.trim() === client));
}

/**
 * True when any connection uses the address, or a lookup failed. `except` leaves out the connection being removed: one
 * member's rows in a member-keyed table, or the whole network mailbox table (it holds one row).
 */
export async function grantInUse(db: SupabaseClient, address: string, except?: { table: GrantTable; member?: string }, env: Env = process.env): Promise<boolean> {
  const a = address.trim().toLowerCase();
  if (envGrantInUse(a, env)) return true;
  const reads = GRANT_TABLES.filter((t) => !(except && except.table === t && (t === "gtm_network_mailbox" || !except.member))).map((t) => {
    let q = db.from(t).select("address").eq("address", a);
    if (except?.table === t && except.member) q = q.neq("member", except.member);
    return q.limit(1);
  });
  const results = await Promise.all(reads);
  return results.some((r) => !!r.error || !!r.data?.length);
}

/** The lease every grant change takes: a save (code exchange through the stored row) or a disconnect (read, revoke, delete). */
export const GRANT_LOCK = "google.grants";

/**
 * Runs one grant change at a time across requests, so a revoke can never land between another request's code exchange and
 * its save (which would kill the grant just issued), and a disconnect never deletes a connection saved meanwhile. When the
 * lock is held, or cannot be taken, nothing runs and `busy` is returned: the person starts again.
 */
export async function withGrantLock<T>(db: SupabaseClient, busy: T, fn: () => Promise<T>): Promise<T> {
  const holder = `grant-${Date.now()}-${randomBytes(6).toString("hex")}`;
  const { data, error } = await db.rpc("gtm_take_lease", { p_job: GRANT_LOCK, p_holder: holder, p_seconds: 120 });
  if (error || data !== true) return busy;
  try { return await fn(); } finally { await db.rpc("gtm_release_lease", { p_job: GRANT_LOCK, p_holder: holder }); }
}
