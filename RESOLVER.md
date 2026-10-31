# Documentation routes

[AGENTS.md](AGENTS.md) supplies the repository rules. This table routes implementation work without importing private operating material into public source.

| Work | Read first |
| --- | --- |
| Setup, architecture and available services | [README.md](README.md) |
| Current production/preview boundaries, releases and scheduled jobs | [Deployment context](docs/deployment.md) |
| Private data schema, pins, transport and release binding | [Private data loading](docs/private-overlay.md) |
| Synthetic local dashboard and CLI | [Local demo](docs/demo.md) |
| Changes and required validation | [Contributing](CONTRIBUTING.md), [Testing](docs/testing.md), `.github/workflows/ci.yml`, `.github/workflows/security.yml` |
| Vulnerability reporting and confidential information | [Security](SECURITY.md) |
| Calendar and approval behavior | `lib/calendar-db.ts`, `lib/auto-schedule.ts`, `app/content/` |
| CLI commands | `cli/gtm.ts`, `bin/gtm` |
| Authentication and database ownership | `proxy.ts`, `lib/supabase/`, `supabase/SOURCE-MANIFEST.json`; production schema belongs to the website repository |

Public sample guide/configuration files describe demonstration behavior. They do not establish the operator's real voice, strategy, accounts, recipients or commercial decisions. Use approved private operating authority when the task requires that information; keep it outside public deliverables.
