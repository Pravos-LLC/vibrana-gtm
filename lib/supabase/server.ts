import { assertDemoDatabase, demoDatabaseFetch } from "../demo-safety";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { cache } from "react";

/** Session-bound client for server components: reads go through RLS (owner-only). */
export const sessionDb = cache(async function sessionDb() {
  assertDemoDatabase(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const store = await cookies();
  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    global: { fetch: (input, init) => demoDatabaseFetch()(input, { ...init, cache: "no-store" }) },
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          list.forEach(({ name, value, options }) => store.set(name, value, options));
        } catch {
          // Server components can't set cookies; proxy.ts refreshes the session.
        }
      },
    },
  });
});
