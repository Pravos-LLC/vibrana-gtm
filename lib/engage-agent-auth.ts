import { timingSafeEqual } from "node:crypto";

/**
 * The Claude Code engage token. Its own secret, never CRON_SECRET: the Hermes box holds that one for intake and
 * must not gain the power to send replies as John. At least 32 characters, compared in constant time.
 */
export function engageAgentAuthorized(request: Request): boolean {
  const secret = process.env.ENGAGE_AGENT_TOKEN;
  if (!secret || secret.length < 32) return false;
  const got = Buffer.from(request.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  return got.length === want.length && timingSafeEqual(got, want);
}
