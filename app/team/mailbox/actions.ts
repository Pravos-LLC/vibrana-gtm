"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { adminDb } from "@/lib/db";
import { authUrl, gmailConfig, mailboxAad, revokeToken } from "@/lib/team/mailbox";
import { openToken, pkceChallenge, randomToken, signState } from "@/lib/team/crypto";
import { COOKIE_PATH, NONCE_COOKIE, VERIFIER_COOKIE, redirectUri, viewer } from "@/lib/team/connect";

/** Starts Google's consent screen for the signed-in member's own mailbox. Only the member can connect their mailbox. */
export async function connectMailbox(): Promise<void> {
  const v = await viewer();
  if (!v?.member) redirect("/team/mailbox?status=not-member");
  const cfg = gmailConfig();
  if (!cfg) redirect("/team/mailbox?status=not-configured");
  const nonce = randomToken(), verifier = randomToken(48);
  const jar = await cookies();
  const opts = { path: COOKIE_PATH, maxAge: 600, httpOnly: true, secure: true, sameSite: "lax" as const };
  jar.set(NONCE_COOKIE, nonce, opts);
  jar.set(VERIFIER_COOKIE, verifier, opts);
  const state = signState({ sub: v.sub, member: v.member.code, nonce, exp: Date.now() + 600_000 });
  redirect(authUrl({ clientId: cfg.clientId, redirectUri: await redirectUri(), state, challenge: pkceChallenge(verifier), loginHint: v.member.mailboxes[0] ?? v.email }));
}

/** Disconnects the member's mailbox: revokes the token at Google and deletes the connection and every counted mail event. */
export async function disconnectMailbox(): Promise<void> {
  const v = await viewer();
  if (!v?.member) redirect("/team/mailbox?status=not-member");
  const db = adminDb();
  const { data, error } = await db.from("gtm_team_mailboxes").select("member,address,token_ciphertext").eq("member", v.member.code);
  if (error) redirect("/team/mailbox?status=disconnect-failed");
  for (const row of (data ?? []) as { member: string; address: string; token_ciphertext: string }[]) {
    try { await revokeToken(openToken(row.token_ciphertext, mailboxAad(row.member, row.address))); } catch { /* deleted below either way */ }
  }
  // Events first: if a later step fails, a retry still finds the mailbox row and finishes the job.
  const steps = [
    await db.from("gtm_team_mail_events").delete().eq("member", v.member.code),
    await db.from("gtm_sync_state").delete().like("key", `team.mailbox.${v.member.code.toLowerCase()}.%`),
    await db.from("gtm_team_mailboxes").delete().eq("member", v.member.code),
  ];
  revalidatePath("/team/mailbox");
  revalidatePath("/performance/team");
  redirect(steps.some((s) => s.error) ? "/team/mailbox?status=disconnect-failed" : "/team/mailbox?status=disconnected");
}
