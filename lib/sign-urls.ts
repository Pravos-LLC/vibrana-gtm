// Signing many private objects at once, with the retry a busy Storage needs: under a burst it answers "too many
// connections" (HTTP 429, SlowDown) to the sign call itself, and a page that took that as final rendered blank media
// (carousel s1-29, 2026-10-13). Same result shape as supabase-js createSignedUrls.
import type { SupabaseClient } from "@supabase/supabase-js";

type Signed = { path: string | null; signedUrl: string; error: string | null };

export async function signedUrls(db: SupabaseClient, paths: string[], ttl: number, bucket = "content-review", sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<{ data: Signed[] }> {
  if (!paths.length) return { data: [] };
  const out: Signed[] = [];
  for (let i = 0; i < paths.length; i += 200) {
    const chunk = paths.slice(i, i + 200);
    for (let attempt = 0; ; attempt++) {
      const { data, error } = await db.storage.from(bucket).createSignedUrls(chunk, ttl);
      if (!error) { out.push(...((data ?? []) as Signed[])); break; }
      if (attempt >= 3) { console.error(`sign ${chunk.length} objects: ${error.message}`); break; }
      await sleep(300 * 2 ** attempt);
    }
  }
  return { data: out };
}
