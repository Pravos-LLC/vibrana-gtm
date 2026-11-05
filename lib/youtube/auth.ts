// One-time consent for the channel owner (the loopback flow for a Desktop OAuth client, with PKCE). Run by John:
// `gtm youtube auth`. The refresh token goes to a private file for him to store with dotenvx; it is never printed.
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { SCOPES } from "./api";

export function pkce() {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url"), state: randomBytes(16).toString("hex") };
}

export function authUrl(clientId: string, redirect: string, challenge: string, state: string) {
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  for (const [k, v] of Object.entries({ client_id: clientId, redirect_uri: redirect, response_type: "code", scope: SCOPES.join(" "), access_type: "offline", prompt: "consent", code_challenge: challenge, code_challenge_method: "S256", state })) u.searchParams.set(k, v);
  return u.toString();
}

/** Listens on 127.0.0.1 for Google's redirect; `code` resolves once, only for a response carrying our `state`. */
export async function startLoopback(state: string, timeoutMs = 300_000): Promise<{ redirect: string; code: Promise<string> }> {
  let finish!: (c: string) => void, fail!: (e: Error) => void;
  const code = new Promise<string>((res, rej) => { finish = res; fail = rej; });
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    const c = u.searchParams.get("code");
    res.setHeader("content-type", "text/plain");
    if (!c || u.searchParams.get("state") !== state) { res.statusCode = 400; res.end("Not the expected response."); return; }
    res.end("YouTube connected. You can close this tab.");
    clearTimeout(timer); server.close(); finish(c);
  });
  const timer = setTimeout(() => { server.close(); fail(new Error("Timed out waiting for Google's response")); }, timeoutMs);
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return { redirect: `http://127.0.0.1:${(server.address() as { port: number }).port}`, code };
}

export async function exchangeCode(clientId: string, clientSecret: string, code: string, redirect: string, verifier: string): Promise<string> {
  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirect, grant_type: "authorization_code", code_verifier: verifier });
  const res = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body });
  const j = (await res.json().catch(() => ({}))) as { refresh_token?: string; error?: string };
  if (!res.ok || !j.refresh_token) throw new Error(`Google did not return a refresh token (${j.error ?? res.status}); revoke the app at myaccount.google.com/permissions and run again`);
  return j.refresh_token;
}
