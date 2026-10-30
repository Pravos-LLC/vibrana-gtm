// Third-party reviewer links (John, 2026-10-12). A third party who signs off on a final (example_approver / Example Series) gets a
// private link John sends over WhatsApp: /invite/<token>. The link IS the page (John, 2026-10-15): no account, no login,
// whoever holds it sees the pieces whose gtm_stories.third_party_who names the party, finals only, and can comment,
// approve or send back (gtm_reviewer_decide_asset_by_link). Logins made by earlier links still open /shared.
//
// app_metadata.gtm_reviewer only routes pages (proxy.ts). What a reviewer may see and do is decided in the database from
// their claimed, unrevoked invites (gtm_reviewer_parties), so revoking an invite shuts them out at once.
// Pure and browser-safe (proxy.ts and client components import it); tokens and invites live in ./invites.
export const INVITE_DAYS = 14;
export const PASSWORD_MIN = 10;

/** Paths a reviewer may open; everything else sends them back to /shared. */
export function reviewerMayOpen(path: string): boolean {
  return path === "/shared" || path.startsWith("/shared/") || path.startsWith("/invite/") || path === "/auth/signout" || path === "/auth/reset";
}

/** Paths anyone may open signed out: the login form, the password-reset page and an invite link. */
export function publicPath(path: string): boolean {
  return path === "/login" || path === "/auth/reset" || path.startsWith("/invite/");
}

export function isReviewer(meta: unknown): boolean {
  const m = meta as { gtm_owner?: boolean; gtm_team?: boolean; gtm_reviewer?: boolean } | undefined;
  return m?.gtm_reviewer === true && m.gtm_owner !== true && m.gtm_team !== true;
}

/** Only a well-formed token (32 random bytes, base64url) is hashed and looked up. */
export function validToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}

export function inviteUrl(base: string, token: string): string {
  return `${base.replace(/\/+$/, "")}/invite/${token}`;
}

/** The author value a reviewer's notes carry ("third_party:example_approver / Example Series"), and back to a display name. */
export function thirdPartyAuthor(party: string): string {
  return `third_party:${party.slice(0, 100)}`;
}

export function authorName(author: string | null | undefined): string | null {
  return author?.startsWith("third_party:") ? author.slice("third_party:".length) : null;
}
