import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { adminDb } from "@/lib/db";
import { exchangeCode, gmailConfig, mailboxAad, stateKey } from "@/lib/team/mailbox";
import { calendarAad, exchangeCalendarCode } from "@/lib/team/calendar";
import { sealToken, verifyState } from "@/lib/team/crypto";
import { NONCE_COOKIE, VERIFIER_COOKIE, clearFlowCookies, origin, redirectUri, viewer } from "@/lib/team/connect";
import { revokeIfUnused, withGrantLock, type GrantLock } from "@/lib/team/grants";
import type { TeamMember } from "@/lib/team/members";
import { NETWORK_OWNER, NETWORK_PAGE, networkAccount, saveNetworkGrant } from "@/lib/outreach/network-mailbox";

// Google's redirect after the member consents. API routes skip the proxy, so this route checks everything itself:
// the signed-in owner, the HMAC state bound to that user and member, the nonce cookie, PKCE, and that Google's
// confirmed address is one of the member's configured mailboxes. Any failure redirects with a fixed reason code.
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  // The calendar flow (VIB-518) and the network mailbox flow (VIB-522) share this registered redirect; the signed state says
  // which one it is, and each returns to its own page.
  let page = "/team/mailbox?status=";
  const pageFor = (purpose: string | undefined) => {
    if (purpose === "calendar") page = "/pipeline/meetings?calendar=";
    if (purpose === "network") page = `${NETWORK_PAGE}?network=`;
  };
  const back = async (status: string) => {
    await clearFlowCookies();
    return NextResponse.redirect(`${await origin()}${page}${status}`, { status: 303 });
  };
  const url = new URL(request.url);
  if (url.searchParams.get("error")) {
    // Google returns the state on a refusal too: a verified one says which page the member came from.
    const st = verifyState(url.searchParams.get("state") ?? "", (await cookies()).get(NONCE_COOKIE)?.value);
    pageFor(st?.purpose);
    return back("declined");
  }
  const code = url.searchParams.get("code"), state = url.searchParams.get("state");
  if (!code || !state || code.length > 2048 || state.length > 2048) return back("invalid");
  const jar = await cookies();
  const s = verifyState(state, jar.get(NONCE_COOKIE)?.value);
  const verifier = jar.get(VERIFIER_COOKIE)?.value;
  if (!s || !verifier) return back("expired");
  pageFor(s.purpose);
  const v = await viewer();
  if (!v || v.sub !== s.sub || !v.member || v.member.code !== s.member) return back("wrong-user");
  const member = v.member;
  const cfg = gmailConfig();
  if (!cfg) return back("not-configured");
  // Every grant change holds one lock (lib/team/grants.ts): a revoke elsewhere can never land between this exchange and its save.
  if (s.purpose === "calendar") return back(await withGrantLock(adminDb(), "busy", (lock) => saveCalendar(cfg, code, verifier, member.code, lock)));
  // The network desk's mailbox: only its owner connects it, and only as the expected account (lib/outreach/network-mailbox.ts).
  if (s.purpose === "network") {
    if (member.code !== NETWORK_OWNER) return back("not-owner");
    return back(await saveNetworkGrant(adminDb(), cfg, { code, verifier, redirectUri: await redirectUri(), member: member.code, expected: networkAccount() }));
  }
  return back(await withGrantLock(adminDb(), "busy", (lock) => saveMailbox(cfg, code, verifier, member, lock)));
}

/** The member's own team mailbox: Google's confirmed address must be one of the member's configured mailboxes. */
async function saveMailbox(cfg: NonNullable<ReturnType<typeof gmailConfig>>, code: string, verifier: string, member: TeamMember, lock: GrantLock): Promise<string> {
  let granted: Awaited<ReturnType<typeof exchangeCode>>;
  try { granted = await exchangeCode(cfg, code, verifier, await redirectUri()); } catch { return "google-refused"; }
  // Google revokes per account and client, not per token: revoking would also kill a live connection of that address
  // (another member's mailbox, or this one's own reconnect). Only a grant nobody uses is revoked (review of #23, N-f).
  // A failed lookup counts as "in use". The calendar (VIB-518) and network mailbox (VIB-522) connections use the same
  // client, so their grants for this address count too, and no revoke starts once the lock's time is up (lib/team/grants.ts).
  const db = adminDb();
  const revoke = () => revokeIfUnused(db, lock, granted.email, granted.refreshToken);
  if (!member.mailboxes.includes(granted.email)) {
    await revoke();
    return "wrong-mailbox";
  }
  if (!lock.live()) return "busy";
  // A reconnect simply replaces the stored token. The old one is never revoked here: Google revokes the whole grant for
  // the account and client, which would kill the token just issued (review of #23, NB1).
  const { error } = await db.from("gtm_team_mailboxes").upsert({
    member: member.code, address: granted.email, token_ciphertext: sealToken(granted.refreshToken, mailboxAad(member.code, granted.email)),
    key_version: 1, history_id: null, backfill_done: false, connected_at: new Date().toISOString(), last_sync_at: null, last_error: null,
    // What Google granted, read from its answer: body-dependent work checks this, never the scope the code asked for.
    granted_scopes: granted.grantedScopes, scopes_checked_at: new Date().toISOString(),
  }, { onConflict: "member,address" }).abortSignal(lock.signal);
  // A fresh connection starts a fresh backfill: no cursor or pending ids from an earlier connection carry over.
  if (!error) await db.from("gtm_sync_state").delete().eq("key", stateKey(member.code, granted.email));
  if (error) {
    await revoke();
    return "save-failed";
  }
  return "connected";
}

/** The calendar connection: any Google account the signed-in member consents with (a calendar can live on another address
 *  than their mailbox). The calendar scope must be granted. One client serves the mailbox, the calendar and the
 *  network mailbox, and Google revokes per account and client, so a grant is revoked only when no connection uses that address. */
async function saveCalendar(cfg: NonNullable<ReturnType<typeof gmailConfig>>, code: string, verifier: string, member: string, lock: GrantLock): Promise<string> {
  const db = adminDb();
  let granted: Awaited<ReturnType<typeof exchangeCalendarCode>>;
  // A grant without the calendar scope is not revoked: it may be the same account's live mailbox grant.
  try { granted = await exchangeCalendarCode(cfg, code, verifier, await redirectUri()); } catch (e) {
    return (e as { scopeMissing?: boolean }).scopeMissing ? "scope-missing" : "google-refused";
  }
  if (!lock.live()) return "busy";
  const { error } = await db.from("gtm_team_calendars").upsert({
    member, address: granted.email, token_ciphertext: sealToken(granted.refreshToken, calendarAad(member, granted.email)), key_version: 1,
    granted_scopes: granted.grantedScopes, connected_at: new Date().toISOString(), last_sync_at: null, last_error: null, last_result: null,
  }, { onConflict: "member,address" }).abortSignal(lock.signal);
  if (error) {
    await revokeIfUnused(db, lock, granted.email, granted.refreshToken);
    return "save-failed";
  }
  return "connected";
}
