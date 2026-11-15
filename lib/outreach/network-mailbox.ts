// The network desk's mailbox, connected from the cockpit (VIB-522). The network stream sends from a send-as alias, so its
// sent mail and replies sit in the Google account behind the alias. John connects that account once with "Connect network
// mailbox" on Pipeline > Conversations; the hourly pipeline job then reads replies and bounces to network desk emails
// (lib/sales/outcomes.ts).
//
// - The consent reuses the team connection machinery: the TEAM_GMAIL OAuth client, the shared registered redirect
//   (/api/team/mailbox/callback, state purpose "network"), the HMAC state with a nonce cookie, and PKCE.
// - Scopes: openid, email and gmail.readonly (a thread search needs more than gmail.metadata). A grant without
//   gmail.readonly is refused.
// - Only the expected account is accepted: NETWORK_GMAIL_ACCOUNT when set, otherwise the JOHN team member's login
//   (GTM_TEAM_MEMBERS). Both are deployment settings, so no real address is in this public repository.
// - The sealed refresh token goes to gtm_network_mailbox, never gtm_team_mailboxes: the team email sync must not count this
//   personal mailbox as a team member's work mailbox.
// - Google revokes per account and client: a grant is revoked only when nothing uses the address, stored or in deployment
//   settings, and every grant change holds one lock (lib/team/grants.ts).
// - NETWORK_GMAIL_* deployment settings, when all four are set, win over the stored connection.
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertLiveProvidersAllowed, providerFetch } from "../demo-safety";
import { gmailConfig, READONLY_SCOPE, type GmailConfig } from "../team/mailbox";
import { openToken, sealToken } from "../team/crypto";
import { revokeIfUnused, withGrantLock, type GrantLock } from "../team/grants";
import { teamMembers, type TeamMember } from "../team/members";
import { addresses, MailboxRenewError, networkMailboxConfig, type MailboxConfig } from "./mailbox";

type Env = Record<string, string | undefined>;

export const NETWORK_TABLE = "gtm_network_mailbox";
/** The team member who owns the network desk, and the only one who may connect its mailbox. */
export const NETWORK_OWNER = "JOHN";
/** Where the connection is made and where the callback returns, with `?network=<status>`. */
export const NETWORK_PAGE = "/pipeline/conversations";
export const networkScopes = () => ["openid", "email", READONLY_SCOPE];
export const networkAad = (address: string) => `network:${address.toLowerCase()}`;

export const NETWORK_NOT_CONNECTED = "the network mailbox is not connected (Connect network mailbox on Pipeline > Conversations, or set NETWORK_GMAIL_*)";
export const NETWORK_RECONNECT = "the network mailbox needs reconnecting: Google no longer accepts the stored connection (Reconnect network mailbox on Pipeline > Conversations)";

const oneAddress = (v: string | null | undefined) => {
  const a = v?.trim().toLowerCase();
  return a && addresses(a).length === 1 && addresses(a)[0] === a ? a : null;
};

/**
 * The account the network mailbox must be: NETWORK_GMAIL_ACCOUNT when set (a malformed value is null, never a fallback),
 * otherwise the JOHN team member's login. Null when neither is configured.
 */
export function networkAccount(env: Env = process.env, members?: TeamMember[]): string | null {
  if (env.NETWORK_GMAIL_ACCOUNT?.trim()) return oneAddress(env.NETWORK_GMAIL_ACCOUNT);
  let list = members;
  try { list ??= teamMembers(env); } catch { return null; }
  return oneAddress(list.find((m) => m.code === NETWORK_OWNER)?.authEmail);
}

/* ------------------------------------------------------------------------------------------------ consent */

type Grant = { refreshToken: string; email: string; scopes: string[] };

/** Trades the code for tokens. The address comes from the id_token on this direct TLS call; the scopes from Google's answer. */
export async function exchangeNetworkCode(cfg: GmailConfig, code: string, verifier: string, redirectUri: string, fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<Grant> {
  assertLiveProvidersAllowed();
  const res = await providerFetch(fetcher)("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, cache: "no-store", signal: signal ? AbortSignal.any([AbortSignal.timeout(15_000), signal]) : AbortSignal.timeout(15_000),
    body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, code, code_verifier: verifier, redirect_uri: redirectUri, grant_type: "authorization_code" }),
  });
  const body = await res.json().catch(() => ({})) as { refresh_token?: string; id_token?: string; scope?: string };
  if (!res.ok || !body.refresh_token || !body.id_token) throw new Error("Google did not grant offline access.");
  const claims = JSON.parse(Buffer.from(body.id_token.split(".")[1] ?? "", "base64url").toString("utf8")) as { email?: string; email_verified?: boolean };
  if (!claims.email || claims.email_verified !== true) throw new Error("Google did not confirm the mailbox address.");
  return { refreshToken: body.refresh_token, email: claims.email.toLowerCase(), scopes: (body.scope ?? "").split(" ").filter(Boolean) };
}

