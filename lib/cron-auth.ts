import { timingSafeEqual } from "node:crypto";

/** Vercel cron requests carry `Authorization: Bearer $CRON_SECRET`; compared in constant time. */
export function cronAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  const got = Buffer.from(request.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  return Boolean(secret) && got.length === want.length && timingSafeEqual(got, want);
}
