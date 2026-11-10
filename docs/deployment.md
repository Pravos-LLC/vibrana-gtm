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

The Vercel cron routes are configured in `vercel.json` (eleven, with the pipeline, YouTube and CRM mirror crons); retain their authentication and provider approval boundaries. This cutover does not authorize a test email, campaign or duplicate scheduled job.

`/api/cron/crm-mirror` (hourly at :05) keeps `gtm_crm_people`, the cockpit's copy of every Twenty person (VIB-516): ids, dates and status flags only. No person's name, address, phone or text is stored; the creator's Twenty member name or API key name is kept, because team attribution uses it. It skips the run unless Twenty's `/healthz` answers 200, holds the `crm.mirror` lease, reads 100 people a page 1.5 s apart, and reads only what changed since its cursor plus people soft-deleted since then. Each pass starts just after the last change it saw, or 10 minutes before the earliest page of the previous pass that was reading changes from the last 10 minutes, so a write that committed out of order is still read and settled history is never re-read. It saves its place after every page, so the first backfill (about 140 pages for 14k people) spans one or two runs. When more people than a page share one millisecond (a bulk update), Twenty's cursor cannot move past them, so the mirror reads that millisecond by id, saving its place after every page (a bulk update bigger than one run resumes next run), and carries on. A run that reads nothing before its deadline counts as a failure. If the counts still disagree after a resync, it raises an incident and resyncs at most once a day. Once caught up it compares people created more than 10 minutes before the run, in Twenty and in the mirror; the same difference on two checks in a row starts a resync (every person read again, about 140 pages) and an id sweep for erased rows (about 140 more pages), which refuses to remove more than half of a page's range at once. State: `gtm_sync_state` key `crm.people.mirror`. The team run (:20) counts people from the mirror and reports them as not measured, with the reason, until the backfill has finished, while the sweep is held, after 6 hours without a healthy run, or after 24 hours without catching up; the member's other numbers are still saved.

Problems become health incidents (emailed once to `EMAIL_ALERT_TO`, resolved when they clear): no healthy run for 6 hours (including a mirror whose every run fails, with its last error), no catch-up for 24 hours, or the sweep stopped by its breaker. A run that ends on an error answers 500 in the cron log. **Recovering from a breaker stop:** first check in Twenty that people really were not mass-deleted (if they were, restore them from Twenty's trash or the nightly backup before anything else). Once the CRM is right, clear the hold so the next run sweeps again: `update gtm_sync_state set value = value || '{"sweepError": null, "sweep": {"after": null, "lastId": null, "removed": 0}}' where key = 'crm.people.mirror';`. To start the mirror over completely, run `delete from gtm_crm_people;` and `delete from gtm_sync_state where key = 'crm.people.mirror';` together (deleting only the state leaves erased people live in the table); the next runs copy the CRM again.

`/api/cron/pipeline` (hourly at :50) stores the pipeline dashboard's numbers: the first time each opportunity is seen at a stage, reply and bounce outcomes for accepted client-stream desk emails from the HQ outreach mailbox (read-only; guest and network emails go from other mailboxes and are not read), `lastContactedAt` on the Twenty people the desk emailed on any stream (the cockpit's one Twenty write, forward-only; a LinkedIn note does not set it), and one finished day of site traffic per site from the Vercel Web Analytics API. Each step is nonfatal and reports its own result. Site traffic needs `VERCEL_ANALYTICS_TOKEN`, `VERCEL_TEAM_ID` and `VERCEL_ANALYTICS_SITES` in production; without them the Traffic tab says it is not connected. Wise reconciliation of payment milestones is local only (`gtm sales reconcile`).

Legacy private-archive Actions, including Sunday draft/smoke workflows, are disabled. Relocated private-hub workflow replacements remain manual and held behind false guards. There is no automatic Sunday drafting claim in this operating context; activating a held workflow is a separate authorized operation.