export type SaveStatus = "connected" | "wrong-account" | "scope-missing" | "google-refused" | "save-failed" | "no-account" | "busy";

/**
 * Finishes the consent for the signed-in network owner: the grant is kept only when Google's confirmed address is the
 * expected account and gmail.readonly was granted. A refused grant is revoked only when no connection uses the address.
 * A reconnect replaces the stored row and never revokes the previous token (Google would revoke the new one with it).
 * The whole change, from the code exchange to the stored row, holds the grant lock (lib/team/grants.ts), and stops when
 * its time is up: no write or revoke starts after that. `lockMs` shortens that time in tests.
 */
export async function saveNetworkGrant(db: SupabaseClient, cfg: GmailConfig, o: { code: string; verifier: string; redirectUri: string; member: string; expected: string | null; fetcher?: typeof fetch; now?: Date; lockMs?: number }): Promise<SaveStatus> {
  const expected = oneAddress(o.expected);
  if (!expected) return "no-account";
  return withGrantLock<SaveStatus>(db, "busy", (lock) => saveLocked(db, cfg, o, expected, lock), o.lockMs);
}

async function saveLocked(db: SupabaseClient, cfg: GmailConfig, o: { code: string; verifier: string; redirectUri: string; member: string; fetcher?: typeof fetch; now?: Date }, expected: string, lock: GrantLock): Promise<SaveStatus> {
  let g: Grant;
  try { g = await exchangeNetworkCode(cfg, o.code, o.verifier, o.redirectUri, o.fetcher, lock.signal); } catch { return "google-refused"; }
  // A refused grant is revoked only when nothing uses the address and the lock is still live after the lookup.
  const refuse = async (status: SaveStatus) => {
    await revokeIfUnused(db, lock, g.email, g.refreshToken, { fetcher: o.fetcher });
    return status;
  };
  if (g.email !== expected) return refuse("wrong-account");
  if (!g.scopes.includes(READONLY_SCOPE)) return refuse("scope-missing");
  // Out of time: keep the grant (it may be the account's live grant) and store nothing.
  if (!lock.live()) return "busy";
  const at = (o.now ?? new Date()).toISOString();
  const { error } = await db.from(NETWORK_TABLE).upsert({
    id: 1, address: g.email, token_ciphertext: sealToken(g.refreshToken, networkAad(g.email)), key_version: 1,
    granted_scopes: g.scopes.filter((s) => s.startsWith("https://www.googleapis.com/auth/gmail.")), connected_by: o.member,
    connected_at: at, last_sync_at: null, last_error: null, reconnect_needed_at: null,
  }, { onConflict: "id" }).abortSignal(lock.signal);
  if (error) return refuse("save-failed");
  return "connected";
}

type DisconnectStatus = "disconnected" | "disconnect-failed" | "not-connected" | "busy";

/**
 * Deletes the stored connection; revokes it at Google only when nothing else uses the address. Holds the grant lock, so a
 * reconnect cannot be saved between the read and the delete, and deletes only the connection it read (its connected_at).
 */
export async function disconnectNetwork(db: SupabaseClient, fetcher: typeof fetch = fetch, lockMs?: number): Promise<DisconnectStatus> {
  return withGrantLock<DisconnectStatus>(db, "busy", async (lock) => {
    const { data, error } = await db.from(NETWORK_TABLE).select("address,token_ciphertext,connected_at").eq("id", 1).abortSignal(lock.signal).maybeSingle();
    if (error) return "disconnect-failed";
    if (!data) return "not-connected";
    const row = data as { address: string; token_ciphertext: string; connected_at: string };
    let token: string | null = null;
    try { token = openToken(row.token_ciphertext, networkAad(row.address)); } catch { /* deleted below either way */ }
    if (token) await revokeIfUnused(db, lock, row.address, token, { except: { table: "gtm_network_mailbox" }, fetcher });
    if (!lock.live()) return "busy";
    const del = await db.from(NETWORK_TABLE).delete().eq("id", 1).eq("connected_at", row.connected_at).abortSignal(lock.signal).select("id");
    return del.error || !del.data?.length ? "disconnect-failed" : "disconnected";
  }, lockMs);
}

/* ------------------------------------------------------------------------------------------------ reading */

export type StoredNetwork = { address: string; connectedAt: string };
export type NetworkSource = { cfg: MailboxConfig; stored: StoredNetwork | null } | { skipped: string };
type Row = { address: string; token_ciphertext: string; granted_scopes: string[] | null; connected_at: string; reconnect_needed_at: string | null };

/**
 * The network mailbox the outcome sync reads: NETWORK_GMAIL_* when all four are set, else the stored connection, unsealed
 * with TEAM_MAILBOX_KEY and refreshed through the TEAM_GMAIL client. A connection that needs a reconnect, lacks
 * gmail.readonly, or is not the expected account is skipped with a reason; a failed read of the table throws.
 */
