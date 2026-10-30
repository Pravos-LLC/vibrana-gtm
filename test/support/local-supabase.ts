// Connection details for the LOCAL Supabase stack (supabase/config.toml). Refuses anything that is
// not loopback, so the database and e2e layers can never write to the hosted project.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export type Local = { url: string; publishableKey: string; secretKey: string; dbUrl: string };

let cached: Local | undefined;
export function local(): Local {
  if (cached) return cached;
  let env = {
    url: process.env.LOCAL_SUPABASE_URL, publishableKey: process.env.LOCAL_SUPABASE_PUBLISHABLE_KEY,
    secretKey: process.env.LOCAL_SUPABASE_SECRET_KEY, dbUrl: process.env.LOCAL_SUPABASE_DB_URL,
  };
  if (!env.url || !env.publishableKey || !env.secretKey || !env.dbUrl) {
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const s = JSON.parse(execFileSync("supabase", ["status", "-o", "json"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
    env = { url: s.API_URL, publishableKey: s.PUBLISHABLE_KEY, secretKey: s.SECRET_KEY, dbUrl: s.DB_URL };
  }
  for (const u of [env.url, env.dbUrl]) {
    const host = new URL(u!).hostname;
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) throw new Error(`refusing non-local Supabase ${host}: tests only run against the local stack`);
  }
  return (cached = env as Local);
}
