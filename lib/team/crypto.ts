// Secrets for the team mailbox connection, all keyed from TEAM_MAILBOX_KEY (32 random bytes, base64):
// - refresh tokens are sealed with AES-256-GCM (random 12-byte IV per seal, the member and address as associated data,
//   a key-version byte so the key can rotate);
// - the OAuth `state` is HMAC-signed and bound to the signed-in user, the member, a nonce held in an httpOnly cookie
//   and a 10-minute expiry;
// - recipient addresses are never stored: a keyed hash lets the sync tell whether a reply came from someone the member
//   wrote to without keeping the address.
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

export const KEY_VERSION = 1;

function masterKey(env: Record<string, string | undefined> = process.env): Buffer {
  const raw = env.TEAM_MAILBOX_KEY;
  const key = raw ? Buffer.from(raw, "base64") : Buffer.alloc(0);
  if (key.length !== 32) throw new Error("TEAM_MAILBOX_KEY must be 32 bytes, base64 encoded");
  return key;
}
const derive = (purpose: string, env?: Record<string, string | undefined>) => Buffer.from(hkdfSync("sha256", masterKey(env), Buffer.alloc(0), `vibrana-team-mailbox/${purpose}`, 32));

export function sealToken(token: string, aad: string, env?: Record<string, string | undefined>): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", derive("token", env), iv);
  cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([KEY_VERSION]), iv, cipher.getAuthTag(), body]).toString("base64");
}

export function openToken(sealed: string, aad: string, env?: Record<string, string | undefined>): string {
  const buf = Buffer.from(sealed, "base64");
  if (buf.length < 30 || buf[0] !== KEY_VERSION) throw new Error("The stored mailbox token uses an unknown key version");
  const decipher = createDecipheriv("aes-256-gcm", derive("token", env), buf.subarray(1, 13));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(buf.subarray(13, 29));
  return Buffer.concat([decipher.update(buf.subarray(29)), decipher.final()]).toString("utf8");
}

export const addressHash = (address: string, env?: Record<string, string | undefined>) =>
  createHmac("sha256", derive("address", env)).update(address.trim().toLowerCase()).digest("base64url").slice(0, 32);

/** A keyed hash of an RFC 5322 Message-ID, so a copy of one message seen in two mailboxes (a forward, a CC to the HQ inbox)
 *  is recognized as the same send without storing the header. Angle brackets and case are ignored. */
export const messageKey = (messageId: string, env?: Record<string, string | undefined>) =>
  createHmac("sha256", derive("message", env)).update(messageId.trim().replace(/^<|>$/g, "").toLowerCase()).digest("base64url").slice(0, 32);

/** A Google calendar event id as a keyed hash: the meeting map never stores the raw id (VIB-518). The id alone, not the
 *  calendar's address, so one meeting on two members' calendars has one key and is counted once. */
export const eventKey = (eventId: string, env?: Record<string, string | undefined>) =>
  createHmac("sha256", derive("calendar-event", env)).update(eventId.trim()).digest("base64url").slice(0, 32);

/** A LinkedIn profile slug as a keyed hash (VIB-521): Origami evidence never stores the profile URL. */
export const linkedinHash = (slug: string, env?: Record<string, string | undefined>) =>
  createHmac("sha256", derive("linkedin-slug", env)).update(slug.trim().toLowerCase()).digest("base64url").slice(0, 32);

/** A keyed hash of a reply's text (VIB-521): proves which text a rule judged without keeping the text. */
export const replyHash = (text: string, env?: Record<string, string | undefined>) =>
  createHmac("sha256", derive("origami-reply", env)).update(text).digest("base64url").slice(0, 32);

/** `purpose` "calendar" routes the shared callback to the calendar connection (VIB-518); absent means the mailbox. */
export type OAuthState = { sub: string; member: string; nonce: string; exp: number; purpose?: "calendar" };

export function signState(s: OAuthState, env?: Record<string, string | undefined>): string {
  const body = Buffer.from(JSON.stringify(s)).toString("base64url");
  return `${body}.${createHmac("sha256", derive("state", env)).update(body).digest("base64url")}`;
}

/** Returns the state when the signature, the expiry and the cookie nonce all hold; otherwise null. */
export function verifyState(state: string, nonce: string | undefined, now = Date.now(), env?: Record<string, string | undefined>): OAuthState | null {
  const [body, sig] = state.split(".");
  if (!body || !sig || !nonce) return null;
  const want = createHmac("sha256", derive("state", env)).update(body).digest();
  const got = Buffer.from(sig, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  let s: OAuthState;
  try { s = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { return null; }
  if (typeof s.exp !== "number" || s.exp < now || typeof s.nonce !== "string") return null;
  const a = Buffer.from(s.nonce), b = Buffer.from(nonce);
  return a.length === b.length && timingSafeEqual(a, b) ? s : null;
}

export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
export const pkceChallenge = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");
