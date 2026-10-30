#!/usr/bin/env node
// Runs brand.example.com's own SQL behaviour tests (vendored in supabase/tests/) against the LOCAL stack.
// Each file runs inside an outer transaction that first isolates the tables it counts; the file's
// own `rollback` undoes everything, so seeded fixtures survive. Any failed expectation raises.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const status = JSON.parse(execFileSync("supabase", ["status", "-o", "json"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
const db = process.env.LOCAL_SUPABASE_DB_URL ?? status.DB_URL;
if (!/@(127\.0\.0\.1|localhost):/.test(db)) throw new Error(`refusing non-local database ${db}`);

const isolate = "begin; truncate public.gtm_stories, public.gtm_story_assets, public.gtm_story_asset_channels cascade;";
let failed = 0;
for (const f of readdirSync(join(root, "supabase/tests")).filter((f) => f.endsWith(".sql")).sort()) {
  try {
    const out = execFileSync("psql", [db, "-v", "ON_ERROR_STOP=1", "-qAt", "-c", isolate, "-f", join(root, "supabase/tests", f)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    // pgTAP reports a failed assertion as a `not ok` row, never as an SQL error, so parse the TAP.
    const plan = /^1\.\.(\d+)$/m.exec(out);
    const passed = (out.match(/^ok \d+/gm) ?? []).length;
    const failures = out.split("\n").filter((l) => /^not ok|^# Looks like/.test(l));
    if (!plan || failures.length || passed !== Number(plan[1])) throw Object.assign(new Error("TAP"), { stderr: [...failures, `planned ${plan?.[1] ?? "?"}, passed ${passed}`].join("\n").replace(/^/gm, "ERROR ") });
    console.log(`ok   ${f} (${passed}/${plan[1]} TAP assertions)`);
  } catch (e) {
    failed++;
    const err = String(e.stderr ?? e.message).split("\n").filter((l) => /ERROR|FAIL/.test(l)).join("\n");
    console.log(`FAIL ${f}\n${err}`);
  }
}
process.exit(failed ? 1 : 0);
