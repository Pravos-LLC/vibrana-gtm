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

export function must<T>(r: { data: T; error: { message: string } | null }, what: string): T {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
}
