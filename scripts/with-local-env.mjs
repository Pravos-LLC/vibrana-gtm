#!/usr/bin/env node
// Runs a command with the environment pointed at the LOCAL Supabase stack (never the hosted project)
// and every external service pointed at a closed local port, so nothing can reach Zernio or Twenty.
// Values set here win over .env.local, which Next.js never overrides.
import { execFileSync, spawnSync } from "node:child_process";

const root = new URL("..", import.meta.url).pathname;
const s = JSON.parse(execFileSync("supabase", ["status", "-o", "json"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }));
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(s.API_URL)) throw new Error(`refusing non-local Supabase ${s.API_URL}`);
const closed = "http://127.0.0.1:9";
const env = {
  ...process.env,
  CONTENT_MODE: "sample", PRIVATE_OVERLAY_ROOT: "", PRIVATE_OVERLAY_REVISION: "", PRIVATE_OVERLAY_DIGEST: "", PRIVATE_RELEASE_SHA: "",
  NEXT_PUBLIC_SUPABASE_URL: s.API_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: s.PUBLISHABLE_KEY, SUPABASE_SECRET_KEY: s.SECRET_KEY,
  LOCAL_SUPABASE_URL: s.API_URL, LOCAL_SUPABASE_PUBLISHABLE_KEY: s.PUBLISHABLE_KEY, LOCAL_SUPABASE_SECRET_KEY: s.SECRET_KEY, LOCAL_SUPABASE_DB_URL: s.DB_URL,
  ZERNIO_API_URL: `${closed}/zernio`, ZERNIO_API_KEY: "e2e-no-live-calls", LATE_API_KEY: "e2e-no-live-calls",
  TWENTY_BASE: closed, TWENTY_API_KEY: "e2e-no-live-calls", WISE_API_TOKEN: "e2e-no-live-calls",
  // No model or profile reads: drafting and "Not spam" redrafts take their failure path (the card opens for John).
  OPENROUTER_API_KEY: "", APIFY_TOKEN: "", FIRECRAWL_API_KEY: "",
  // No email: review-link notifications and digests take their logged failure path.
  RESEND_API_KEY: "",
  OUTREACH_GMAIL_CLIENT_ID: "", OUTREACH_GMAIL_CLIENT_SECRET: "", OUTREACH_GMAIL_REFRESH_TOKEN: "", OUTREACH_GMAIL_ACCOUNT: "",
  // Links point at the server under test (the request origin), never a configured deployment.
  GTM_COCKPIT_URL: "",
  CRON_SECRET: "e2e-cron-secret", ZERNIO_WEBHOOK_SECRET: "e2e-webhook-secret", GTM_SKIP_ENV_FILES: "1",
};
const [cmd, ...args] = process.argv.slice(2);
const r = spawnSync(cmd, args, { cwd: root, env, stdio: "inherit", shell: false });
process.exit(r.status ?? 1);