export async function networkMailbox(db: SupabaseClient, env: Env = process.env): Promise<NetworkSource> {
  const fromEnv = networkMailboxConfig(env);
  if (fromEnv) return { cfg: fromEnv, stored: null };
  if (process.env.DEMO_MODE === "1" || env.DEMO_MODE === "1") return { skipped: NETWORK_NOT_CONNECTED };
  const { data, error } = await db.from(NETWORK_TABLE).select("address,token_ciphertext,granted_scopes,connected_at,reconnect_needed_at").eq("id", 1).maybeSingle();
  if (error) throw new Error(`network mailbox: ${error.message}`);
  if (!data) return { skipped: NETWORK_NOT_CONNECTED };
  const row = data as Row;
  if (row.reconnect_needed_at) return { skipped: NETWORK_RECONNECT };
  const client = gmailConfig(env);
  if (!client) return { skipped: "the network mailbox is connected, but TEAM_GMAIL_CLIENT_ID / TEAM_GMAIL_CLIENT_SECRET are not set" };
  const expected = networkAccount(env);
  if (!expected) return { skipped: "the network account is not configured (NETWORK_GMAIL_ACCOUNT, or the JOHN entry in GTM_TEAM_MEMBERS)" };
  if (row.address !== expected) return { skipped: "the network mailbox is connected as another account than the configured one; reconnect it on Pipeline > Conversations" };
  const stored = { address: row.address, connectedAt: row.connected_at };
  if (!(row.granted_scopes ?? []).includes(READONLY_SCOPE)) {
    await markNetwork(db, stored, { reconnect_needed_at: new Date().toISOString(), last_error: "The connection lacks Gmail read access. Reconnect it." });
    return { skipped: NETWORK_RECONNECT };
  }
  let refreshToken: string;
  try { refreshToken = openToken(row.token_ciphertext, networkAad(row.address)); } catch {
    await markNetwork(db, stored, { reconnect_needed_at: new Date().toISOString(), last_error: "The stored connection could not be opened (the mailbox key changed). Reconnect it." });
    return { skipped: NETWORK_RECONNECT };
  }
  return { cfg: { email: row.address, clientId: client.clientId, clientSecret: client.clientSecret, refreshToken }, stored };
}

type Mark = { reconnect_needed_at?: string; last_error?: string | null; last_sync_at?: string };

/** Updates the status of exactly the connection that was read: a reconnect made meanwhile is never marked. */
export async function markNetwork(db: SupabaseClient, stored: StoredNetwork, patch: Mark) {
  const { error } = await db.from(NETWORK_TABLE).update(patch).eq("id", 1).eq("address", stored.address).eq("connected_at", stored.connectedAt);
  if (error) throw new Error(`network mailbox status: ${error.message}`);
}

/** After a run of the stored connection: a refused token marks it for a reconnect; any other failure is its last error. */
export async function markNetworkFailure(db: SupabaseClient, stored: StoredNetwork, e: unknown, now = new Date()) {
  const renew = e instanceof MailboxRenewError;
  const message = renew ? "Google no longer accepts the stored connection. Reconnect the network mailbox." : (e instanceof Error ? e.message : String(e));
  await markNetwork(db, stored, { ...(renew ? { reconnect_needed_at: now.toISOString() } : {}), last_error: message.slice(0, 500) });
  return renew;
}

/* ------------------------------------------------------------------------------------------------ page */

export type NetworkStatus =
  | { source: "env" }
  | { source: "none" }
  | { source: "stored"; address: string; connectedAt: string; lastSyncAt: string | null; lastError: string | null; reconnect: boolean; expectedMismatch: boolean }
  | { source: "error"; message: string };

/** What Pipeline > Conversations shows about the network mailbox. Service-role read: call only for the signed-in owner. */
export async function networkStatus(db: SupabaseClient, env: Env = process.env): Promise<NetworkStatus> {
  if (networkMailboxConfig(env)) return { source: "env" };
  const { data, error } = await db.from(NETWORK_TABLE).select("address,granted_scopes,connected_at,last_sync_at,last_error,reconnect_needed_at").eq("id", 1).maybeSingle();
  if (error) return { source: "error", message: "The network mailbox connection could not be read." };
  if (!data) return { source: "none" };
  const r = data as Row & { last_sync_at: string | null; last_error: string | null };
  const expected = networkAccount(env);
  return { source: "stored", address: r.address, connectedAt: r.connected_at, lastSyncAt: r.last_sync_at, lastError: r.last_error,
    reconnect: !!r.reconnect_needed_at || !(r.granted_scopes ?? []).includes(READONLY_SCOPE), expectedMismatch: !!expected && expected !== r.address };
}
