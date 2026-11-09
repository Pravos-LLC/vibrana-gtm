import { assertDemoDatabase, demoDatabaseFetch } from "./demo-safety";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/** Server/CLI-only client using the secret key (bypasses RLS). Never import from client components. */
export function adminDb(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  assertDemoDatabase(url);
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are required");
  return createClient(url, key, { auth: { persistSession: false }, global: { fetch: demoDatabaseFetch() } });
}

/** A failed database call. `step` is the caller's label; the message is not safe to show. Only the mailbox sync shows a step
 *  (lib/team/mailbox.ts failedStep), and its labels are literals; elsewhere a label may hold an id, so do not show it there. */
export class DbError extends Error {
  constructor(readonly step: string, detail: string) { super(`${step}: ${detail}`); this.name = "DbError"; }
}

export function must<T>(r: { data: T; error: { message: string } | null }, what: string): T {
  if (r.error) throw new DbError(what, r.error.message);
  return r.data;
}
