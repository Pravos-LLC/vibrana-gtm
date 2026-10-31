# Deployment context

Current as of October 31, 2026. This is the active public repository context following publication and production cutover. Earlier preparation holds describe history unless repeated below.

## Source and deployment ownership

The canonical public repository's protected `main` branch deploys the live cockpit at [gtm.vibrana.ai](https://gtm.vibrana.ai) through Vercel project `vibrana-gtm`. Develop and open PRs here. The old private archive preserves history and unfinished work; all of its GitHub Actions are disabled. Do not resume development or CI there.

Required CI and independent exact-head review remain release gates. A merge to `main` is a live deployment. Preserve the prior production deployment and its configuration until the replacement passes the applicable runtime and authorization checks. Use the approved provider promotion/rollback route, never a Vercel CLI deployment.

## Production and previews

Canonical production runs with `CONTENT_MODE=private` and `DEMO_MODE=0`. Its guide and typed operational configuration come from separately reviewed private data. Production credentials and private data do not enter public CI or previews.

Preview deployment execution is disabled on the real production project. Public PR previews run on the separate sample project, `vibrana-gtm-public-preview`. That project's production publication remains held by `publication-production-held`; the hold does not describe the canonical live application.

Local/public CI defaults to samples. The dedicated demo additionally blocks live provider operations and uses its own local database. Neither sample guide content nor sample account/catalog/mail settings are production authority.

## Build and private delivery

The production provider runs:

```sh
node scripts/production-install.mjs
node scripts/production-build.mjs
```

Installation removes restored private caches and disables dependency lifecycle scripts during a full frozen-lockfile install with a scrubbed environment. The trusted build validates provider identity before fetching the private artifact, verifies every data pin and materializes only validated bytes for server runtime. Environment scrubbing is not an operating-system sandbox.

The operated delivery path is HTTPS from an authenticated, static data-only project. Its immutable artifact contains nineteen guide/voice/season JSON members, the overlay manifest and a separate typed runtime JSON file. The project requires authentication on every deployment. A project-scoped protection-bypass credential travels only in a request header; it is effectively read-only because the project has no executable or write endpoints. It is not a provider-management credential or a hub-read token.

The source retains an optional SSH transport, but organization policy disables deploy keys. Do not weaken that policy or treat SSH as the active setup. See [private data loading](private-overlay.md) for schemas and pin names. Actual private values, artifact addresses and credentials belong in protected deployment configuration, not public documentation.

The generated release stamp binds the actual provider repository, project, protected branch, Git SHA and deployment ID to the immutable data revision/digests. Runtime rejects a mismatch. Each normal protected-main deployment receives its own stamp, so routine source merges need no manual per-head environment update. `PRIVATE_RELEASE_SHA` is intentionally unset in the operated deployment; configuring it would add a manual constraint.

## Database, authorization and schedules

Existing Supabase configuration and owner/team/reviewer claim boundaries remain in force. The website repository owns production schema; the vendored migration snapshot supports isolated local tests and demos. Do not reset production, import sample data or replay sanitized history as a cutover step.

The six existing Vercel cron routes remain configured in `vercel.json`; retain their authentication and provider approval boundaries. This cutover does not authorize a test email, campaign or duplicate scheduled job.

Legacy private-archive Actions, including Sunday draft/smoke workflows, are disabled. Relocated private-hub workflow replacements remain manual and held behind false guards. There is no automatic Sunday drafting claim in this operating context; activating a held workflow is a separate authorized operation.
