import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { adminDb } from "@/lib/db";
import { exchangeCode, gmailConfig, mailboxAad, revokeToken, stateKey } from "@/lib/team/mailbox";
import { calendarAad, exchangeCalendarCode } from "@/lib/team/calendar";
import { sealToken, verifyState } from "@/lib/team/crypto";
import { NONCE_COOKIE, VERIFIER_COOKIE, clearFlowCookies, origin, redirectUri, viewer } from "@/lib/team/connect";

// Google's redirect after the member consents. API routes skip the proxy, so this route checks everything itself:
// the signed-in owner, the HMAC state bound to that user and member, the nonce cookie, PKCE, and that Google's
// confirmed address is one of the member's configured mailboxes. Any failure redirects with a fixed reason code.
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  // The calendar flow (VIB-518) shares this registered redirect; its state says so, and it returns to /pipeline/meetings.
  let page = "/team/mailbox?status=";
  const back = async (status: string) => {
    await clearFlowCookies();
    return NextResponse.redirect(`${await origin()}${page}${status}`, { status: 303 });
  };
  const url = new URL(request.url);
  if (url.searchParams.get("error")) {
    // Google returns the state on a refusal too: a verified one says which page the member came from.
    const st = verifyState(url.searchParams.get("state") ?? "", (await cookies()).get(NONCE_COOKIE)?.value);
    if (st?.purpose === "calendar") page = "/pipeline/meetings?calendar=";
    return back("declined");
  }
  const code = url.searchParams.get("code"), state = url.searchParams.get("state");
  if (!code || !state || code.length > 2048 || state.length > 2048) return back("invalid");
  const jar = await cookies();
  const s = verifyState(state, jar.get(NONCE_COOKIE)?.value);
  const verifier = jar.get(VERIFIER_COOKIE)?.value;
  if (!s || !verifier) return back("expired");
  if (s.purpose === "calendar") page = "/pipeline/meetings?calendar=";
  const v = await viewer();
  if (!v || v.sub !== s.sub || !v.member || v.member.code !== s.member) return back("wrong-user");
  const cfg = gmailConfig();
  if (!cfg) return back("not-configured");
  if (s.purpose === "calendar") return back(await saveCalendar(cfg, code, verifier, v.member.code));
  let granted: Awaited<ReturnType<typeof exchangeCode>>;
  try { granted = await exchangeCode(cfg, code, verifier, await redirectUri()); } catch { return back("google-refused"); }
  // Google revokes per account and client, not per token: revoking would also kill a live connection of that address
  // (another member's mailbox, or this one's own reconnect). Only a grant nobody uses is revoked (review of #23, N-f).
  // A failed lookup counts as "in use": when unsure, keep the grant rather than risk killing a live connection.
  // The calendar connection (VIB-518) uses the same client, so its grant for this address counts too.
  const inUse = async () => {
    const { data, error } = await adminDb().from("gtm_team_mailboxes").select("member").eq("address", granted.email).limit(1);
    const cal = await adminDb().from("gtm_team_calendars").select("member").eq("address", granted.email).limit(1);
    return !!error || !!data?.length || !!cal.error || !!cal.data?.length;
  };
  if (!v.member.mailboxes.includes(granted.email)) {
    if (!(await inUse())) await revokeToken(granted.refreshToken);
    return back("wrong-mailbox");
  }
  const db = adminDb();
  // A reconnect simply replaces the stored token. The old one is never revoked here: Google revokes the whole grant for
  // the account and client, which would kill the token just issued (review of #23, NB1).
  const { error } = await db.from("gtm_team_mailboxes").upsert({
    member: v.member.code, address: granted.email, token_ciphertext: sealToken(granted.refreshToken, mailboxAad(v.member.code, granted.email)),
    key_version: 1, history_id: null, backfill_done: false, connected_at: new Date().toISOString(), last_sync_at: null, last_error: null,
    // What Google granted, read from its answer: body-dependent work checks this, never the scope the code asked for.
    granted_scopes: granted.grantedScopes, scopes_checked_at: new Date().toISOString(),
  }, { onConflict: "member,address" });
  // A fresh connection starts a fresh backfill: no cursor or pending ids from an earlier connection carry over.
  if (!error) await db.from("gtm_sync_state").delete().eq("key", stateKey(v.member.code, granted.email));
  if (error) {
    if (!(await inUse())) await revokeToken(granted.refreshToken);
    return back("save-failed");
  }
  return back("connected");
}

/** The calendar connection: any Google account the signed-in member consents with (a calendar can live on another address
 *  than their mailbox). The calendar scope must be granted. One client serves the mailbox and the calendar, and Google
 *  revokes per account and client, so a grant is revoked only when neither connection uses that address. */
async function saveCalendar(cfg: NonNullable<ReturnType<typeof gmailConfig>>, code: string, verifier: string, member: string): Promise<string> {
  const db = adminDb();
  const inUse = async (address: string) => {
    const [a, b] = await Promise.all([
      db.from("gtm_team_calendars").select("member").eq("address", address).limit(1),
      db.from("gtm_team_mailboxes").select("member").eq("address", address).limit(1),
    ]);
    return !!a.error || !!b.error || !!a.data?.length || !!b.data?.length;
  };
  let granted: Awaited<ReturnType<typeof exchangeCalendarCode>>;
  // A grant without the calendar scope is not revoked: it may be the same account's live mailbox grant.
  try { granted = await exchangeCalendarCode(cfg, code, verifier, await redirectUri()); } catch (e) {
    return (e as { scopeMissing?: boolean }).scopeMissing ? "scope-missing" : "google-refused";
  }
  const { error } = await db.from("gtm_team_calendars").upsert({
    member, address: granted.email, token_ciphertext: sealToken(granted.refreshToken, calendarAad(member, granted.email)), key_version: 1,
    granted_scopes: granted.grantedScopes, connected_at: new Date().toISOString(), last_sync_at: null, last_error: null, last_result: null,
  }, { onConflict: "member,address" });
  if (error) {
    if (!(await inUse(granted.email))) await revokeToken(granted.refreshToken);
    return "save-failed";
  }
  return "connected";
}
