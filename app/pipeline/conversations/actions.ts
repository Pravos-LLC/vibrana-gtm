"use server";
// The network desk's mailbox from Pipeline > Conversations (VIB-522). Only the network desk's owner (the JOHN team member,
// signed in as the cockpit owner) connects it; the shared callback (/api/team/mailbox/callback, state purpose "network")
// finishes the flow and only accepts the expected account with gmail.readonly (lib/outreach/network-mailbox.ts).
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { adminDb } from "@/lib/db";
import { authUrl, gmailConfig } from "@/lib/team/mailbox";
import { pkceChallenge, randomToken, signState } from "@/lib/team/crypto";
import { COOKIE_PATH, NONCE_COOKIE, VERIFIER_COOKIE, redirectUri, viewer } from "@/lib/team/connect";
import { disconnectNetwork, NETWORK_OWNER, NETWORK_PAGE, networkAccount, networkScopes } from "@/lib/outreach/network-mailbox";
import { networkMailboxConfig } from "@/lib/outreach/mailbox";

const PAGE = `${NETWORK_PAGE}?network=`;

export async function connectNetworkMailbox(): Promise<void> {
  const v = await viewer();
  if (!v?.member || v.member.code !== NETWORK_OWNER) redirect(`${PAGE}not-owner`);
  const cfg = gmailConfig();
  if (!cfg) redirect(`${PAGE}not-configured`);
  // Deployment settings win over a stored connection: connecting would change nothing.
  if (networkMailboxConfig()) redirect(`${PAGE}env`);
  const account = networkAccount();
  if (!account) redirect(`${PAGE}no-account`);
  const nonce = randomToken(), verifier = randomToken(48);
  const jar = await cookies();
  const opts = { path: COOKIE_PATH, maxAge: 600, httpOnly: true, secure: true, sameSite: "lax" as const };
  jar.set(NONCE_COOKIE, nonce, opts);
  jar.set(VERIFIER_COOKIE, verifier, opts);
  const state = signState({ sub: v.sub, member: v.member.code, nonce, exp: Date.now() + 600_000, purpose: "network" });
  redirect(authUrl({ clientId: cfg.clientId, redirectUri: await redirectUri(), state, challenge: pkceChallenge(verifier), loginHint: account, scopes: networkScopes(), prompt: "consent" }));
}

/** Deletes the stored connection; Google access is revoked only when no other connection uses the account. */
export async function disconnectNetworkMailbox(): Promise<void> {
  const v = await viewer();
  if (!v?.member || v.member.code !== NETWORK_OWNER) redirect(`${PAGE}not-owner`);
  const status = await disconnectNetwork(adminDb());
  revalidatePath(NETWORK_PAGE);
  redirect(`${PAGE}${status}`);
}
