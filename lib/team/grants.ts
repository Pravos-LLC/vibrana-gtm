// Whether a Google grant on the shared OAuth client (TEAM_GMAIL_CLIENT_ID) is still in use.
//
// One client serves three connections: team mailboxes (gtm_team_mailboxes), calendars (gtm_team_calendars, VIB-518) and
// the network desk's mailbox (gtm_network_mailbox, VIB-522). Google revokes per account and client, not per token, so
// revoking any token of an address kills every connection made with that address. A grant is revoked only when no
// connection uses the address. A failed lookup counts as in use: when unsure, keep the grant rather than risk killing a
// live connection.
import type { SupabaseClient } from "@supabase/supabase-js";

export const GRANT_TABLES = ["gtm_team_mailboxes", "gtm_team_calendars", "gtm_network_mailbox"] as const;
export type GrantTable = (typeof GRANT_TABLES)[number];

/**
 * True when any connection uses the address, or a lookup failed. `except` leaves out the connection being removed: one
 * member's rows in a member-keyed table, or the whole network mailbox table (it holds one row).
 */
export async function grantInUse(db: SupabaseClient, address: string, except?: { table: GrantTable; member?: string }): Promise<boolean> {
  const a = address.trim().toLowerCase();
  const reads = GRANT_TABLES.filter((t) => !(except && except.table === t && (t === "gtm_network_mailbox" || !except.member))).map((t) => {
    let q = db.from(t).select("address").eq("address", a);
    if (except?.table === t && except.member) q = q.neq("member", except.member);
    return q.limit(1);
  });
  const results = await Promise.all(reads);
  return results.some((r) => !!r.error || !!r.data?.length);
}
