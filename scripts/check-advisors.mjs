#!/usr/bin/env node
// Fails on any Supabase advisor finding (security or performance, any level) in the LOCAL database,
// except the entries below. Every allowance names why it is safe; an allowance that no longer
// matches a finding also fails, so this list cannot silently go stale.
import { execFileSync } from "node:child_process";

const ALLOW = [
  { lint: "unused_index", why: "a freshly migrated CI database has never served a query, so every index is 'unused'" },
  { key: "rls_enabled_no_policy_public_review_publications", why: "deliberate deny-all: service_role only, no grants to anon/authenticated (content_review migration)" },
  { key: "rls_enabled_no_policy_public_review_publication_cancellations", why: "deliberate deny-all: service_role only, append-only tombstones" },
  { key: "rls_enabled_no_policy_public_client_feedback", why: "deliberate deny-all: service_role only (app/api/feedback), no grants to anon/authenticated (client_feedback migration)" },
];

const root = new URL("..", import.meta.url).pathname;
const raw = execFileSync("supabase", ["db", "advisors", "--local", "--type", "all", "--level", "info", "--output-format", "json"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
const { results = [] } = JSON.parse(raw.slice(raw.indexOf("{")));
const used = new Set();
const bad = [];
for (const r of results) {
  const i = ALLOW.findIndex((a) => (a.key ? a.key === r.cacheKey : a.lint === r.name));
  if (i >= 0) { used.add(i); continue; }
  bad.push(`${r.level} ${r.name}: ${r.detail}`);
}
const stale = ALLOW.filter((a, i) => a.key && !used.has(i)).map((a) => `allowance no longer matches any finding (remove it): ${a.key}`);
console.log(`${results.length} advisor findings, ${results.length - bad.length} allowed`);
for (const line of [...bad, ...stale]) console.log(`  FAIL ${line}`);
process.exit(bad.length || stale.length ? 1 : 0);
