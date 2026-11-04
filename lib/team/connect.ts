// The mailbox consent flow's server-side pieces, shared by the /team/mailbox actions and the OAuth callback route.
import { cookies, headers } from "next/headers";
import { sessionDb } from "../supabase/server";
import { memberByEmail, teamMembers, type TeamMember } from "./members";

export const NONCE_COOKIE = "team_mailbox_nonce";
export const VERIFIER_COOKIE = "team_mailbox_verifier";
export const COOKIE_PATH = "/api/team/mailbox";

export type Viewer = { sub: string; email: string; owner: boolean; member: TeamMember | null };

/** The signed-in owner and, when their login is a configured team member, that member. Null when not the owner. */
export async function viewer(): Promise<Viewer | null> {
  const session = await sessionDb();
  const { data } = await session.auth.getClaims().catch(() => ({ data: null }));
  const claims = data?.claims as { sub?: string; email?: string; app_metadata?: { gtm_owner?: boolean } } | undefined;
  if (!claims?.sub || claims.app_metadata?.gtm_owner !== true) return null;
  const email = (claims.email ?? "").toLowerCase();
  return { sub: claims.sub, email, owner: true, member: memberByEmail(teamMembers(), email) };
}

/** The cockpit's own origin for the OAuth redirect: GTM_COCKPIT_URL in production, else this request's host. */
export async function origin(): Promise<string> {
  const fixed = process.env.GTM_COCKPIT_URL?.trim().replace(/\/+$/, "");
  if (fixed && /^https:\/\//.test(fixed)) return fixed;
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

export const redirectUri = async () => `${await origin()}/api/team/mailbox/callback`;

export async function clearFlowCookies() {
  const jar = await cookies();
  for (const name of [NONCE_COOKIE, VERIFIER_COOKIE]) jar.set(name, "", { path: COOKIE_PATH, maxAge: 0, httpOnly: true, secure: true, sameSite: "lax" });
}
