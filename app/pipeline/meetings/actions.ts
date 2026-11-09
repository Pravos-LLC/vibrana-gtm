"use server";
// Calendar consent from /pipeline/meetings (VIB-518). Only a signed-in team member can connect their own calendar; the
// shared callback (/api/team/mailbox/callback) finishes the flow. Disconnecting deletes the stored token; the Twenty
// meeting rows stay (they are CRM records), and the meeting map is kept so a reconnect does not write them twice.
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { adminDb } from "@/lib/db";
import { calendarAad, calendarScopes } from "@/lib/team/calendar";
import { authUrl, gmailConfig, revokeToken } from "@/lib/team/mailbox";
import { openToken, pkceChallenge, randomToken, signState } from "@/lib/team/crypto";
import { COOKIE_PATH, NONCE_COOKIE, VERIFIER_COOKIE, redirectUri, viewer } from "@/lib/team/connect";

const PAGE = "/pipeline/meetings?calendar=";

export async function connectCalendar(): Promise<void> {
  const v = await viewer();
  if (!v?.member) redirect(`${PAGE}not-member`);
  const cfg = gmailConfig();
  if (!cfg) redirect(`${PAGE}not-configured`);
  const nonce = randomToken(), verifier = randomToken(48);
  const jar = await cookies();
  const opts = { path: COOKIE_PATH, maxAge: 600, httpOnly: true, secure: true, sameSite: "lax" as const };
  jar.set(NONCE_COOKIE, nonce, opts);
  jar.set(VERIFIER_COOKIE, verifier, opts);
  const state = signState({ sub: v.sub, member: v.member.code, nonce, exp: Date.now() + 600_000, purpose: "calendar" });
  // No login hint and an account chooser: the calendar may be on another address than the member's mailbox.
  redirect(authUrl({ clientId: cfg.clientId, redirectUri: await redirectUri(), state, challenge: pkceChallenge(verifier), scopes: calendarScopes(), prompt: "select_account consent" }));
}

export async function disconnectCalendar(form: FormData): Promise<void> {
  const v = await viewer();
  if (!v?.member) redirect(`${PAGE}not-member`);
  const address = String(form.get("address") ?? "").trim().toLowerCase();
  const db = adminDb();
  const { data, error } = await db.from("gtm_team_calendars").select("member,address,token_ciphertext").eq("member", v.member.code).eq("address", address);
  if (error || !data?.length) redirect(`${PAGE}disconnect-failed`);
  const row = data[0] as { member: string; address: string; token_ciphertext: string };
  // One Google client serves the mailbox and the calendar, and Google revokes the whole grant for an account: revoke only
  // when no mailbox connection uses this address, else the token is just deleted.
  const mailbox = await db.from("gtm_team_mailboxes").select("member").eq("address", row.address).limit(1);
  if (!mailbox.error && !mailbox.data?.length) {
    try { await revokeToken(openToken(row.token_ciphertext, calendarAad(row.member, row.address))); } catch { /* deleted below either way */ }
  }
  const del = await db.from("gtm_team_calendars").delete().eq("member", row.member).eq("address", row.address);
  revalidatePath("/pipeline/meetings");
  redirect(`${PAGE}${del.error ? "disconnect-failed" : "disconnected"}`);
}
