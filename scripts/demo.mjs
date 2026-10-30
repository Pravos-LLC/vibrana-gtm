#!/usr/bin/env node
// A standalone demo uses only the dedicated local stack; no hub dotenv loading.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, mkdirSync, cpSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const runtime = join(root, "node_modules", ".cache", "gtm-demo");
const stackArgs = ["--workdir", runtime];

function prepareStack() {
  const supabase = join(runtime, "supabase");
  mkdirSync(supabase, { recursive: true });
  const config = readFileSync(new URL("../supabase/config.toml", import.meta.url), "utf8")
    .replace('project_id = "vibrana-gtm"', 'project_id = "vibrana-gtm-demo"')
    .replaceAll("56321", "61321").replaceAll("56322", "61322").replaceAll("56320", "61320");
  writeFileSync(join(supabase, "config.toml"), config);
  rmSync(join(supabase, "migrations"), { recursive: true, force: true });
  cpSync(new URL("../supabase/migrations", import.meta.url), join(supabase, "migrations"), { recursive: true });
}

export function demoEnvironment(status, inherited = process.env) {
  if (!status.API_URL || !status.DB_URL) throw new Error("Local Supabase API/database is unavailable. Start its gateway and rerun demo:setup.");
  const url = new URL(status.API_URL);
  const db = new URL(status.DB_URL);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.port !== "61321"
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash
    || db.protocol !== "postgresql:" || db.username !== "postgres" || db.pathname !== "/postgres" || db.search || db.hash
    || !["127.0.0.1", "localhost", "[::1]"].includes(db.hostname) || db.port !== "61322") throw new Error("Demo requires the dedicated loopback Supabase stack (61321/61322)");
  const publishable = status.PUBLISHABLE_KEY ?? status.ANON_KEY;
  const secret = status.SECRET_KEY ?? status.SERVICE_ROLE_KEY;
  if (!publishable || !secret) throw new Error("Local Supabase keys are missing");
  // Retain only OS/runtime essentials. Blanks prevent Next's dotenv loader restoring provider credentials.
  const env = Object.fromEntries(["PATH", "HOME", "TMPDIR", "USER", "SHELL", "SystemRoot", "APPDATA", "PNPM_HOME"].filter(k => inherited[k]).map(k => [k, inherited[k]]));
  const names = readFileSync(new URL("../.env.example", import.meta.url), "utf8").matchAll(/^([A-Z][A-Z0-9_]*)=/gm);
  for (const [_, key] of names) env[key] = "";
  return { ...env, DEMO_MODE: "1", NEXT_PUBLIC_DEMO_MODE: "1", CONTENT_MODE: "sample", GTM_SKIP_ENV_FILES: "1",
    NEXT_PUBLIC_SUPABASE_URL: url.origin, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: publishable, SUPABASE_SECRET_KEY: secret,
    LOCAL_SUPABASE_URL: url.origin, LOCAL_SUPABASE_PUBLISHABLE_KEY: publishable, LOCAL_SUPABASE_SECRET_KEY: secret, LOCAL_SUPABASE_DB_URL: status.DB_URL,
    CRON_SECRET: "local-demo-cron", ZERNIO_WEBHOOK_SECRET: "local-demo-webhook", GTM_COCKPIT_URL: "http://127.0.0.1:3100" };
}

function run(command, args, env) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function main() {
  const [action = "dev", ...args] = process.argv.slice(2);
  if (!["setup", "dev", "gtm", "stop"].includes(action)) throw new Error("Usage: node scripts/demo.mjs setup|dev|gtm|stop [CLI args]");
  if (action === "stop") {
    execFileSync("supabase", ["stop", ...stackArgs], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
    return;
  }
  if (action === "setup") {
    // Supabase prints local service keys on stdout; do not forward them to logs.
    prepareStack();
    try { execFileSync("supabase", ["start", "-x", "imgproxy,mailpit,postgres-meta,studio,edge-runtime,logflare,vector,supavisor,realtime", ...stackArgs], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
    catch { throw new Error("Could not start the local Supabase stack. Check the container runtime and reserved demo ports."); }
  }
  const status = JSON.parse(execFileSync("supabase", ["status", "-o", "json", ...stackArgs], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  const env = demoEnvironment(status);
  if (action === "setup") {
    console.log("Resetting synthetic fixtures in the dedicated LOCAL demo database.");
    run(process.execPath, ["--import", "tsx", "test/support/seed.ts"], env);
    console.log("Demo ready. Run pnpm demo and sign in as owner@gtm.test with gtm-test-password-1.");
  } else if (action === "gtm") run(process.execPath, ["--import", "tsx", "cli/gtm.ts", ...args], env);
  else run("pnpm", ["exec", "next", "dev", "--hostname", "127.0.0.1", "--port", "3100"], env);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
