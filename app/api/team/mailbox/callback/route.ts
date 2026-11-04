import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { adminDb } from "@/lib/db";
import { exchangeCode, gmailConfig, mailboxAad, revokeToken, stateKey } from "@/lib/team/mailbox";
import { sealToken, verifyState } from "@/lib/team/crypto";
import { NONCE_COOKIE, VERIFIER_COOKIE, clearFlowCookies, origin, redirectUri, viewer } from "@/lib/team/connect";

// Google's redirect after the member consents. API routes skip the proxy, so this route checks everything itself:
// the signed-in owner, the HMAC state bound to that user and member, the nonce cookie, PKCE, and that Google's
// confirmed address is one of the member's configured mailboxes. Any failure redirects with a fixed reason code.
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const back = async (status: string) => {
    await clearFlowCookies();
    return NextResponse.redirect(`${await origin()}/team/mailbox?status=${status}`, { status: 303 });
  };
  const url = new URL(request.url);
  if (url.searchParams.get("error")) return back("declined");
  const code = url.searchParams.get("code"), state = url.searchParams.get("state");
  if (!code || !state || code.length > 2048 || state.length > 2048) return back("invalid");
  const jar = await cookies();
  const s = verifyState(state, jar.get(NONCE_COOKIE)?.value);
  const verifier = jar.get(VERIFIER_COOKIE)?.value;
  if (!s || !verifier) return back("expired");
  const v = await viewer();
  if (!v || v.sub !== s.sub || !v.member || v.member.code !== s.member) return back("wrong-user");
  const cfg = gmailConfig();
  if (!cfg) return back("not-configured");
  let granted: Awaited<ReturnType<typeof exchangeCode>>;
  try { granted = await exchangeCode(cfg, code, verifier, await redirectUri()); } catch { return back("google-refused"); }
  // Google revokes per account and client, not per token: revoking would also kill a live connection of that address
  // (another member's mailbox, or this one's own reconnect). Only a grant nobody uses is revoked (review of #23, N-f).
  const inUse = async () => !!(await adminDb().from("gtm_team_mailboxes").select("member").eq("address", granted.email).limit(1)).data?.length;
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
  }, { onConflict: "member,address" });
  // A fresh connection starts a fresh backfill: no cursor or pending ids from an earlier connection carry over.
  if (!error) await db.from("gtm_sync_state").delete().eq("key", stateKey(v.member.code, granted.email));
  if (error) {
    if (!(await inUse())) await revokeToken(granted.refreshToken);
    return back("save-failed");
  }
  return back("connected");
}
