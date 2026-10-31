# GTM Cockpit

A Next.js dashboard and command-line toolkit for a small content team. It includes a content calendar, approval queue, engagement review, analytics, and an outreach writing desk.

## Deployment and development

As of October 31, 2026, this public repository is the active development source for the live cockpit at [gtm.vibrana.ai](https://gtm.vibrana.ai). Protected `main` merges deploy to the canonical Vercel project, `vibrana-gtm`. Follow the required CI, independent review and release authorization before merging.

Local development, public CI and pull-request previews use synthetic samples. Canonical production uses separately pinned private data and operational configuration; sample content is not the authority for production guidance. Production previews are disabled on the real project. The separate sample-preview project's production publication remains held.

See [deployment context](docs/deployment.md) for the current operating boundaries, [private data loading](docs/private-overlay.md) for the validated interfaces, and [AGENTS.md](AGENTS.md) for repository instructions. The old private source archive is frozen history; it is not the development checkout or a CI runner.

## Local setup

Install Node.js 22 or later, pnpm, the Supabase CLI, PostgreSQL client tools (psql), and a Docker-compatible container runtime. Then run:

```sh
pnpm install --frozen-lockfile
CONTENT_MODE=sample pnpm typecheck
CONTENT_MODE=sample pnpm test
CONTENT_MODE=sample pnpm build
pnpm demo:setup
pnpm demo
```

The demo uses a separate local database and synthetic content. See [demo setup](docs/demo.md) and follow the command's setup output. Demo mode disables live provider delivery. Never add production credentials to a demo, test, fork, or preview.

## Architecture

The app uses Next.js App Router, Supabase authentication and row-level security, and adapters for Zernio, Twenty CRM, Wise, email and language-model services. The CLI entry point is bin/gtm. Source content is loaded through lib/content-overlay.mjs. Browser components receive only the fields rendered by an authorized server page.

The sample content is synthetic. Replace it with your own material. Ordinary builds and tests use samples. Tests force sample mode regardless of linked private files. A local private mode requires an absolute external root, a v1 manifest, its revision/digest, and separately validated runtime configuration and digest; see [private data loading](docs/private-overlay.md).

## Accounts

| Service | Needed for |
| --- | --- |
| Local Supabase | Demo data, sessions and approval storage |
| Zernio | Optional live social scheduling and metrics |
| Twenty CRM | Optional live funnel data |
| Wise | Optional read-only financial statements |
| Email provider | Optional notification delivery |
| Language-model provider | Optional draft suggestions |

No provider account is required for synthetic provider reads. Unsupported demo operations fail without sending a request. All live operations require your own account configuration and existing approval rules.

## Schema

Production schema remains owned by the website repository. This repository includes a pinned local migration snapshot and its content hashes in supabase/SOURCE-MANIFEST.json. The check:migrations script verifies that local snapshot without access to private historical sources. Public demo migrations and neutral fixtures are not an instruction to reset or replay a production database.

## License

Functional Source License 1.1 with Apache 2.0 future licensing. See LICENSE. Third-party dependencies keep their original licenses.
