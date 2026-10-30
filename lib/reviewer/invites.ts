// Reviewer invites, server and CLI only (the service client writes gtm_reviewer_invites; the browser role reads it as
// the owner only). A link is shown once, when it is made: only its token's sha256 is stored. A link makes up to
// max_accounts logins (default 2: the reviewer and a cofounder); opening it again changes nothing, only creating a login does.
import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { must } from "../db";
import { INVITE_DAYS, inviteUrl } from "./access";

export type Invite = {
  id: string; party: string; note: string; expires_at: string; created_at: string; created_by: string | null;
  claimed_email: string | null; claimed_at: string | null; revoked_at: string | null;
  /** How many logins the link may make, and how many it has made (gtm_reviewer_invite_accounts). */
  max_accounts: number; accounts: number;
};
/** "claimed" means every login the link may make is taken; a link with a login left still reads "open". */
export type InviteState = "open" | "claimed" | "expired" | "revoked";
const COLUMNS = "id,party,note,expires_at,created_at,created_by,claimed_email,claimed_at,revoked_at,max_accounts";
export const MAX_ACCOUNTS = 2;

/** A fresh link token (256 bits, base64url, 43 characters) and the hash the database keeps. */
export function newInviteToken(): { token: string; sha256: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, sha256: tokenSha256(token) };
}

export function tokenSha256(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function inviteState(i: Pick<Invite, "expires_at" | "claimed_at" | "revoked_at"> & Partial<Pick<Invite, "max_accounts" | "accounts">>, now = new Date()): InviteState {
  if (i.revoked_at) return "revoked";
  const made = i.accounts ?? (i.claimed_at ? 1 : 0);
  if (made >= (i.max_accounts ?? 1)) return "claimed";
  return new Date(i.expires_at) <= now ? "expired" : "open";
}

export function cockpitUrl(): string {
  return process.env.GTM_COCKPIT_URL?.trim() || "http://localhost:3000";
}

/** The third parties named on Stories: who a link can be made for. */
export async function knownParties(db: SupabaseClient): Promise<string[]> {
  const rows = must(await db.from("gtm_stories").select("third_party_who").not("third_party_who", "is", null), "third parties") as Array<{ third_party_who: string }>;
  return [...new Set(rows.map((r) => r.third_party_who.trim()))].sort();
}

/** Makes a link for a party. The URL is returned once; it cannot be read back later. */
export async function createInvite(db: SupabaseClient, input: { party: string; days?: number; accounts?: number; note?: string; by: string; now?: Date }): Promise<{ invite: Invite; url: string }> {
  const party = input.party.trim();
  const days = input.days ?? INVITE_DAYS;
  if (!party || party.length > 200) throw new Error("Name the third party (up to 200 characters).");
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error("A link can stay open for 1 to 90 days.");
  const accounts = input.accounts ?? MAX_ACCOUNTS;
  if (!Number.isInteger(accounts) || accounts < 1 || accounts > 5) throw new Error("A link can make 1 to 5 logins.");
  const parties = await knownParties(db);
  if (!parties.includes(party)) throw new Error(`No piece names "${party}" as its third party. Known: ${parties.join(", ") || "none"}.`);
  const { token, sha256 } = newInviteToken();
  const expires = new Date((input.now ?? new Date()).getTime() + days * 86_400_000).toISOString();
  const invite = must(await db.from("gtm_reviewer_invites")
    .insert({ token_sha256: sha256, party, note: (input.note ?? "").trim().slice(0, 2000), expires_at: expires, created_by: input.by.slice(0, 200), max_accounts: accounts })
    .select(COLUMNS).single(), "create invite") as Omit<Invite, "accounts">;
  return { invite: { ...invite, accounts: 0 }, url: inviteUrl(cockpitUrl(), token) };
}

export async function listInvites(db: SupabaseClient): Promise<Array<Invite & { emails: string[] }>> {
  const rows = must(await db.from("gtm_reviewer_invites").select(COLUMNS).order("created_at", { ascending: false }), "invites") as Array<Omit<Invite, "accounts">>;
  const made = must(await db.from("gtm_reviewer_invite_accounts").select("invite_id,email"), "invite accounts") as Array<{ invite_id: string; email: string | null }>;
  return rows.map((r) => {
    const mine = made.filter((m) => m.invite_id === r.id);
    return { ...r, accounts: mine.length, emails: mine.map((m) => m.email).filter((e): e is string => !!e) };
  });
}

/** Revoking shuts the account out at once: every reviewer function reads only unrevoked invites. */
export async function revokeInvite(db: SupabaseClient, id: string): Promise<Invite> {
  const row = must(await db.from("gtm_reviewer_invites").update({ revoked_at: new Date().toISOString() }).eq("id", id).is("revoked_at", null).select(COLUMNS).maybeSingle(), "revoke invite") as Omit<Invite, "accounts"> | null;
  if (!row) throw new Error("No open or claimed link with that id.");
  return { ...row, accounts: 0 };
}

/** The invite behind a link, or null. The link page shows the same message for every state but "open". */
export async function findInvite(db: SupabaseClient, token: string): Promise<(Invite & { claimed_by: string | null; account_ids: string[] }) | null> {
  const row = must(await db.from("gtm_reviewer_invites").select(`${COLUMNS},claimed_by`).eq("token_sha256", tokenSha256(token)).maybeSingle(), "invite") as (Omit<Invite, "accounts"> & { claimed_by: string | null }) | null;
  if (!row) return null;
  const made = must(await db.from("gtm_reviewer_invite_accounts").select("user_id").eq("invite_id", row.id), "invite accounts") as Array<{ user_id: string }>;
  return { ...row, accounts: made.length, account_ids: made.map((m) => m.user_id) };
}
