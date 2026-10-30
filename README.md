# GTM Cockpit

A Next.js dashboard and command-line toolkit for a small content team. It includes a content calendar, approval queue, engagement review, analytics, and an outreach writing desk.

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

The sample content is synthetic. Replace it with your own material. Ordinary builds and tests use samples. Tests force sample mode regardless of linked private files. A local private mode requires an absolute external root, a v1 manifest, an immutable revision and the manifest digest; see docs/private-overlay.md.

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

Production schema remains owned by the website repository. This export includes the pinned local migration snapshot and its content hashes in supabase/SOURCE-MANIFEST.json. The check:migrations script verifies the local snapshot without access to the private upstream repository. Production migration ownership remains with the website.

## License

Functional Source License 1.1 with Apache 2.0 future licensing. See LICENSE. Third-party dependencies keep their original licenses.
