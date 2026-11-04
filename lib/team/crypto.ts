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

export type OAuthState = { sub: string; member: string; nonce: string; exp: number };

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
