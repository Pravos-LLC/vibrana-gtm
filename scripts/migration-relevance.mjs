// Pure relevance rule for scripts/check-migrations.mjs, split out so it can be unit tested
// (test/check-migrations.test.ts) without gh or network access.
//
// Judge relevance by what a changed file does, not its name: any upstream SQL that mentions a vendored
// object, storage, grants or default privileges could change the schema these tests prove.
export const RELEVANT = /gtm_|review_|story|content-review|storage\.|default privileges|\bgrant\b|\brevoke\b|\bpolicy\b|to (anon|authenticated|public)\b/i;
const SQL = /^supabase\/(migrations|tests)\/.*\.sql$/;

/**
 * Should an entry from GitHub's compare API (`files[]`) fail the upstream check?
 * @param {{ filename: string, status?: string, patch?: string, previous_filename?: string }} f
 * @param {string[]} vendored repo-relative paths of the vendored SQL files
 * @param {(filename: string) => string} fetchBody the file's content on upstream master
 */
export function upstreamChangeIsRelevant(f, vendored, fetchBody) {
  // A rename moves a file without (necessarily) changing it, so its patch can be empty and its new name
  // can fall outside supabase/. Renaming or moving a vendored file is always relevant.
  if (f.previous_filename && vendored.includes(f.previous_filename)) return true;
  if (f.status === "renamed" && vendored.includes(f.filename)) return true;
  if (!SQL.test(f.filename)) return false;
  if (vendored.includes(f.filename) || RELEVANT.test(f.filename)) return true;
  const body = f.patch || (f.status === "removed" ? "" : fetchBody(f.filename));
  return RELEVANT.test(body);
}
