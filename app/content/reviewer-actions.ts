"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { adminDb } from "@/lib/db";
import { sessionDb } from "@/lib/supabase/server";
import { cockpitUrl, createInvite, findInvite, inviteState, listInvites, revokeInvite } from "@/lib/reviewer/invites";
import { validToken } from "@/lib/reviewer/access";
import type { Share } from "@/lib/reviewer/share";

/** Owner only: the gtm_owner claim is checked here, then the write uses the service client (the browser role cannot write gtm_* tables). */
async function owner(): Promise<string | null> {
  const db = await sessionDb();
  const { data } = await db.auth.getClaims();
  const claims = data?.claims as { email?: string; app_metadata?: { gtm_owner?: boolean } } | undefined;
  return claims?.app_metadata?.gtm_owner === true ? claims.email ?? "owner" : null;
}

/** Ends a link's access at once, claimed or not. */
export async function revokeReviewLink(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!(await owner())) return { ok: false, error: "Not signed in as the cockpit owner." };
  try {
    await revokeInvite(adminDb(), id);
    revalidatePath("/content");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** GTM_COCKPIT_URL when set (production: never a preview deployment's URL), else the origin John is on. */
async function origin(): Promise<string> {
  const configured = process.env.GTM_COCKPIT_URL?.trim().replace(/\/+$/, "");
  if (configured) return configured;
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  return host ? `${h.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https")}://${host}` : cockpitUrl();
}

/**
 * "Share for review": what John sends a third party. If someone already has access for the party (a claimed,
 * unrevoked link), it is the /shared page they sign in to; nothing new is made. Otherwise (or with `fresh`) one new
 * single-use link. The modal passes back the token of the unused link it made last time (`reuse`, kept in John's
 * browser; the database keeps only hashes), so reopening it shows the same link instead of making another.
 */
export async function shareForReview(input: { party: string; fresh?: boolean; reuse?: string }): Promise<{ ok: true; share: Share } | { ok: false; error: string }> {
  const by = await owner();
  if (!by) return { ok: false, error: "Not signed in as the cockpit owner." };
  try {
    const db = adminDb();
    const party = input.party.trim();
    const base = await origin();
    const live = (await listInvites(db)).filter((i) => i.party === party);
    const claimed = live.find((i) => inviteState(i) === "claimed");
    if (claimed && !input.fresh) return { ok: true, share: { kind: "access", party, url: `${base}/shared`, email: claimed.claimed_email } };
    // The unused link this browser made last time (the modal keeps its token locally): same URL, nothing new.
    if (!input.fresh && input.reuse && validToken(input.reuse)) {
      const prior = await findInvite(db, input.reuse);
      if (prior && prior.party === party && inviteState(prior) === "open") {
        return { ok: true, share: { kind: "invite", party, url: `${base}/invite/${input.reuse}`, email: null } };
      }
    }
    const { url } = await createInvite(db, { party, by });
    revalidatePath("/content");
    return { ok: true, share: { kind: "invite", party, url: `${base}${new URL(url).pathname}`, email: null } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
